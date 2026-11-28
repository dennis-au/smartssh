import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judgeMetrics, parseMetrics, SCHEMA } from './metrics.mjs'
import { measurementToCase, writeMetrics } from './metricsWriter.mjs'

const commit = '54869e1'
const build = { version: `1.0.238 · sms.42 · ${commit}`, sha256: 'f'.repeat(64), commit }
// New contract: the declared fallback and live measurement carry explicit provenance.
const narrow = {
  case: '683x512',
  measured: false,
  declared: true,
  devicePixelRatio: 1.5,
  dprSource: 'CASE_SPEC',
  window: { wCss: 683, hCss: 512, dpr: 1.5 },
  dockMode: 'rail',
  theme: 'dark',
  chrome: { titlebar: 0, tabs: 28, statusbar: 0 },
  viewport: { heightPx: 147, rows: 7, cols: 78, cellHeightPx: 21 },
  bar: { state: 'rejected', mounted: true, heightPx: 0 },
  barCollapsed: { afterMs: 8000, heightPx: 0, stillMounted: true, display: 'flex' },
  panes: [{ id: 'only', heightPx: 183, compact: false, barMinHeightPx: 76 }],
  gate: 'clean',
  gateReason: 'clean',
  trust: 'readonly_auto',
  autoRun: 'on',
  barMountedWhenNoProposal: false,
  trustVisible: { where: 'tab', armed: true },
}
const cases = [
  narrow,
  { ...narrow, case: '911x512', window: { wCss: 911, hCss: 512, dpr: 1.5 }, theme: 'light' },
  {
    ...narrow,
    case: '900-high-split',
    measured: true,
    declared: false,
    devicePixelRatio: 1,
    dprSource: 'window.devicePixelRatio',
    window: { wCss: 1280, hCss: 900, dpr: 1 },
    dockMode: 'full',
    chrome: { titlebar: 0, tabs: 38, statusbar: 26 },
    viewport: { heightPx: 380, rows: 18, cols: 150, cellHeightPx: 21 },
    panes: [
      { id: 'top', heightPx: 450, compact: false, barMinHeightPx: 92 },
      { id: 'bottom', heightPx: 300, compact: true, barMinHeightPx: 76 },
    ],
    trustVisible: { where: 'statusbar', armed: true },
  },
]

let total = 0
let fails = 0
function test (name, fn) {
  total++
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    fails++
    console.log(`FAIL  ${name} :: ${error.message}`)
  }
}

