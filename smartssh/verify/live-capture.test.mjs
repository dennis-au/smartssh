// smartssh/verify/live-capture.test.mjs — the writer must capture the real viewport while the tab
// is alive, with no proposal at all, and teardown must never rewrite what it already measured.
//
// The shipped defect: `recordMeasurement` lived behind `if (metricsEnabled && model)` inside
// publish(), and publish() only ran from emit() with a non-null state; an acceptance run has no
// relay token, so state stayed null and nothing was ever measured. The only flush was in stop(),
// reached from `destroy()` *after* `frontend.destroy()` + `frontend = undefined`, so the host
// handed back `{}` and every case was written as a declared CASE_SPEC value ("no runtime viewport
// was supplied") even though the window was exactly case 683x512.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createProposalService } from '../app/proposalService.mjs'
import { CASE_IDS, countLive, judgeMetrics, parseMetrics } from '../core/metrics.mjs'

const check = fileURLToPath(new URL('../core/metrics-check.mjs', import.meta.url))
const build = { version: 'test', commit: 'abcd123', sha256: 'c'.repeat(64) }
const narrowId = '683x512'
const splitId = '900-high-split'
// What CDP read from the live renderer during the failing acceptance run:
// innerW:683 innerH:512 dpr:1, xterm root present, .terminal rect 653x442.
const liveNarrow = { wCss: 683, hCss: 512, devicePixelRatio: 1, rows: 21, cols: 78, heightPx: 442, cellHeightPx: 442 / 21 }
const liveSplit = { wCss: 1280, hCss: 900, devicePixelRatio: 1, rows: 18, cols: 150, heightPx: 380, cellHeightPx: 21 }

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

/** A buffer that is not at a clean prompt: the gate must not be what wakes the capture. */
function stubBuffer () {
  return {
    rows: 1, cols: 80, cursorX: 3, baseY: 0, viewportY: 0,
    altScreen: false, selection: false,
    getLine: () => ({ translateToString: () => 'tok' }),
  }
}

function fakeClock (start = 1_000_000) {
  let t = start
  return { now: () => t, advance (ms) { t += ms; return t } }
}

function tmp () {
  return mkdtempSync(join(tmpdir(), 'smartssh-live-capture-'))
}

function read (file) {
  const parsed = parseMetrics(readFileSync(file, 'utf8'))
  assert.equal(parsed.error, undefined, `metrics.json invalid: ${parsed.error}`)
  return parsed.metrics
}

