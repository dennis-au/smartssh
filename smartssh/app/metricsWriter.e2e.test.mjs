// smartssh/app/metricsWriter.e2e.test.mjs — end to end: writer output -> metrics-check judgement.
//
// `metricsWriter.test.mjs` proves the document's shape; test U proves the service can produce one.
// Neither ever ran the judge the Windows gate runs, so "the writer hands over a file that PASSES"
// was an assumption. This test is that assumption made executable: write the three cases, spawn
// `smartssh/core/metrics-check.mjs` on the file, and require exit 0 with `0 fail / 0 skipped`.
// The reverse case (one armed flag flipped to false without a gate reason) must make the same
// judge exit non-zero, or this test would be a rubber stamp.
//
// Run: node smartssh/app/metricsWriter.e2e.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CASE_IDS, judgeMetrics, parseMetrics, summarise } from '../core/metrics.mjs'
import { writeMetrics } from '../core/metricsWriter.mjs'
import { buildInfoPaths, buildMeasurement, CASE_SPEC, readBuildInfo } from './proposalService.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const CHECK = join(REPO_ROOT, 'smartssh', 'core', 'metrics-check.mjs')

// The build identity the exe under test would carry; the judge compares it against buildinfo.
const commit = 'b5c1be7'
const build = { version: `1.0.238 · local.1 · ${commit}`, sha256: 'a'.repeat(64), commit }
const BUILDINFO = { base: '1.0.238', build: 'local.1', commit, builtAt: 'e2e' }

let total = 0
let fails = 0
function test (name, fn) {
  total++
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    fails++
    console.log(`FAIL  ${name}`)
    console.log(`      ${error && error.message ? error.message : error}`)
  }
}

/** One live-shaped fixture and two declared fallbacks: only one window can be measured per run. */
function measurementFor (id, state = 'rejected') {
  // A live case needs a complete runtime viewport matching the case, not a measured flag.
  const measuredViewport = id === '900-high-split'
    ? { wCss: 1280, hCss: 900, devicePixelRatio: 1, rows: 18, cols: 150, heightPx: 380, cellHeightPx: 21 }
    : undefined
  return {
    ...buildMeasurement(id, {
      state,
      armed: true,
      gateReason: 'clean',
      measuredViewport,
    }),
    gate: 'clean',
    gateReason: 'clean',
    trust: 'propose',
    autoRun: 'off',
    barMountedWhenNoProposal: false,
  }
}

function measurements () {
  return CASE_IDS.map(id => measurementFor(id))
}

function runJudge (metricsFile, buildinfoFile, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [CHECK, '--metrics', metricsFile, '--buildinfo', buildinfoFile, '--exe-sha', build.sha256], {
    cwd,
    encoding: 'utf8',
  })
}

const dir = mkdtempSync(join(tmpdir(), 'smartssh-metrics-e2e-'))
const metricsFile = join(dir, 'metrics.json')
const buildinfoFile = join(dir, 'smartssh-buildinfo.json')
writeFileSync(buildinfoFile, JSON.stringify(BUILDINFO), 'utf8')

