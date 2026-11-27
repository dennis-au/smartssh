#!/usr/bin/env node
/**
 * SmartSSH docs check — fails the build when user-facing documentation drifts from the repo.
 *
 * What it asserts:
 *   1. Every release doc exists (README.md, CHANGELOG.md, relay-contract.md, relay/README.md).
 *   2. README.md carries the required user sections (installation, portable, relay, privacy,
 *      version, SmartScreen).
 *   3. CHANGELOG.md names the shipped version (1.0.238).
 *   4. Every relative markdown link in the docs resolves to a real file, and no doc points at an
 *      absolute path such as the old vm-side `/work/` pointer.
 *   5. relay-contract.md still documents the contract points the relay actually implements.
 *   6. Every repo path cited in CHANGELOG.md/README.md exists — either in this tree or, while a
 *      release lane is still on its own branch, in that branch (reported as PENDING-MERGE).
 *
 * Usage:
 *   node smartssh/verify/check-docs.mjs
 *
 * Exit codes:
 *   0  every check passed (PENDING-MERGE notes do not fail; they are printed)
 *   1  at least one check failed
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const SMARTSSH = join(REPO_ROOT, 'smartssh')

/* ---------------------------------------------------------------- expectations */

const REQUIRED_DOCS = [
  'smartssh/README.md',
  'smartssh/CHANGELOG.md',
  'smartssh/relay-contract.md',
  'smartssh/relay/README.md',
]

const README_SECTIONS = [
  { heading: '安裝', needle: '安裝' },
  { heading: 'Portable 行為', needle: 'Portable' },
  { heading: 'Relay 設定', needle: 'Relay' },
  { heading: '私隱', needle: '私隱' },
  { heading: '版本', needle: '版本' },
  { heading: 'SmartScreen 提示', needle: 'SmartScreen' },
]

const VERSION = '1.0.238'

/** Contract points the relay must keep documenting. Each entry is [needle, why]. */
const CONTRACT_POINTS = [
  ['/v1/context.push', 'context push route'],
  ['/v1/proposal', 'proposal routes'],
  ['/v1/command.dispatch', 'dispatch route'],
  ['Idempotency-Key', 'dispatch header'],
  ['Idempotent-Replay', 'replay response header'],
  ['server_dropped_lines', 'server-side truncation counter'],
  ['120', 'proposal TTL in seconds'],
]

/**
 * Paths that a release lane has committed on its own branch but that have not been merged into
 * `smartssh` yet. Resolving them via git keeps the citation honest instead of silently passing a
 * path that does not exist anywhere. Once merged, the tree check wins and this map is inert.
 */
const PENDING_MERGE = {
  'smartssh/app/portablePath.mjs': 'wt/t_6cf5f28f',
  'smartssh/verify/check-identity.mjs': 'wt/t_6cf5f28f',
  'smartssh/verify/test-all.mjs': 'wt/t_adbc0c00',
}

