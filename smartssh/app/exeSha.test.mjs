import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EXE_PATH_ENV, isValidSha256, resolveExePath, computeExeSha, readExeSha } from './exeSha.mjs'

const HELLO_SHA = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03'

function tempDir (t) {
  const dir = mkdtempSync(join(tmpdir(), 'smartssh-exe-sha-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('resolveExePath prefers the trimmed portable outer exe and falls back to execPath', () => {
  assert.equal(resolveExePath({ [EXE_PATH_ENV]: '  C:\\outer.exe  ' }, 'C:\\inner.exe'), 'C:\\outer.exe')
  assert.equal(resolveExePath({ [EXE_PATH_ENV]: '  ' }, '  C:\\inner.exe  '), 'C:\\inner.exe')
  assert.equal(resolveExePath({}, '  '), '')
})

test('computeExeSha hashes exactly the file bytes and returns uppercase hex', (t) => {
  const path = join(tempDir(t), 'hello.exe')
  writeFileSync(path, 'hello\n')
  assert.equal(computeExeSha(path), HELLO_SHA.toUpperCase())
  assert.equal(isValidSha256(HELLO_SHA), true)
  assert.equal(isValidSha256(HELLO_SHA.toUpperCase()), true)
  assert.equal(isValidSha256(''), false)
})

test('computeExeSha streams across the 1 MiB buffer boundary', (t) => {
  const path = join(tempDir(t), 'two-chunks.exe')
  const bytes = Buffer.alloc(1024 * 1024 + 7, 0xDA)
  writeFileSync(path, bytes)
  assert.equal(computeExeSha(path), createHash('sha256').update(bytes).digest('hex').toUpperCase())
})

test('missing and unreadable paths return an empty sha; read failures close the file', (t) => {
  assert.equal(computeExeSha(''), '')
  assert.equal(computeExeSha(join(tempDir(t), 'missing.exe')), '')
  const closed = []
  assert.equal(computeExeSha('unreadable.exe', {
    openSync: () => 0,
    readSync: () => { throw new Error('read failed') },
    closeSync: fd => closed.push(fd),
  }), '')
  assert.deepEqual(closed, [0])
})

test('readExeSha memoises per resolved path', (t) => {
  const dir = tempDir(t)
  const a = join(dir, 'a.exe')
  const b = join(dir, 'b.exe')
  writeFileSync(a, 'hello\n')
  writeFileSync(b, 'other\n')
  const opened = []
  const deps = {
    openSync: (path, flags) => {
      opened.push(path)
      return openSync(path, flags)
    },
  }
  assert.equal(readExeSha({ [EXE_PATH_ENV]: ` ${a} ` }, b, deps), HELLO_SHA.toUpperCase())
  assert.equal(readExeSha({}, a, deps), HELLO_SHA.toUpperCase())
  assert.notEqual(readExeSha({}, b, deps), HELLO_SHA.toUpperCase())
  assert.deepEqual(opened, [a, b])
})