try {
  test('writer emits the three required cases from the real case spec', () => {
    const text = writeMetrics({ build, cases: measurements() })
    writeFileSync(metricsFile, text, 'utf8')
    const parsed = parseMetrics(readFileSync(metricsFile, 'utf8'))
    assert.equal(parsed.error, undefined, `parse: ${parsed.error}`)
    assert.deepEqual(parsed.metrics.cases.map(c => c.case).sort(), [...CASE_IDS].sort())
    for (const c of parsed.metrics.cases) {
      assert.equal(c.trustVisible.armed, true, `${c.case} trustVisible.armed`)
      assert.equal(c.bar.state, 'rejected')
      assert.equal(c.measured, c.case === '900-high-split')
      assert.equal(c.declared, !c.measured)
      assert.equal(c.devicePixelRatio, CASE_SPEC[c.case].window.dpr)
      assert.equal(c.dprSource, c.measured ? 'runtime' : 'CASE_SPEC')
    }
  })

  test('metrics-check judges that file PASS with 0 fail / 0 skipped (exit 0)', () => {
    const run = runJudge(metricsFile, buildinfoFile)
    console.log(`      exit=${run.status} ${JSON.stringify((run.stdout ?? '').trim().split('\n').pop())}`)
    assert.equal(run.status, 0, `exit=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
    assert.match(run.stdout, /0 fail \/ 0 skipped/)
    assert.match(run.stdout, /live measurements: 1\/3/)
    for (const id of CASE_IDS) assert.match(run.stdout, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  test('a skipped build-identity check would be visible (guard against "0 skipped" by accident)', () => {
    const parsed = parseMetrics(readFileSync(metricsFile, 'utf8'))
    const summary = summarise(judgeMetrics(parsed.metrics, { commit, sha256: build.sha256 }))
    assert.equal(summary.fail, 0)
    assert.equal(summary.skip, 0)
    assert.ok(summary.pass > 0, 'the judge must actually judge something')
  })

  // ------------------------------------------------------------ reverse direction
  const good = readFileSync(metricsFile, 'utf8')

  // An unarmed flag is now valid only with inactive trust and a gate reason.
  test('reverse: armed=false without an explanation makes metrics-check exit non-zero', () => {
    const doc = JSON.parse(good)
    const target = doc.cases.find(c => c.case === '911x512') ?? doc.cases[0]
    target.trust = 'watch'
    target.trustVisible.armed = false
    delete target.trustVisible.gateReason
    delete target.gateReason
    writeFileSync(metricsFile, JSON.stringify(doc), 'utf8')

    const run = runJudge(metricsFile, buildinfoFile)
    console.log(`      exit=${run.status} ${JSON.stringify((run.stdout ?? '').trim().split('\n').pop())}`)
    assert.equal(run.status, 2, `judge did not reject unexplained armed=false\nstdout:\n${run.stdout}`)
    assert.match(run.stdout, /FAIL[^\n]*armed/)
  })

  test('reverse: restoring the untouched writer output returns exit 0', () => {
    writeFileSync(metricsFile, good, 'utf8')
    const run = runJudge(metricsFile, buildinfoFile)
    console.log(`      exit=${run.status} ${JSON.stringify((run.stdout ?? '').trim().split('\n').pop())}`)
    assert.equal(run.status, 0, `restored file rejected\nstdout:\n${run.stdout}`)
    assert.match(run.stdout, /0 fail \/ 0 skipped/)
  })

  test('the judge runs from any cwd (the file path is explicit, not cwd-relative)', () => {
    const run = runJudge(metricsFile, buildinfoFile, tmpdir())
    assert.equal(run.status, 0, `exit=${run.status} from cwd=${tmpdir()}\nstdout:\n${run.stdout}`)
  })

  // The identity the judge compares against has to be found next to the exe, not in cwd: a
  // packaged build keeps it at <exe dir>\resources\extras\smartssh-buildinfo.json.
  test('build identity is looked up next to the exe (resources/extras), exe dir first', () => {
    const portable = join(dir, 'portable')
    const extraDir = join(portable, 'resources', 'extras')
    mkdirSync(extraDir, { recursive: true })
    writeFileSync(join(extraDir, 'smartssh-buildinfo.json'), JSON.stringify(BUILDINFO), 'utf8')

    const env = { PORTABLE_EXECUTABLE_DIR: portable }
    const paths = buildInfoPaths(env)
    assert.equal(paths[0], join(extraDir, 'smartssh-buildinfo.json'))
    // Build identity now includes a real SHA. Inject it rather than binding to this test runner.
    const identity = readBuildInfo(paths, { exeSha: 'a'.repeat(64) })
    assert.ok(identity, 'identity next to the exe was not found')
    assert.equal(identity.commit, commit)
    assert.equal(identity.sha256, 'a'.repeat(64))
    assert.equal(identity.version, `1.0.238 · local.1 · ${commit}`)

    // ...and the writer's document then matches the buildinfo the checklist passes to the judge.
    writeFileSync(metricsFile, writeMetrics({ build: identity, cases: measurements() }), 'utf8')
    const run = runJudge(metricsFile, join(extraDir, 'smartssh-buildinfo.json'))
    console.log(`      exit=${run.status} ${JSON.stringify((run.stdout ?? '').trim().split('\n').pop())}`)
    assert.equal(run.status, 0, `exe-rooted identity rejected\nstdout:\n${run.stdout}`)
    assert.match(run.stdout, /0 fail \/ 0 skipped/)
  })

  test('build identity uses a stored sha first, computes a real portable sha as fallback, and rejects unknown sha', () => {
    const withSha = join(dir, 'buildinfo-with-sha.json')
    writeFileSync(withSha, JSON.stringify({ ...BUILDINFO, sha256: 'f'.repeat(64) }), 'utf8')
    assert.equal(readBuildInfo([withSha], { exeSha: build.sha256 }).sha256, 'f'.repeat(64))

    const portableExe = join(dir, 'outer.exe')
    writeFileSync(portableExe, 'hello\n', 'utf8')
    const deps = { env: { PORTABLE_EXECUTABLE_FILE: portableExe }, execPath: join(dir, 'missing.exe') }
    assert.equal(readBuildInfo([buildinfoFile], deps).sha256, '5891B5B522D5DF086D0FF0B110FBD9D21BB4FC7163AF34D08286A2E846F6BE03')
    assert.equal(readBuildInfo([buildinfoFile], { computeExeSha: () => 'f'.repeat(64) }).sha256, 'F'.repeat(64))
    assert.equal(readBuildInfo([buildinfoFile, withSha], { computeExeSha: () => '' }), null)
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`${total - fails}/${total} passed`)
process.exit(fails ? 1 : 0)
