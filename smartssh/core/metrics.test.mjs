import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMetrics, judgeMetrics, summarise, countLive, SCHEMA } from './metrics.mjs'

const r = []; const t = (n, f) => { try { f(); r.push(['PASS', n]) } catch (e) { r.push(['FAIL', n + ' :: ' + e.message]) } }
const BOM = '\uFEFF'

// New contract: every case names its geometry source and records its DPR.
const okCase = (id, over = {}) => ({
  case: id,
  measured: false,
  declared: true,
  devicePixelRatio: 1.5,
  dprSource: 'CASE_SPEC',
  window: { wCss: 683, hCss: 512, dpr: 1.5 },
  dockMode: 'rail',
  theme: 'dark',
  chrome: { titlebar: 0, tabs: 28, statusbar: 0 },
  viewport: { heightPx: 147, rows: 7, cols: 78, cellHeightPx: 21 },
  bar: { state: 'offline', mounted: false, heightPx: 0 },
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
  })],
}
const judge = (m, b) => judgeMetrics(typeof m === 'string' ? parseMetrics(m).metrics : m, b)
const fails = (m, b) => judge(m, b).filter(x => x.status === 'FAIL')
const buildInfo = { commit: '54869e1', sha256: 'A'.repeat(64) }

t('schema: good file parses and every rule passes', () => {
  const p = parseMetrics(JSON.stringify(good))
  assert.ok(p.metrics, p.error)
  assert.deepStrictEqual(fails(p.metrics, buildInfo), [])
  const s = summarise(judgeMetrics(p.metrics, buildInfo))
  assert.ok(s.pass > 10 && s.fail === 0 && s.skip === 0, JSON.stringify(s))
})
t('BOM-prefixed metrics parse identically', () =>
  assert.deepStrictEqual(parseMetrics(BOM + JSON.stringify(good)).metrics, good))
t('schema drift fails loudly, not silently', () => {
  assert.strictEqual(parseMetrics(JSON.stringify({ ...good, schema: 2 })).error.includes('schema'), true)
  assert.strictEqual(parseMetrics(JSON.stringify({ ...good, schema: undefined })).error.includes('schema'), true)
})
t('build.commit mismatch is a FAIL (A build numbers cannot sign B exe)', () =>
  assert.ok(fails(good, { ...buildInfo, commit: 'deadbee' }).some(f => f.name.includes('build.commit'))))
