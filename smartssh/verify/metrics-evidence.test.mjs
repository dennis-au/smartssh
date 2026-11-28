// Service -> metrics.json -> Windows checklist judge. Exercise both honest and altered evidence.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProposalService } from '../app/proposalService.mjs'
import { CASE_IDS, countLive, judgeMetrics, parseMetrics } from '../core/metrics.mjs'
import { writeMetrics } from '../core/metricsWriter.mjs'

const check = fileURLToPath(new URL('../core/metrics-check.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'smartssh-evidence-'))
const metricsPath = join(dir, 'metrics.json')
const build = { version: 'test', commit: 'abcd123', sha256: 'f'.repeat(64) }
const liveId = '900-high-split'

function flush (token, trust) {
  const svc = createProposalService({
    build, token, trust, metrics: true, metricsPath, intervalMs: 0,
    buffer: { rows: 1, cursorX: 3, getLine: () => ({ translateToString: () => 'tok' }) },
    // Only the case with a complete matching runtime viewport counts as live.
    measurement: id => id !== liveId ? {} : {
      measuredViewport: { wCss: 1280, hCss: 900, devicePixelRatio: 1, rows: 20, cols: 80, cellHeightPx: 18, heightPx: 360 },
    },
  })
  svc.tick()
  svc.flushMetrics()
  const parsed = parseMetrics(readFileSync(metricsPath, 'utf8'))
  assert.equal(parsed.error, undefined)
  return parsed.metrics
}

function assertLine (doc, name, status, expected = build) {
  const result = judgeMetrics(doc, expected).find(r => r.name === name)
  assert.equal(result?.status, status, `${name}: ${result?.detail}`)
}

function runJudge (doc, ...args) {
  writeFileSync(metricsPath, JSON.stringify(doc))
  const run = spawnSync(process.execPath, [check, '--metrics', metricsPath, ...args], { encoding: 'utf8' })
  assert.ifError(run.error)
  return run
}

try {
  const doc = flush()
  assert.deepEqual(doc.cases.map(c => c.case).sort(), [...CASE_IDS].sort())
  for (const c of doc.cases) {
    assert.equal(c.trustVisible.armed, false)
    assert.equal(c.gateReason, 'token_empty')
    assertLine(doc, `${c.case} armed flag is derived from the live trust level`, 'PASS')
    const live = c.case === liveId
    assert.deepEqual([c.measured, c.declared, c.devicePixelRatio, c.dprSource],
      [live, !live, live ? 1 : 1.5, live ? 'runtime' : 'CASE_SPEC'])
  }
  const judged = judgeMetrics(doc, build)
  assert.deepEqual(judged.filter(r => r.status !== 'PASS'), [])
  assert.equal(countLive(doc), 1)
  assert.match(judged.find(r => r.name === 'live measurements are counted from measured:true only').detail, /1 live \/ 2 declared/)
  const good = runJudge(doc, '--exe-sha', build.sha256)
  assert.equal(good.status, 0, good.stdout + good.stderr)
  assert.match(good.stdout, /^live measurements: 1\/3 \(measured:true only; declared cases excluded\)$/m)
  console.log('PASS  one live window, two declared cases, no fabricated armed state')

  assert.equal(doc.build.sha256, build.sha256)
  const noSha = { ...build, sha256: '' }
  assert.throws(() => writeMetrics({ build: noSha, cases: doc.cases }), /build\.sha256/)
  const invalid = runJudge({ ...doc, build: noSha })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /build\.sha256/)
  const binding = 'metrics build.sha256 matches the exe under test'
  assertLine(doc, binding, 'FAIL', { ...build, sha256: 'a'.repeat(64) })
  assertLine(doc, binding, 'PASS', { ...build, sha256: build.sha256.toUpperCase() })
  assert.equal(runJudge(doc, '--exe-sha', 'bad').status, 1)
  const exe = join(dir, 'fixture.exe')
  assert.equal(runJudge(doc, '--exe', exe).status, 1)
  writeFileSync(exe, 'hello\n')
  assert.equal(runJudge(doc, '--exe', exe).status, 2)
  const sha256 = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03'
  const matchingExe = { ...doc, build: { ...build, sha256 } }
  assert.equal(runJudge(matchingExe, '--exe', exe).status, 0)
  assert.equal(runJudge(matchingExe, '--exe', exe, '--exe-sha', build.sha256).status, 1)
  console.log('PASS  binary identity survives writing; absent, invalid and mismatched hashes fail')

  const forged = structuredClone(doc)
  forged.cases[0].trustVisible.armed = true
  const derived = `${forged.cases[0].case} armed flag is derived from the live trust level`
  assertLine(forged, derived, 'FAIL')
  const reverse = runJudge(forged, '--exe-sha', build.sha256)
  assert.equal(reverse.status, 2, reverse.stdout + reverse.stderr)
  assert.match(reverse.stdout, /^FAIL\s+\S+ armed flag is derived from the live trust level/m)
  for (const c of flush('tok').cases) assert.equal(c.trustVisible.armed, true)
  // Never rewrite an explicit trust level to make the judge agree with the token.
  const inconsistent = flush('tok', 'watch')
  assert.equal(inconsistent.cases[0].trust, 'watch')
  assertLine(inconsistent, derived, 'FAIL')
  console.log('PASS  trusted token arms the case; flipping the unarmed flag fails the judge')

  const broken = structuredClone(doc)
  const live = broken.cases.find(c => c.case === liveId)
  delete live.measured
  delete live.declared
  const xor = `${liveId} geometry source is stated exactly once (measured xor declared)`
  assertLine(broken, xor, 'FAIL')
  live.measured = live.declared = true
  assertLine(broken, xor, 'FAIL')
  live.declared = false
  delete live.devicePixelRatio
  assertLine(broken, `${liveId} live case carries real devicePixelRatio provenance`, 'FAIL')
  console.log('PASS  missing, conflicting and incomplete provenance fail the judge')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
