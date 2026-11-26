import assert from 'node:assert'
import { parseMetrics, judgeMetrics, summarise, SCHEMA } from './metrics.mjs'

const r = []; const t = (n, f) => { try { f(); r.push(['PASS', n]) } catch (e) { r.push(['FAIL', n + ' :: ' + e.message]) } }
const BOM = '\uFEFF'

const okCase = (id, over = {}) => ({
  case: id,
  window: { wCss: 683, hCss: 512, dpr: 1.5 },
  dockMode: 'rail',
  theme: 'dark',
  chrome: { titlebar: 0, tabs: 28, statusbar: 0 },
  viewport: { heightPx: 147, rows: 7, cols: 78, cellHeightPx: 21 },
  bar: { state: 'idle', mounted: false, heightPx: 0 },
  panes: [{ id: 'only', heightPx: 183, compact: false, barMinHeightPx: 76 }],
  gate: 'clean',
  gateReason: 'clean',
  trust: 'readonly_auto',
  autoRun: 'on',
  barMountedWhenNoProposal: false,
  trustVisible: { where: 'tab', armed: true },
  ...over,
})

const good = {
  schema: SCHEMA,
  build: { version: '1.0.238 · sms.42 · 54869e1', sha256: 'a'.repeat(64), commit: '54869e1' },
  cases: [okCase('683x512'), okCase('911x512', { window: { wCss: 911, hCss: 512, dpr: 1.5 } }), okCase('900-high-split', {
    window: { wCss: 1280, hCss: 900, dpr: 1 },
    dockMode: 'full',
    chrome: { titlebar: 0, tabs: 38, statusbar: 26 },
    viewport: { heightPx: 380, rows: 18, cols: 150, cellHeightPx: 21 },
    panes: [
      { id: 'top', heightPx: 450, compact: false, barMinHeightPx: 92 },
      { id: 'bottom', heightPx: 300, compact: true, barMinHeightPx: 76 },
    ],
    trustVisible: { where: 'statusbar', armed: true },
  })],
}
const judge = (m, b) => judgeMetrics(typeof m === 'string' ? parseMetrics(m).metrics : m, b)
const fails = (m, b) => judge(m, b).filter(x => x.status === 'FAIL')
const buildInfo = { commit: '54869e1' }

t('schema: good file parses and every rule passes', () => {
  const p = parseMetrics(JSON.stringify(good))
  assert.ok(p.metrics, p.error)
  assert.deepStrictEqual(fails(p.metrics, buildInfo), [])
  const s = summarise(judgeMetrics(p.metrics, buildInfo))
  assert.ok(s.pass > 10 && s.fail === 0, JSON.stringify(s))
})
t('BOM-prefixed metrics parse identically', () =>
  assert.deepStrictEqual(parseMetrics(BOM + JSON.stringify(good)).metrics, good))
t('schema drift fails loudly, not silently', () => {
  assert.strictEqual(parseMetrics(JSON.stringify({ ...good, schema: 2 })).error.includes('schema'), true)
  assert.strictEqual(parseMetrics(JSON.stringify({ ...good, schema: undefined })).error.includes('schema'), true)
})
t('build.commit mismatch is a FAIL (A build numbers cannot sign B exe)', () =>
  assert.ok(fails(good, { commit: 'deadbee' }).some(f => f.name.includes('build.commit'))))
t('rows come from the terminal, not from height/cellHeight', () => {
  const bad = JSON.parse(JSON.stringify(good)); bad.cases[0].viewport.rows = 4
  assert.ok(fails(bad, buildInfo).some(f => f.name.includes('683x512 rows')))
})
t('statusbar hidden + armed state invisible => FAIL', () => {
  const bad = JSON.parse(JSON.stringify(good)); delete bad.cases[0].trustVisible
  assert.ok(fails(bad, buildInfo).some(f => f.name.includes('armed state visible')))
})
t('collapsed bar that was unmounted or display:none => FAIL', () => {
  const bad = JSON.parse(JSON.stringify(good))
  bad.cases[0].bar = { state: 'rejected', mounted: true, heightPx: 0 }
  bad.cases[0].barCollapsed = { afterMs: 8000, heightPx: 0, stillMounted: false, display: 'none' }
  const f = fails(bad, buildInfo).map(x => x.name).join('|')
  assert.ok(f.includes('still mounted'), f)
})
t('collapsed missing entirely => FAIL', () => {
  const bad = JSON.parse(JSON.stringify(good))
  bad.cases[0].bar = { state: 'expired', mounted: true, heightPx: 0 }
  assert.ok(fails(bad, buildInfo).some(x => x.name.includes('collapsed')))
})
t('@media hitting both panes => FAIL (exactly one compact)', () => {
  const bad = JSON.parse(JSON.stringify(good)); bad.cases[2].panes.forEach(p => { p.compact = true })
  assert.ok(fails(bad, buildInfo).some(x => x.name.includes('exactly one pane compact')))
})
t('no dark case => FAIL', () => {
  const bad = JSON.parse(JSON.stringify(good)); bad.cases.forEach(c => { c.theme = 'light' })
  assert.ok(fails(bad, buildInfo).some(x => x.name.includes('dark')))
})
t('chrome missing a key => FAIL (per-case chrome required)', () => {
  const bad = JSON.parse(JSON.stringify(good)); delete bad.cases[1].chrome.statusbar
  assert.ok(fails(bad, buildInfo).some(x => x.name.includes('chrome is per-case')))
})
t('gate/trust/autoRun outside their domains => FAIL', () => {
  const bad = JSON.parse(JSON.stringify(good))
  bad.cases[0].gate = 'unknown'; bad.cases[0].trust = 'auto'; bad.cases[0].autoRun = true
  const names = fails(bad, buildInfo).map(x => x.name).join('|')
  assert.ok(names.includes('gate is one of five') && names.includes('trust is one of four') && names.includes('autoRun'), names)
})
t('missing cases are SKIPPED, not silently passed', () => {
  const bad = JSON.parse(JSON.stringify(good)); bad.cases = [bad.cases[0]]
  const res = judge(bad, buildInfo)
  assert.ok(res.some(x => x.status === 'SKIPPED' && x.name.includes('911x512')))
})

for (const [s, n] of r) console.log(`${s}  ${n}`)
const f = r.filter(x => x[0] === 'FAIL').length
console.log(`\n${r.length - f}/${r.length} passed`)
process.exit(f ? 1 : 0)