t('build.sha256 cannot be empty or malformed', () => {
  for (const sha256 of ['', undefined, 'a'.repeat(63), 'g'.repeat(64)]) {
    const bad = { ...good, build: { ...good.build, sha256 } }
    assert.strictEqual(parseMetrics(JSON.stringify(bad)).error,
      'build.sha256 must be the exe sha256 (64 hex); an empty sha binds the numbers to no binary')
  }
})
t('expected exe hash is compared case-insensitively and mismatch fails', () => {
  const name = 'metrics build.sha256 matches the exe under test'
  assert.strictEqual(judge(good, buildInfo).find(x => x.name === name).status, 'PASS')
  assert.ok(fails(good, { ...buildInfo, sha256: 'b'.repeat(64) }).some(x => x.name === name))
  assert.strictEqual(judge(good, { commit: buildInfo.commit }).find(x => x.name === name).status, 'SKIPPED')
})
t('rows come from the terminal, not from height/cellHeight', () => {
  const bad = JSON.parse(JSON.stringify(good)); bad.cases[0].viewport.rows = 4
  assert.ok(fails(bad, buildInfo).some(f => f.name.includes('683x512 rows')))
})
t('statusbar hidden + armed state invisible => FAIL', () => {
  const bad = JSON.parse(JSON.stringify(good)); delete bad.cases[0].trustVisible
  assert.ok(fails(bad, buildInfo).some(f => f.name.includes('armed state visible')))
})
t('armed cannot be fabricated when trust is watch', () => {
  const bad = { ...good, cases: [{ ...good.cases[0], trust: 'watch' }, ...good.cases.slice(1)] }
  assert.ok(fails(bad, buildInfo).some(f => f.name.includes('armed flag is derived from the live trust level')))
})
t('visible unarmed watch state passes only with a gate reason', () => {
  const unarmed = { ...good.cases[0], trust: 'watch', trustVisible: { where: 'tab', armed: false }, gateReason: 'not_armed' }
  const doc = { ...good, cases: [unarmed, ...good.cases.slice(1)] }
  assert.deepStrictEqual(fails(doc, buildInfo), [])
  unarmed.gateReason = ''
  assert.ok(fails(doc, buildInfo).some(f => f.name.includes('armed flag is derived from the live trust level')))
})
t('geometry source must be stated using two complementary boolean fields', () => {
  for (const flags of [
    { measured: undefined, declared: undefined }, { measured: true, declared: true },
    { measured: false, declared: false }, { measured: 'false', declared: true },
  ]) {
    const bad = { ...good, cases: [{ ...good.cases[0], ...flags }, ...good.cases.slice(1)] }
    assert.ok(fails(bad, buildInfo).some(f => f.name.includes('geometry source is stated exactly once')))
  }
})
t('measured and declared cases each require a positive DPR and the right source', () => {
  for (const [index, fields, rule] of [
    [2, { devicePixelRatio: 0 }, 'live case carries real devicePixelRatio provenance'],
    [2, { dprSource: 'CASE_SPEC' }, 'live case carries real devicePixelRatio provenance'],
    [0, { devicePixelRatio: undefined }, 'declared case is labelled declared'],
    [0, { dprSource: 'window.devicePixelRatio' }, 'declared case is labelled declared'],
  ]) {
    const cases = good.cases.map((c, i) => i === index ? { ...c, ...fields } : c)
    assert.ok(fails({ ...good, cases }, buildInfo).some(f => f.name.includes(rule)))
  }
})
t('live measurements count only measured:true, not declared cases', () => {
  assert.strictEqual(countLive(good), 1)
  assert.strictEqual(countLive({ cases: [null, { measured: 'true' }, { declared: true }] }), 0)
  assert.deepStrictEqual(judge(good, buildInfo).find(x => x.name === 'live measurements are counted from measured:true only'), {
    name: 'live measurements are counted from measured:true only', status: 'PASS', detail: '1 live / 2 declared (of 3)',
  })
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
t('bar.state must be one of the nine v26 values', () => {
  const bad = JSON.parse(JSON.stringify(good)); bad.cases[0].bar.state = 'idle'
  assert.ok(fails(bad, buildInfo).some(x => x.name.includes('bar state is one of nine')))
  for (const st of ['proposed','counting','settling','executing','exited','rejected','aborted','expired','offline']) {
    const ok = JSON.parse(JSON.stringify(good)); ok.cases[0].bar.state = st
    if (['exited','rejected','aborted','expired'].includes(st)) ok.cases[0].barCollapsed = { afterMs: 8000, heightPx: 0, stillMounted: true, display: 'flex' }
    assert.deepStrictEqual(fails(ok, buildInfo), [], st)
  }
})
const partial = { ...good, cases: [good.cases[0]] }
t('each missing required case is a FAIL', () => {
  const res = judge(partial, buildInfo)
  for (const id of ['911x512', '900-high-split']) {
    assert.deepStrictEqual(res.find(x => x.name === `case ${id} is present`), {
      name: `case ${id} is present`,
      status: 'FAIL',
      detail: 'required case missing from metrics.json',
    })
  }
  assert.ok(summarise(res).fail > 0)
})
t('metrics-check exits 2 for a partial metrics file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smartssh-metrics-'))
  try {
    const path = join(dir, 'partial.json')
    writeFileSync(path, JSON.stringify(partial))
    const checker = fileURLToPath(new URL('./metrics-check.mjs', import.meta.url))
    const run = spawnSync(process.execPath, [checker, '--metrics', path], { encoding: 'utf8' })
    if (run.error) throw run.error
    assert.strictEqual(run.status, 2, run.stderr || run.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


// ---- regressions from product-tester's six fixtures ----
t('ghost case ids: zero matched cases is a FAIL, not a green run', () => {
  const bad = { schema: 1, build: good.build, cases: [okCase('683x512x'), okCase('911x512x'), okCase('900-high-splitx')] }
  const res = judge(bad, buildInfo)
  assert.ok(res.some(x => x.status === 'FAIL' && x.name.includes('at least one required case')))
  assert.ok(summarise(res).fail > 0)
})
t('trustVisible is required in EVERY case, not only when the statusbar is hidden', () => {
  const bad = { schema: 1, build: good.build, cases: [okCase('683x512', { chrome: { titlebar: 0, tabs: 28, statusbar: 24 }, trustVisible: undefined }), okCase('911x512'), okCase('900-high-split')] }
  assert.ok(fails(bad, buildInfo).some(x => x.name.includes('armed state visible somewhere')))
})
t('rows must be an integer in 1..200 (6.5 is not a row count)', () => {
  const bad = { schema: 1, build: good.build, cases: [okCase('683x512', { viewport: { heightPx: 147, rows: 6.5, cols: 78, cellHeightPx: 21 } }), okCase('911x512'), okCase('900-high-split')] }
  assert.ok(fails(bad, buildInfo).some(x => x.name.includes('rows is an integer')))
})
t('negative chrome is rejected', () => {
  const bad = { schema: 1, build: good.build, cases: [okCase('683x512', { chrome: { titlebar: -3, tabs: 28, statusbar: 0 } }), okCase('911x512'), okCase('900-high-split')] }
  assert.ok(fails(bad, buildInfo).some(x => x.name.includes('chrome is per-case and non-negative')))
})
t('duplicate case ids are a parse error (the second copy cannot hide bad data)', () => {
  const bad = { schema: 1, build: good.build, cases: [okCase('683x512'), okCase('683x512', { viewport: { heightPx: 1, rows: 1, cols: 1, cellHeightPx: 1 } }), okCase('911x512')] }
  assert.match(parseMetrics(JSON.stringify(bad)).error, /duplicate case id/)
})

for (const [s, n] of r) console.log(`${s}  ${n}`)
const f = r.filter(x => x[0] === 'FAIL').length
console.log(`\n${r.length - f}/${r.length} passed`)
process.exit(f ? 1 : 0)
