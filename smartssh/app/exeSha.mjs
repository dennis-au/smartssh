// Hash the portable outer executable, not Electron's extracted process image.
import { createHash } from 'node:crypto'
import { openSync as openFile, readSync as readFile, closeSync as closeFile } from 'node:fs'

export const EXE_PATH_ENV = 'PORTABLE_EXECUTABLE_FILE'
export const SHA256_RE = /^[0-9a-f]{64}$/i

export function isValidSha256 (v) {
  return SHA256_RE.test(String(v ?? ''))
}

const trimmedPath = value => typeof value === 'string' ? value.trim() : ''

export function resolveExePath (env = process.env, execPath = process.execPath) {
  return trimmedPath(env?.[EXE_PATH_ENV]) || trimmedPath(execPath)
}

export function computeExeSha (exePath, deps = {}) {
  if (!exePath) return ''
  try {
    const { openSync = openFile, readSync = readFile, closeSync = closeFile } = deps
    const fd = openSync(exePath, 'r')
    try {
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      let bytesRead
      while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        hash.update(buffer.subarray(0, bytesRead))
      }
      return hash.digest('hex').toUpperCase()
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

const cachedShaByPath = new Map()

export function readExeSha (env = process.env, execPath = process.execPath, deps = {}) {
  const path = resolveExePath(env, execPath)
  if (!path) return ''
  if (!cachedShaByPath.has(path)) cachedShaByPath.set(path, computeExeSha(path, deps))
  return cachedShaByPath.get(path)
}