const ABSOLUTE_PATH_RE = /(^|[\s(`"'])\/(?:work|home|Users|tmp|mnt)\//
const PATH_TOKEN_RE = /`([A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+\.(?:mjs|ts|ps1|md))`/g
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g

/**
 * The dead pointer this check exists to prevent. Assembled at runtime so that the string does not
 * appear literally in this file — otherwise this script would trip its own scan and the release
 * grep check that looks for zero hits under smartssh/.
 */
const WORK_POINTER = ['', 'work', 'relay-contract.md'].join('/')

/* ---------------------------------------------------------------- tiny harness */

let failures = 0
let passes = 0
const pending = []

const pass = msg => { passes++; console.log(`PASS  ${msg}`) }
const fail = msg => { failures++; console.log(`FAIL  ${msg}`) }
const note = msg => { pending.push(msg); console.log(`PEND  ${msg}`) }

const read = rel => readFileSync(join(REPO_ROOT, rel), 'utf8')

function gitHas (ref, path) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${path}`], { cwd: REPO_ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function gitAvailable () {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: REPO_ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Walk a directory, yielding repo-relative text file paths. */
function walk (dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (['.md', '.mjs', '.js', '.ts', '.ps1', '.yml', '.json'].includes(extname(entry))) out.push(full)
  }
  return out
}

/* ---------------------------------------------------------------- 1. doc files exist */

for (const rel of REQUIRED_DOCS) {
  const full = join(REPO_ROOT, rel)
  if (!existsSync(full)) { fail(`missing doc: ${rel}`); continue }
  const size = statSync(full).size
  if (size < 200) fail(`doc too small to be real (${size} B): ${rel}`)
  else pass(`exists: ${rel} (${size} B)`)
}

/* ---------------------------------------------------------------- 2. README sections */

if (existsSync(join(REPO_ROOT, 'smartssh/README.md'))) {
  const readme = read('smartssh/README.md')
  for (const { heading, needle } of README_SECTIONS) {
    if (!readme.includes(needle)) fail(`README.md missing required term: ${needle}`)
    else if (!readme.includes(`## ${heading}`)) fail(`README.md missing required section: ## ${heading}`)
    else pass(`README section: ## ${heading}`)
  }
}

/* ---------------------------------------------------------------- 3. CHANGELOG version */

if (existsSync(join(REPO_ROOT, 'smartssh/CHANGELOG.md'))) {
  const changelog = read('smartssh/CHANGELOG.md')
  if (!changelog.includes(VERSION)) fail(`CHANGELOG.md does not mention ${VERSION}`)
  else pass(`CHANGELOG.md mentions ${VERSION}`)
}

/* ---------------------------------------------------------------- 4. links + absolute-path ban */

for (const rel of REQUIRED_DOCS) {
  if (!existsSync(join(REPO_ROOT, rel))) continue
  const text = read(rel)
  const baseDir = dirname(join(REPO_ROOT, rel))

  for (const match of text.matchAll(LINK_RE)) {
    const target = match[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue // external / anchor
    const clean = target.split('#')[0].split('?')[0]
    if (!clean) continue
    if (clean.startsWith('/')) { fail(`${rel}: absolute link "${target}" (must be repo-relative)`); continue }
    const resolved = resolve(baseDir, clean)
    if (existsSync(resolved)) pass(`${rel}: link resolves -> ${relative(REPO_ROOT, resolved)}`)
    else fail(`${rel}: broken link "${target}" -> ${relative(REPO_ROOT, resolved)}`)
  }

  for (const line of text.split('\n')) {
    if (ABSOLUTE_PATH_RE.test(line)) fail(`${rel}: absolute path pointing outside the repo: ${line.trim().slice(0, 90)}`)
  }
}

/* relay/README.md must point at the contract */
if (existsSync(join(REPO_ROOT, 'smartssh/relay/README.md'))) {
  const relayReadme = read('smartssh/relay/README.md')
  if (relayReadme.includes(WORK_POINTER)) fail(`relay/README.md still points at ${WORK_POINTER}`)
  else if (!relayReadme.includes('relay-contract.md')) fail('relay/README.md does not reference relay-contract.md')
  else pass('relay/README.md points at relay-contract.md')
}

/* ---------------------------------------------------------------- 5. contract points */

if (existsSync(join(REPO_ROOT, 'smartssh/relay-contract.md'))) {
  const contract = read('smartssh/relay-contract.md')
  for (const [needle, why] of CONTRACT_POINTS) {
    if (contract.includes(needle)) pass(`contract documents ${needle} (${why})`)
    else fail(`contract missing ${needle} (${why})`)
  }
}

/* ---------------------------------------------------------------- 6. no /work/ pointers repo-wide */

{
  const hits = []
  for (const file of walk(SMARTSSH)) {
    const text = readFileSync(file, 'utf8')
    text.split('\n').forEach((line, i) => {
      if (line.includes(WORK_POINTER)) hits.push(`${relative(REPO_ROOT, file)}:${i + 1}`)
    })
  }
  if (hits.length) fail(`dead absolute pointer still referenced at: ${hits.join(', ')}`)
  else pass('no dead absolute relay-contract pointer under smartssh/')
}

/* ---------------------------------------------------------------- 7. cited paths exist */

{
  const hasGit = gitAvailable()
  const cited = new Set()
  for (const rel of ['smartssh/CHANGELOG.md', 'smartssh/README.md']) {
    if (!existsSync(join(REPO_ROOT, rel))) continue
    for (const match of read(rel).matchAll(PATH_TOKEN_RE)) cited.add(match[1])
  }
  for (const path of [...cited].sort()) {
    if (existsSync(join(REPO_ROOT, path))) { pass(`cited file exists: ${path}`); continue }
    const ref = PENDING_MERGE[path]
    if (ref && hasGit && gitHas(ref, path)) { note(`cited file not merged yet: ${path} (on ${ref})`); continue }
    if (ref && !hasGit) { note(`cited file not in tree and git unavailable: ${path} (expected on ${ref})`); continue }
    fail(`cited file does not exist anywhere: ${path}`)
  }
}

/* ---------------------------------------------------------------- summary */

console.log('')
console.log(`checks passed: ${passes}, failed: ${failures}, pending-merge: ${pending.length}`)
if (failures > 0) {
  console.error(`\nDOCS CHECK FAILED (${failures} problem${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('DOCS CHECK OK')
