import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_MEASURE_CASE, measurementWindow } from '../app/measureWindow.mjs'
import { buildMeasurement, CASE_SPEC, VIEWPORT_TOLERANCE_CSS } from '../app/proposalService.mjs'
import { CASE_IDS, judgeMetrics, parseMetrics } from '../core/metrics.mjs'
import { measurementToCase, writeMetrics } from '../core/metricsWriter.mjs'

const check = fileURLToPath(new URL('../core/metrics-check.mjs', import.meta.url))
const build = { version: 'test', commit: 'abcd123', sha256: 'a'.repeat(64) }
const narrowId = '683x512'
const splitId = '900-high-split'
const narrowViewport = { wCss: 683, hCss: 512, devicePixelRatio: 1.25, rows: 24, cols: 78, heightPx: 432, cellHeightPx: 18 }
const splitViewport = { wCss: 1280, hCss: 900, devicePixelRatio: 1, rows: 18, cols: 150, heightPx: 380, cellHeightPx: 21 }

let fails = 0
function t (name, fn) {
  try {
    fn()
    console.log('PASS  ' + name)
  } catch (error) {
    fails++
    console.error('FAIL  ' + name, error)
  }
}

function offlineCase (id, reading = {}) {
  return {
    ...buildMeasurement(id, { armed: false, gateReason: 'token_empty', state: 'offline', ...reading }),
    gate: 'prompt_dirty',
    gateReason: 'token_empty',
    trust: 'watch',
    autoRun: 'off',
    barMountedWhenNoProposal: false,
  }
}

function documentWith (liveId, measuredViewport) {
  return writeMetrics({ build, cases: CASE_IDS.map(id => offlineCase(id, id === liveId ? { measuredViewport } : {})) })
}

