// contract: v53
// buildinfoWrite.mjs — producer side of extras/smartssh-buildinfo.json.
//
// The CI step writes this file with PowerShell (BOM-free, see the workflow comment there); this
// module is the same contract expressed in JS so a Linux test can prove the one thing that matters:
// `base` IS the version the build was told to ship (SMARTSSH_VERSION, derived from the tag), so a
// v1.0.240 tag can never label an exe that was built as 1.0.238.
//
// Validated with the same regexes the consumer uses (buildinfo.mjs), so a producer that would make
// the About chip fall back to "dev" fails loudly here instead of silently shipping.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE_RE, BUILD_RE, COMMIT_RE, SHA256_RE, parseBuildInfo } from './buildinfo.mjs'

export const BUILDINFO_FILE = 'smartssh-buildinfo.json'

/** @returns {{base:string,build:string,commit:string,builtAt?:string,sha256?:string}} */
export function makeBuildInfo ({ version, build, commit, builtAt, sha256 } = {}) {
  const base = String(version ?? '').trim()
  // A 'v' prefix means a tag name leaked through instead of the stripped version: reject it rather
  // than let the app fall back to "dev" on a real release.
  if (!BASE_RE.test(base)) throw new Error(`version must be x.y.z with no 'v' prefix: ${JSON.stringify(base)}`)
  const b = String(build ?? '').trim()
  if (!BUILD_RE.test(b)) throw new Error(`build must be sms.<n> or local.<n>: ${JSON.stringify(b)}`)
  const c = String(commit ?? '').trim().toLowerCase()
  if (!COMMIT_RE.test(c)) throw new Error(`commit must be 7..40 hex or 'local': ${JSON.stringify(c)}`)
  const out = { base, build: b, commit: c }
  if (typeof builtAt === 'string' && builtAt.length <= 40) out.builtAt = builtAt
  if (sha256 !== undefined) {
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) throw new Error('sha256 must be 64 hex')
    out.sha256 = sha256
  }
  return out
}

/** Bytes identical in shape to the PowerShell producer: UTF-8, no BOM, same key order. */
export function renderBuildInfo (fields) {
  return JSON.stringify(makeBuildInfo(fields))
}

/** Write <dir>/smartssh-buildinfo.json and return the path plus the object that was written. */
export function writeBuildInfo (dir, fields) {
  const info = makeBuildInfo(fields)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, BUILDINFO_FILE)
  writeFileSync(file, JSON.stringify(info), 'utf8') // node writes UTF-8 without BOM
  return { file, info }
}

/** Read it back the way the app does (BOM-tolerant, field-validated). */
export function readBuildInfo (file) {
  return parseBuildInfo(readFileSync(file, 'utf8'))
}
