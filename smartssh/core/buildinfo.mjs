// contract: v53
// buildinfo.mjs — consumer side of extras/smartssh-buildinfo.json.
// Producer (CI) now writes BOM-free, but the consumer must not depend on that: a single
// `Out-File` added later would otherwise make About silently fall back to "dev", which is the
// hardest possible bug to notice. So the BOM is stripped here, and every field is validated:
// anything unexpected yields `null` and the UI shows "dev" — never a plausible-looking fake.

export const BASE_RE = /^\d+\.\d+\.\d+$/
// 'sms.<n>' comes from GitHub run numbers, 'local.<n>' from build-local.ps1 — both are builds,
// 'dev' stays reserved for a checkout with no buildinfo at all (yarn start).
export const BUILD_RE = /^(sms|local)\.\d+$/
export const COMMIT_RE = /^[0-9a-f]{7,40}$|^local$/

export function stripBom (text) {
  if (typeof text !== 'string') return ''
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

/** @returns {{base:string,build:string,commit:string,builtAt?:string}|null} */
export function parseBuildInfo (text) {
  const clean = stripBom(text).trim()
  if (!clean) return null
  let raw
  try { raw = JSON.parse(clean) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const base = typeof raw.base === 'string' ? raw.base.trim() : ''
  const build = typeof raw.build === 'string' ? raw.build.trim() : ''
  const commit = typeof raw.commit === 'string' ? raw.commit.trim().toLowerCase() : ''
  if (!BASE_RE.test(base) || !BUILD_RE.test(build) || !COMMIT_RE.test(commit)) return null
  const out = { base, build, commit }
  if (typeof raw.builtAt === 'string' && raw.builtAt.length <= 40) out.builtAt = raw.builtAt
  return out
}

/** Three-part display string used by the title chip, or 'dev'. */
export function formatVersion (info) {
  if (!info) return 'dev'
  return `${info.base} · ${info.build} · ${info.commit}`
}
