// contract: v56
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAtPrompt } from './gate.mjs'
import { MAX_TOKEN_CHARS, PROMPT_TERMINATORS, promptSample } from './promptSample.mjs'

function rejectsSample (reading, reason) {
  const sample = promptSample(reading)
  assert.ok(sample.token === null, 'a rejected reading must not expose a token')
  assert.equal(sample.reason, reason)
}

function acceptsSample (reading, expected) {
  const sample = promptSample(reading)
  assert.equal(sample.reason, 'ok')
  assert.ok(sample.token === expected, 'sample must preserve exactly the terminator and trailing whitespace')
  return sample.token
}

test('invalid cursor states take precedence in order and require literal true', () => {
  const blocked = { altScreen: true, selection: true, scrolled: true, tail: 'typed' }
  rejectsSample(blocked, 'alt_screen')
  rejectsSample({ ...blocked, altScreen: false }, 'selection')
  rejectsSample({ ...blocked, altScreen: false, selection: false }, 'scrolled')
  acceptsSample({ prefix: '$ ', altScreen: 1, selection: 'true', scrolled: {} }, '$ ')
})

test('missing, empty and non-string prefixes are refused before inspecting the tail', () => {
  rejectsSample(undefined, 'empty_prefix')
  for (const prefix of ['', null, 42]) rejectsSample({ prefix, tail: 'typed' }, 'empty_prefix')
})

test('non-whitespace tail text is refused before checking the terminator', () => {
  rejectsSample({ prefix: 'not a terminator', tail: ' ls ' }, 'typed_input')
  acceptsSample({ prefix: '$ ', tail: ' \t' }, '$ ')
  acceptsSample({ prefix: '$ ', tail: 42 }, '$ ')
})

test('blank prefixes and prefixes without a final terminator are refused', () => {
  for (const prefix of [' \t', 'pwd ', '$ echo ']) rejectsSample({ prefix }, 'no_terminator')
})

test('the suffix limit includes the terminator and all trailing whitespace', () => {
  assert.equal(MAX_TOKEN_CHARS, 8)
  const whitespace = ' \t'.repeat(3) + ' '
  acceptsSample({ prefix: `host:path$${whitespace}` }, `$${whitespace}`)
  rejectsSample({ prefix: `host:path$${whitespace} ` }, 'token_too_long')
  acceptsSample({ prefix: 'host:path$\u00a0' }, '$\u00a0')
})

for (const [shell, prefix, expected] of [
  ['bash', 'hermes@srv:~$ ', '$ '],
  ['zsh', '~ ❯ ', '❯ '],
  ['root', 'root@srv:~# ', '# '],
  ['pwsh', 'PS C:\\Users\\hermes> ', '> '],
  ['cmd', 'C:\\Users\\hermes>', '>'],
]) {
  test(`samples the ${shell} prompt shape`, () => acceptsSample({ prefix }, expected))
}

test('all supported terminators are accepted without a trailing space', () => {
  assert.equal(PROMPT_TERMINATORS.length, 8)
  assert.ok(Object.isFrozen(PROMPT_TERMINATORS))
  for (const expected of ['>', '$', '#', '%', '❯', 'λ', '»', '→']) {
    acceptsSample({ prefix: `prompt${expected}` }, expected)
  }
})

test('cwd, words, CJK characters and emoji preceding the suffix are never sampled', () => {
  for (const prefix of ['hermes@srv:~$ ', 'hermes@srv:/var/log$ ', 'two words ~/漢字$ ', 'dev@host:~/🚀$ ']) {
    const token = acceptsSample({ prefix }, '$ ')
    assert.ok(token.length <= 8, 'sample exceeds the suffix length limit')
    assert.ok(!/[@:/\\]|\S\s+\S/u.test(token), 'sample contains prompt metadata')
  }
})

test('the gate distinguishes the sampled suffix from half-typed input', () => {
  const prefix = 'hermes@srv:~$ '
  const token = acceptsSample({ prefix }, '$ ')
  assert.equal(isAtPrompt({ prefix, token, tokenTrusted: true }).gate, 'clean')
  assert.equal(isAtPrompt({ prefix: `${prefix}echo $`, token, tokenTrusted: true }).gate, 'prompt_dirty')
})

test('a REPL continuation is sampled but the gate refuses it', () => {
  const prefix = '>>> '
  const token = acceptsSample({ prefix }, '> ')
  assert.deepEqual(isAtPrompt({ prefix, token, tokenTrusted: true }), { gate: 'continuation', reason: 'continuation' })
})