function runJudge (text) {
  const dir = mkdtempSync(join(tmpdir(), 'smartssh-live-measure-'))
  try {
    const file = join(dir, 'metrics.json')
    writeFileSync(file, text)
    const run = spawnSync(process.execPath, [check, '--metrics', file, '--exe-sha', build.sha256], { encoding: 'utf8' })
    assert.ifError(run.error)
    return run
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

t('a matching runtime viewport supplies all live geometry and provenance', () => {
  const m = buildMeasurement(narrowId, { armed: true, measuredViewport: narrowViewport })
  assert.equal(m.measured, true)
  assert.equal(m.declared, false)
  assert.equal(m.dprSource, 'runtime')
  assert.equal(m.devicePixelRatio, 1.25)
  assert.deepEqual(m.viewport, { rows: 24, cols: 78, heightPx: 432, cellHeightPx: 18 })
  assert.deepEqual(m.window, { wCss: 683, hCss: 512, dpr: 1.25 })
  assert.ok(!Object.hasOwn(m, 'measurementNote'))
})

t('the exact CSS tolerance is inclusive and the actual window is preserved', () => {
  const wCss = narrowViewport.wCss + VIEWPORT_TOLERANCE_CSS
  const m = buildMeasurement(narrowId, { armed: true, measuredViewport: { ...narrowViewport, wCss } })
  assert.equal(m.measured, true)
  assert.equal(m.window.wCss, wCss)
  const beyond = buildMeasurement(narrowId, { armed: true, measuredViewport: { ...narrowViewport, wCss: wCss + 0.01 } })
  assert.equal(beyond.measured, false)
})

t('writeMetrics preserves live provenance and declared notes on round trip', () => {
  const { metrics, error } = parseMetrics(documentWith(narrowId, narrowViewport))
  assert.equal(error, undefined)
  const live = metrics.cases.find(c => c.case === narrowId)
  assert.equal(live.measured, true)
  assert.equal(live.dprSource, 'runtime')
  assert.deepEqual(live.window, { wCss: 683, hCss: 512, dpr: 1.25 })
  assert.ok(!Object.hasOwn(live, 'measurementNote'))
  const declared = metrics.cases.find(c => c.case === splitId)
  assert.equal(declared.measurementNote, 'no runtime viewport was supplied')
  assert.equal(Object.keys(declared).at(-1), 'measurementNote')
  for (const measurementNote of ['', null, 42]) {
    assert.ok(!Object.hasOwn(measurementToCase({ ...declared, measurementNote }), 'measurementNote'))
  }
})

t('the document writer rejects live cases without finite positive window dimensions', () => {
  const live = offlineCase(narrowId, { measuredViewport: narrowViewport })
  for (const window of [undefined, { wCss: 683 }, { wCss: 0, hCss: 512 }, { wCss: 683, hCss: Infinity }]) {
    assert.throws(() => measurementToCase({ ...live, window }), {
      message: 'a measured case must state the real window it was measured in (window.wCss and window.hCss)',
    })
  }
})

const { cols: _cols, ...withoutCols } = narrowViewport
for (const [name, reading, note] of [
  ['no viewport', {}, /no runtime viewport/],
  ['a measured flag alone', { measured: true }, /measured:true alone is not a measurement/],
  ['a wrong window', { measuredViewport: { ...narrowViewport, wCss: 800, hCss: 600 } }, /800x600 is not case/],
  ['zero rows', { measuredViewport: { ...narrowViewport, rows: 0 } }, /incomplete: rows/],
  ['non-finite DPR', { measuredViewport: { ...narrowViewport, devicePixelRatio: NaN } }, /incomplete: devicePixelRatio/],
  ['missing columns', { measuredViewport: withoutCols }, /incomplete: cols/],
]) {
  t(`${name} falls back to declared CASE_SPEC geometry with a reason`, () => {
    const m = buildMeasurement(narrowId, { armed: true, ...reading })
    const spec = CASE_SPEC[narrowId]
    assert.equal(m.measured, false)
    assert.equal(m.declared, true)
    assert.equal(m.dprSource, 'CASE_SPEC')
    assert.equal(m.devicePixelRatio, spec.window.dpr)
    assert.deepEqual(m.window, spec.window)
    assert.deepEqual(m.viewport, spec.viewport)
    assert.match(m.measurementNote, note)
  })
}

t('loose geometry cannot alter a declared case', () => {
  const m = buildMeasurement(narrowId, {
    armed: true, measured: true, devicePixelRatio: 2, dprSource: 'runtime',
    window: { wCss: 800, hCss: 600 }, rows: 24, cols: 80, heightPx: 480, cellHeightPx: 20,
  })
  assert.equal(m.measured, false)
  assert.equal(m.dprSource, 'CASE_SPEC')
  assert.deepEqual(m.window, CASE_SPEC[narrowId].window)
  assert.deepEqual(m.viewport, CASE_SPEC[narrowId].viewport)
})

t('metrics-check exits 2 and names the reason for a declared-only document', () => {
  const run = runJudge(documentWith())
  assert.equal(run.status, 2, run.stdout + run.stderr)
  assert.match(run.stdout, /JUDGE FAIL: at least one case is a live measurement \(measured:true\)  no live measurement/)
  assert.match(run.stdout, /live measurements: 0\/3/)
})

t('metrics-check passes a document with exactly one live case', () => {
  const run = runJudge(documentWith(splitId, splitViewport))
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /live measurements: 1\/3/)
  assert.doesNotMatch(run.stdout, /no live measurement/)
})

t('zero live cases fail the judge even when every declared case is valid', () => {
  const { metrics, error } = parseMetrics(documentWith())
  assert.equal(error, undefined)
  const failures = judgeMetrics(metrics, build).filter(r => r.status === 'FAIL')
  assert.equal(failures.length, 1)
  assert.equal(failures[0].name, 'at least one case is a live measurement (measured:true)')
  assert.match(failures[0].detail, /^no live measurement/)
})

t('measurement mode requests the default or selected content geometry only on opt-in', () => {
  for (const value of [undefined, '0', 'true']) {
    assert.equal(measurementWindow({ SMARTSSH_MEASURE: value, SMARTSSH_MEASURE_CASE: splitId }), null)
  }
  // The switch accepts surrounding whitespace (isMeasureEnabled), so the window must follow suit.
  assert.equal(measurementWindow({ SMARTSSH_MEASURE: ' 1 ' }).caseId, narrowId)
  assert.equal(DEFAULT_MEASURE_CASE, narrowId)
  assert.deepEqual(measurementWindow({ SMARTSSH_MEASURE: '1', SMARTSSH_MEASURE_CASE: '  ' }), {
    caseId: narrowId, width: 683, height: 512, note: '',
  })
  assert.deepEqual(measurementWindow({ SMARTSSH_MEASURE: '1', SMARTSSH_MEASURE_CASE: ` ${splitId} ` }), {
    caseId: splitId, width: 1280, height: 900, note: '',
  })
  assert.deepEqual(measurementWindow({ SMARTSSH_MEASURE: '1', SMARTSSH_MEASURE_CASE: 'toString' }), {
    caseId: 'toString', width: null, height: null,
    note: `SMARTSSH_MEASURE_CASE must be one of ${CASE_IDS.join(', ')}; got toString`,
  })
})

process.exitCode = fails ? 1 : 0
