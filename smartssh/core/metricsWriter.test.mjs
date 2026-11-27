import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judgeMetrics, parseMetrics, SCHEMA } from './metrics.mjs'
import { measurementToCase, writeMetrics } from './metricsWriter.mjs'

const commit = '54869e1'
const build = { version: `1.0.238 · sms.42 · ${commit}`, sha256: 'a'.repeat(64), commit }
const narrow = {
  case: '683x512',
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
  assert.deepEqual(judgeMetrics(parsed.metrics, { commit }).filter(r => r.status === 'FAIL'), [])
  // Persist one real document so the write side is exercised on this host's own temp volume.
  // (/tmp/w.json is a posix-only literal: on Windows it means <current drive>:\tmp\w.json.)
  const dir = mkdtempSync(join(tmpdir(), 'smartssh-metrics-writer-'))
  try {
    writeFileSync(join(dir, 'metrics.json'), text, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
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
test('duplicate case ids throw', () => {
  assert.throws(() => writeMetrics({ build, cases: [narrow, { ...narrow }] }), /duplicate case id: 683x512/)
})
test('empty cases array throws', () => {
  assert.throws(() => writeMetrics({ build, cases: [] }), /cases/)
})
test('missing pass-through fields are not defaulted', () => {
  const { theme, chrome, viewport, trustVisible } = narrow
  const c = measurementToCase({ case: narrow.case, theme, chrome, viewport, trustVisible })
  for (const key of ['dockMode', 'bar', 'barCollapsed', 'panes', 'gate', 'gateReason', 'trust', 'autoRun', 'barMountedWhenNoProposal']) {
    assert.equal(c[key], undefined, key)
  }
})

console.log(`${total - fails}/${total} passed`)
process.exit(fails ? 1 : 0)