t('no proposal, no token: real geometry is on disk before stop()', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'data', 'metrics.json')
    const svc = createProposalService({
      buffer: stubBuffer,
      intervalMs: 0,
      schedule: false,
      metrics: true,
      metricsPath: file,
      build,
      measurement: (id) => (id === narrowId ? { measuredViewport: liveNarrow } : {}),
    })
    for (let i = 0; i < 3; i++) svc.tick()

    // Nothing about this run looks like a proposal: that is the point.
    assert.equal(svc.state(), null)
    assert.equal(svc.armed(), false)
    assert.equal(svc.model(), null)

    // The file must already exist while the tab is alive — before any stop()/teardown.
    assert.ok(existsSync(file), 'metrics.json must be written while the terminal is still alive')
    const doc = read(file)
    assert.equal(doc.cases.length, CASE_IDS.length)
    const live = doc.cases.find(c => c.case === narrowId)
    assert.equal(live.measured, true, 'the matching runtime window is a live measurement')
    assert.equal(live.declared, false)
    assert.equal(live.dprSource, 'runtime')
    assert.deepEqual(live.window, { wCss: 683, hCss: 512, dpr: 1 })
    assert.deepEqual(live.viewport, { heightPx: 442, rows: 21, cols: 78, cellHeightPx: 442 / 21 })
    assert.ok(!Object.hasOwn(live, 'measurementNote'))
    assert.equal(countLive(doc), 1)

    // And the shipped judge, run on the produced file exactly as CI runs it.
    const judge = spawnSync(process.execPath, [check, '--metrics', file, '--exe-sha', build.sha256], { encoding: 'utf8' })
    assert.equal(judge.status, 0, judge.stdout + judge.stderr)
    assert.match(judge.stdout, /live measurements: 1\/3/)
    assert.doesNotMatch(judge.stdout, /no live measurement/)

    svc.stop()
    const afterStop = read(file)
    assert.equal(countLive(afterStop), 1, 'stop() must re-flush the capture, not lose it')
    assert.equal(afterStop.cases.find(c => c.case === narrowId).measured, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

t('a torn-down component cannot rewrite measured:true back to declared', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'data', 'metrics.json')
    // `degraded` models the real teardown order: the frontend is destroyed before the service is
    // stopped, so the host keeps answering `{}` from then on.
    let degraded = false
    const svc = createProposalService({
      buffer: stubBuffer,
      intervalMs: 0,
      schedule: false,
      metrics: true,
      metricsPath: file,
      build,
      measurement: (id) => (degraded ? {} : (id === narrowId ? { measuredViewport: liveNarrow } : {})),
    })
    svc.tick()
    svc.tick()
    assert.equal(countLive(read(file)), 1, 'the live reading was captured while alive')

    degraded = true
    svc.tick()
    svc.tick()
    // The on-disk capture must not regress even before stop().
    assert.equal(countLive(read(file)), 1, 'an empty reading must not un-measure a captured case')

    svc.stop()
    const doc = read(file)
    assert.equal(countLive(doc), 1, 'stop() uses the cache; a dead component cannot flip it to declared')
    const live = doc.cases.find(c => c.case === narrowId)
    assert.equal(live.measured, true)
    assert.equal(live.dprSource, 'runtime')
    assert.deepEqual(live.window, { wCss: 683, hCss: 512, dpr: 1 })
    assert.ok(!Object.hasOwn(live, 'measurementNote'))
    assert.equal(judgeMetrics(doc, build).filter(r => r.status !== 'PASS').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

t('the capture survives a resize and accumulates evidence instead of replacing it', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'data', 'metrics.json')
    let reads = 0
    let caseId = narrowId
    const viewport = { [narrowId]: liveNarrow, [splitId]: liveSplit }
    const svc = createProposalService({
      buffer: stubBuffer,
      intervalMs: 0,
      schedule: false,
      metrics: true,
      metricsPath: file,
      build,
      measurement: (id) => { reads++; return id === caseId ? { measuredViewport: viewport[id] } : {} },
    })
    svc.tick()
    assert.equal(countLive(read(file)), 1)

    // The user drags the window to the split geometry: the old reading is still real.
    caseId = splitId
    svc.tick()
    const doc = read(file)
    assert.equal(countLive(doc), 2, 'both real windows are recorded')
    assert.equal(doc.cases.find(c => c.case === narrowId).measured, true)
    assert.equal(doc.cases.find(c => c.case === splitId).measured, true)
    assert.equal(doc.cases.find(c => c.case === '911x512').measured, false)
    assert.ok(reads >= CASE_IDS.length * 2)
    svc.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

t('capture runs every poll but disk is written only when the evidence changes or a second passes', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'data', 'metrics.json')
    const clock = fakeClock()
    let writes = 0
    const svc = createProposalService({
      buffer: stubBuffer,
      clock,
      intervalMs: 0,
      schedule: false,
      metrics: true,
      metricsPath: file,
      build,
      writeFile: (_path, text) => { writes++; void text },
      measurement: (id) => (id === narrowId ? { measuredViewport: liveNarrow } : {}),
    })
    svc.tick()
    assert.equal(writes, 1, 'the first capture is persisted immediately')
    for (let i = 0; i < 10; i++) { clock.advance(16); svc.tick() }
    assert.equal(writes, 1, 'unchanged evidence is not rewritten every 120ms tick')
    clock.advance(1001)
    svc.tick()
    assert.equal(writes, 2, 'a stale on-disk capture is refreshed after metricsWriteMs')
    assert.ok(existsSync(file) === false, 'this run injected writeFile; nothing hit the disk')
    svc.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

process.exitCode = fails ? 1 : 0