test('three cases round-trip and satisfy the judge', () => {
  const text = writeMetrics({ build, cases })
  const parsed = parseMetrics(text)
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.metrics, { schema: SCHEMA, build, cases })
  assert.deepEqual(judgeMetrics(parsed.metrics, { commit, sha256: build.sha256 }).filter(r => r.status !== 'PASS'), [])
  // Persist one real document so the write side is exercised on this host's own temp volume.
  // (/tmp/w.json is a posix-only literal: on Windows it means <current drive>:\tmp\w.json.)
  const dir = mkdtempSync(join(tmpdir(), 'smartssh-metrics-writer-'))
  try {
    writeFileSync(join(dir, 'metrics.json'), text, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('build identity is required before cases are validated', () => {
  for (const invalid of [undefined, { ...build, commit: '' }, { ...build, commit: 42 }]) {
    assert.throws(() => writeMetrics({ build: invalid, cases: [] }), { message: 'build.commit missing' })
  }
  for (const sha256 of ['', undefined, 'g'.repeat(64)]) {
    assert.throws(() => writeMetrics({ build: { ...build, sha256 }, cases: [] }), {
      message: 'build.sha256 must be the exe sha256 (64 hex); an empty sha binds the numbers to no binary',
    })
  }
})
test('partial writes throw and list every missing case', () => {
  assert.throws(() => writeMetrics({ build, cases: cases.slice(0, 2) }),
    { message: 'missing required cases: 900-high-split' })
  assert.throws(() => writeMetrics({ build, cases: [narrow] }),
    { message: 'missing required cases: 911x512, 900-high-split' })
})
test('a complete write preserves the supplied case order', () => {
  const reversed = [...cases].reverse()
  assert.deepEqual(JSON.parse(writeMetrics({ build, cases: reversed })).cases, reversed)
})
test('output contains no literal U+FEFF and preserves decoded data', () => {
  const gateReason = '\uFEFFclean'
  const text = writeMetrics({ build, cases: [{ ...narrow, gateReason }, ...cases.slice(1)] })
  assert.ok(!text.includes('\uFEFF'))
  assert.equal(parseMetrics(text).metrics.cases[0].gateReason, gateReason)
})
test('unknown case id throws', () => {
  assert.throws(() => measurementToCase({ ...narrow, case: 'unknown' }), { message: 'unknown case id: unknown' })
})
test('bad theme throws', () => {
  assert.throws(() => measurementToCase({ ...narrow, theme: 'auto' }), /theme/)
})
test('negative chrome throws', () => {
  assert.throws(() => measurementToCase({ ...narrow, chrome: { ...narrow.chrome, titlebar: -1 } }), /chrome/)
})
test('non-integer rows throw', () => {
  assert.throws(() => measurementToCase({ ...narrow, viewport: { ...narrow.viewport, rows: 7.5 } }), /viewport\.rows/)
})
test('missing trustVisible throws', () => {
  const m = { ...narrow }
  delete m.trustVisible
  assert.throws(() => measurementToCase(m), /trustVisible/)
})
test('a boolean unarmed state requires a gate reason and preserves it when present', () => {
  const trustVisible = { where: 'tab', armed: false, gateReason: 'not_armed' }
  const gateReason = 'not_armed'
  const unarmed = { ...narrow, trust: 'watch', trustVisible, gateReason }
  for (const missingReason of [undefined, '', false]) {
    assert.throws(() => measurementToCase({ ...unarmed, gateReason: missingReason }), {
      message: 'an unarmed case must carry a non-empty gateReason',
    })
  }
  assert.throws(() => measurementToCase({ ...unarmed, trustVisible: { where: 'tab', armed: 'false' } }), /trustVisible/)
  assert.deepEqual(measurementToCase(unarmed), unarmed)
})
test('measured and declared must both be boolean, with exactly one true', () => {
  for (const flags of [
    { measured: true, declared: true }, { measured: false, declared: false },
    { measured: undefined, declared: undefined }, { measured: 1, declared: false },
  ]) {
    assert.throws(() => measurementToCase({ ...narrow, ...flags }), {
      message: 'measured and declared are mutually exclusive and one of them is required',
    })
  }
})
test('both provenance types require a finite positive DPR and an appropriate source', () => {
  for (const devicePixelRatio of [0, -1, Infinity, '1', undefined]) {
    assert.throws(() => measurementToCase({ ...narrow, devicePixelRatio }), /a declared case must carry a positive devicePixelRatio/)
    assert.throws(() => measurementToCase({ ...cases[2], devicePixelRatio }), {
      message: 'a measured case must carry a real devicePixelRatio and dprSource',
    })
  }
  assert.throws(() => measurementToCase({ ...narrow, dprSource: 'window.devicePixelRatio' }), /dprSource CASE_SPEC/)
  for (const dprSource of ['', 'CASE_SPEC', undefined]) {
    assert.throws(() => measurementToCase({ ...cases[2], dprSource }), {
      message: 'a measured case must carry a real devicePixelRatio and dprSource',
    })
  }
})
test('duplicate case ids throw', () => {
  assert.throws(() => writeMetrics({ build, cases: [narrow, { ...narrow }] }), /duplicate case id: 683x512/)
})
test('empty cases array throws', () => {
  assert.throws(() => writeMetrics({ build, cases: [] }), /cases/)
})
test('missing pass-through fields are not defaulted', () => {
  // New contract: provenance and trust visibility are required, unlike these pass-through fields.
  const { theme, chrome, viewport, trustVisible, measured, declared, devicePixelRatio, dprSource } = narrow
  const c = measurementToCase({ case: narrow.case, theme, chrome, viewport, trustVisible, measured, declared, devicePixelRatio, dprSource })
  for (const key of ['dockMode', 'bar', 'barCollapsed', 'panes', 'gate', 'gateReason', 'trust', 'autoRun', 'barMountedWhenNoProposal']) {
    assert.equal(c[key], undefined, key)
  }
})

console.log(`${total - fails}/${total} passed`)
process.exit(fails ? 1 : 0)
