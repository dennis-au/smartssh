// contract: v53
// metrics.mjs — validate and judge the UI measurement file the app writes when SMARTSSH_MEASURE=1.
// schema 1. Rules come from designer v27 + product-tester's review:
//  - one flat object cannot describe three window sizes => cases[]
//  - rows come from xterm's term.rows, never heightPx / cellHeight
//  - "collapsed" must prove height 0 AND still mounted AND display !== 'none'
//  - per-pane style, not a boolean, or "@media hit both panes" passes
//  - chrome is per-case (the statusbar disappears below 560px)
//  - build identity must match the exe under test
import { stripBom } from './buildinfo.mjs'

export const SCHEMA = 1
export const SHA256_RE = /^[0-9a-f]{64}$/i
export const CASE_IDS = ['683x512', '911x512', '900-high-split']
// designer v26 SPEC OF RECORD: exactly nine, in this spelling
export const BAR_STATES = ['proposed', 'counting', 'settling', 'executing', 'exited', 'rejected', 'aborted', 'expired', 'offline']
// states after which the bar collapses to height 0 (8s) but stays mounted
export const TERMINAL_STATES = ['exited', 'rejected', 'aborted', 'expired']
export const GATES = ['clean', 'prompt_dirty', 'settling', 'alt_screen', 'continuation']
export const TRUST = ['off', 'watch', 'propose', 'readonly_auto']

const isNum = v => typeof v === 'number' && Number.isFinite(v)
const isNonNeg = v => isNum(v) && v >= 0
const isRows = v => Number.isInteger(v) && v >= 1 && v <= 200
const isStr = v => typeof v === 'string' && v.length > 0

export function parseMetrics (text) {
  const clean = stripBom(text).trim()
  if (!clean) return { error: 'empty' }
  let raw
  try { raw = JSON.parse(clean) } catch { return { error: 'invalid json' } }
  if (!raw || typeof raw !== 'object') return { error: 'not an object' }
  if (raw.schema !== SCHEMA) return { error: `schema must be ${SCHEMA}, got ${JSON.stringify(raw.schema)}` }
  if (!raw.build || !isStr(raw.build.commit)) return { error: 'build.commit missing' }
  if (!SHA256_RE.test(String(raw.build.sha256 ?? ''))) {
    return { error: 'build.sha256 must be the exe sha256 (64 hex); an empty sha binds the numbers to no binary' }
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) return { error: 'cases[] missing' }
  const ids = raw.cases.map(c => (c && typeof c.case === 'string' ? c.case : null))
  if (ids.some(x => x === null)) return { error: 'case without an id' }
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i)
  if (dup.length) return { error: `duplicate case id: ${[...new Set(dup)].join(', ')}` }
  return { metrics: raw }
}

const byName = (m, id) => m.cases.find(c => c && c.case === id)
const lower = v => String(v).toLowerCase()

export function countLive (m) {
  return m.cases.filter(c => c && c.measured === true).length
}

