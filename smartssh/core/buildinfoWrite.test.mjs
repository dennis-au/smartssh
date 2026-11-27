// Defence for the release-version contract (see buildinfoWrite.mjs).
// Two halves, both Linux-runnable:
//   1. producer: smartssh-buildinfo.json on disk carries base === the version it was given;
//   2. wiring: .github/workflows/smartssh-win.yml derives SMARTSSH_VERSION from the tag, never
//      hardcodes it, and the buildinfo step still reads the same variable the build script uses.
// If someone re-adds `env: SMARTSSH_VERSION: "x.y.z"` or renames the variable on one side only,
// this file fails and CI never produces a mislabelled exe.
import assert from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBuildInfo, renderBuildInfo, writeBuildInfo, readBuildInfo } from './buildinfoWrite.mjs'

const r = []; const t = (n, f) => { try { f(); r.push(['PASS', n]) } catch (e) { r.push(['FAIL', n + ' :: ' + e.message]) } }

const REPO_ROOT = new URL('../../', import.meta.url).pathname
const WORKFLOW = readFileSync(join(REPO_ROOT, '.github/workflows/smartssh-win.yml'), 'utf8')
const BUILD_SCRIPT = readFileSync(join(REPO_ROOT, 'scripts/build-smartssh.mjs'), 'utf8')

t('base is exactly the version passed in (no drift, no v prefix)', () => {
  for (const version of ['1.0.240', '1.0.239', '2.0.0']) {
    const info = makeBuildInfo({ version, build: 'sms.18', commit: '18afdce' })
    assert.strictEqual(info.base, version)
  }
})

t('a tag name ("v1.0.240") is rejected instead of shipped', () => {
  assert.throws(() => makeBuildInfo({ version: 'v1.0.240', build: 'sms.18', commit: '18afdce' }), /no 'v' prefix/)
  assert.throws(() => makeBuildInfo({ version: '', build: 'sms.18', commit: '18afdce' }))
})

t('written file round-trips: BOM-free, base === version, parses for the About chip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smartssh-buildinfo-'))
  try {
    const { file, info } = writeBuildInfo(dir, { version: '1.0.240', build: 'sms.18', commit: '18afdce', builtAt: '2026-11-27T02:00:00Z' })
    assert.strictEqual(info.base, '1.0.240')
    assert.strictEqual(file, join(dir, 'smartssh-buildinfo.json'))

    const raw = readFileSync(file, 'utf8')
    assert.notStrictEqual(raw.charCodeAt(0), 0xFEFF, 'a BOM makes the app fall back to "dev"')
    assert.deepStrictEqual(readBuildInfo(file), info, 'consumer must parse what the producer wrote')
    assert.strictEqual(JSON.parse(raw).base, '1.0.240')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

t('renderBuildInfo keeps the PowerShell key order and writes no BOM', () => {
  const text = renderBuildInfo({ version: '1.0.240', build: 'sms.18', commit: '18afdce', builtAt: '2026-11-27T02:00:00Z' })
  assert.strictEqual(text, '{"base":"1.0.240","build":"sms.18","commit":"18afdce","builtAt":"2026-11-27T02:00:00Z"}')
  assert.notStrictEqual(text.charCodeAt(0), 0xFEFF)
})

t('workflow has no hardcoded SMARTSSH_VERSION', () => {
  assert.ok(!/^\s+SMARTSSH_VERSION:\s*["']?\d+\.\d+\.\d+/m.test(WORKFLOW), 'hardcoded SMARTSSH_VERSION came back')
})

t('workflow derives the version from the tag and exports it to $GITHUB_ENV', () => {
  assert.ok(/GITHUB_REF_TYPE/.test(WORKFLOW), 'derive step does not branch on GITHUB_REF_TYPE')
  assert.ok(/\$\{GITHUB_REF_NAME#v\}/.test(WORKFLOW), 'derive step does not strip the v prefix from GITHUB_REF_NAME')
  assert.ok(/SMARTSSH_VERSION="?\$V"?\s*>>\s*"?\$GITHUB_ENV/.test(WORKFLOW), 'derive step does not export SMARTSSH_VERSION')
  assert.ok(/SMARTSSH_VERSION_FALLBACK/.test(WORKFLOW), 'non-tag runs lost their fallback')
})

t('buildinfo step reads the same variable the build script reads', () => {
  assert.ok(/base\s*=\s*"\$env:SMARTSSH_VERSION"/.test(WORKFLOW), 'buildinfo step must write base = $env:SMARTSSH_VERSION')
  assert.ok(/process\.env\.SMARTSSH_VERSION/.test(readFileSync(join(REPO_ROOT, 'scripts/vars.mjs'), 'utf8')), 'vars.mjs must keep reading SMARTSSH_VERSION')
})

t('artifact name is driven by that same version', () => {
  assert.ok(/artifactName:\s*"smartssh-\$\{version\}-portable-\$\{arch\}\.\$\{ext\}"/.test(BUILD_SCRIPT), 'artifactName template drifted')
})

for (const [s, n] of r) console.log(`${s}  ${n}`)
const f = r.filter(x => x[0] === 'FAIL').length
console.log(`\n${r.length - f}/${r.length} passed`)
process.exit(f ? 1 : 0)