/** @returns {Array<{name:string,status:'PASS'|'FAIL'|'SKIPPED',detail:string}>} */
export function judgeMetrics (m, buildInfo) {
  const out = []
  const add = (name, ok, detail) => out.push({ name, status: ok ? 'PASS' : 'FAIL', detail: String(detail) })
  // A typo in a case id used to skip every case and still exit 0 ("no data" read as "no problem").
  const matchedCases = CASE_IDS.filter(id => byName(m, id)).length
  add('at least one required case is present', matchedCases > 0, `matched ${matchedCases}/${CASE_IDS.length}`)
  const skip = (name, why) => out.push({ name, status: 'SKIPPED', detail: why })

  // build identity: never sign A's numbers against B's exe
  if (buildInfo && buildInfo.commit) {
    add('metrics build.commit matches the exe', m.build.commit === buildInfo.commit, `${m.build.commit} vs ${buildInfo.commit}`)
  } else {
    skip('metrics build.commit matches the exe', 'no buildinfo.json next to the exe')
  }
  if (buildInfo && buildInfo.sha256) {
    add('metrics build.sha256 matches the exe under test', lower(m.build.sha256) === lower(buildInfo.sha256), `${m.build.sha256} vs ${buildInfo.sha256}`)
  } else {
    skip('metrics build.sha256 matches the exe under test', 'no expected exe sha supplied (pass --exe-sha <sha256>)')
  }

  for (const id of CASE_IDS) {
    const c = byName(m, id)
    if (!c) { add(`case ${id} is present`, false, 'required case missing from metrics.json'); continue }

    add(`${id} rows is an integer >= 6`, isRows(c.viewport?.rows) && c.viewport.rows >= 6, `rows=${c.viewport?.rows}`)
    add(`${id} viewport numbers are non-negative`, isNonNeg(c.viewport?.heightPx) && isNonNeg(c.viewport?.cellHeightPx),
      `heightPx=${c.viewport?.heightPx} cellHeightPx=${c.viewport?.cellHeightPx}`)
    add(`${id} theme recorded`, c.theme === 'light' || c.theme === 'dark', `theme=${c.theme}`)
    add(`${id} chrome is per-case and non-negative`,
      c.chrome && ['titlebar', 'tabs', 'statusbar'].every(k => isNonNeg(c.chrome[k])),
      `titlebar=${c.chrome?.titlebar} tabs=${c.chrome?.tabs} statusbar=${c.chrome?.statusbar}`)
    add(`${id} dockMode`, c.dockMode === 'full' || c.dockMode === 'rail', `dockMode=${c.dockMode}`)
    add(`${id} gate is one of five`, GATES.includes(c.gate), `gate=${c.gate}`)
    add(`${id} trust is one of four`, TRUST.includes(c.trust), `trust=${c.trust}`)
    add(`${id} autoRun is on/off`, c.autoRun === 'on' || c.autoRun === 'off', `autoRun=${c.autoRun}`)
    add(`${id} bar state is one of nine`, BAR_STATES.includes(c.bar?.state), `state=${c.bar?.state}`)
    add(`${id} bar has no proposal => not mounted`, c.barMountedWhenNoProposal === false, `mounted=${c.barMountedWhenNoProposal}`)

    // The current armed state must remain visible even when the statusbar is hidden (designer v27).
    const tv = c.trustVisible
    const whereOk = !!tv && ['tab', 'rail', 'statusbar'].includes(tv.where) && typeof tv.armed === 'boolean'
    if (c.chrome?.statusbar === 0) {
      add(`${id} armed state visible with the statusbar hidden`,
        whereOk && tv.where !== 'statusbar',
        tv ? `where=${tv.where} armed=${tv.armed}` : 'trustVisible missing')
    } else {
      add(`${id} armed state visible somewhere`, whereOk, tv ? `where=${tv.where} armed=${tv.armed}` : 'trustVisible missing')
    }
    const trustActive = c.trust === 'propose' || c.trust === 'readonly_auto'
    add(`${id} armed flag is derived from the live trust level`,
      whereOk && tv.armed === trustActive && (tv.armed === true || isStr(c.gateReason)),
      `armed=${tv?.armed} trust=${c.trust} gateReason=${c.gateReason}`)

    // collapsed terminal state: height 0, still mounted, not display:none
    if (TERMINAL_STATES.includes(c.bar?.state)) {
      const col = c.barCollapsed
      add(`${id} bar collapsed after ${col?.afterMs ?? '?'}ms`, col && col.afterMs === 8000 && isNonNeg(col.heightPx) && col.heightPx === 0,
        col ? `afterMs=${col.afterMs} heightPx=${col.heightPx}` : 'barCollapsed missing')
      add(`${id} collapsed but still mounted (no unmount / no display:none)`,
        !!col && col.stillMounted === true && col.display !== 'none',
        col ? `stillMounted=${col.stillMounted} display=${col.display}` : 'barCollapsed missing')
    }

    // split pane: compact must be per pane, exactly the small one
    if (id === '900-high-split') {
      const panes = Array.isArray(c.panes) ? c.panes : []
      add('900-high-split reports >= 2 panes', panes.length >= 2, `panes=${panes.length}`)
      const compact = panes.filter(p => p && p.compact === true).length
      add('900-high-split: exactly one pane compact (@container, not @media)',
        panes.length >= 2 && compact === 1, `compact=${compact}/${panes.length}`)
      add('900-high-split: panes carry real style numbers',
        panes.every(p => isNonNeg(p.heightPx) && isNonNeg(p.barMinHeightPx)), JSON.stringify(panes.map(p => p?.barMinHeightPx)))
    }
  }

  for (const c of m.cases) {
    if (!c) continue
    const { case: id, measured, declared, devicePixelRatio, dprSource } = c
    add(`${id} geometry source is stated exactly once (measured xor declared)`,
      typeof measured === 'boolean' && typeof declared === 'boolean' && measured !== declared,
      `measured=${measured} declared=${declared}`)
    const dprOk = isNum(devicePixelRatio) && devicePixelRatio > 0
    if (measured === true) {
      add(`${id} live case carries real devicePixelRatio provenance`, dprOk && isStr(dprSource) && dprSource !== 'CASE_SPEC',
        `devicePixelRatio=${devicePixelRatio} source=${dprSource}`)
    } else {
      add(`${id} declared case is labelled declared`, declared === true && dprOk && dprSource === 'CASE_SPEC',
        `declared=${declared} devicePixelRatio=${devicePixelRatio} source=${dprSource}`)
    }
  }
  const live = countLive(m)
  const declared = m.cases.filter(c => c && c.declared === true).length
  add('live measurements are counted from measured:true only',
    live + declared === m.cases.length, `${live} live / ${declared} declared (of ${m.cases.length})`)
  const liveCount = countLive(m)
  add('at least one case is a live measurement (measured:true)',
    liveCount > 0,
    liveCount > 0
      ? `${liveCount} of ${m.cases.length} cases are measured:true`
      : `no live measurement: 0 of ${m.cases.length} cases are measured:true; every case is a declared ` +
        `CASE_SPEC value, so nothing in this file describes this exe's real window`)

  // at least one dark case overall
  add('at least one dark-theme case', m.cases.some(c => c && c.theme === 'dark'),
    `themes=${m.cases.map(c => c?.theme).join(',')}`)
  return out
}

export function summarise (results) {
  const fail = results.filter(r => r.status === 'FAIL').length
  const skip = results.filter(r => r.status === 'SKIPPED').length
  return { fail, skip, pass: results.length - fail - skip, total: results.length }
}
