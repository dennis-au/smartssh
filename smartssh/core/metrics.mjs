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
export const CASE_IDS = ['683x512', '911x512', '900-high-split']
export const BAR_STATES = ['proposed', 'counting', 'executing', 'rejected', 'aborted', 'expired', 'settling', 'unknown', 'idle']
export const TERMINAL_STATES = ['rejected', 'aborted', 'expired']
export const GATES = ['clean', 'prompt_dirty', 'settling', 'alt_screen', 'continuation']
export const TRUST = ['off', 'watch', 'propose', 'readonly_auto']

const isNum = v => typeof v === 'number' && Number.isFinite(v)
const isStr = v => typeof v === 'string' && v.length > 0

export function parseMetrics (text) {
  const clean = stripBom(text).trim()
  if (!clean) return { error: 'empty' }
  let raw
  try { raw = JSON.parse(clean) } catch { return { error: 'invalid json' } }
  if (!raw || typeof raw !== 'object') return { error: 'not an object' }
  if (raw.schema !== SCHEMA) return { error: `schema must be ${SCHEMA}, got ${JSON.stringify(raw.schema)}` }
  if (!raw.build || !isStr(raw.build.commit)) return { error: 'build.commit missing' }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) return { error: 'cases[] missing' }
  return { metrics: raw }
}

const byName = (m, id) => m.cases.find(c => c && c.case === id)

/** @returns {Array<{name:string,status:'PASS'|'FAIL'|'SKIPPED',detail:string}>} */
export function judgeMetrics (m, buildInfo) {
  const out = []
  const add = (name, ok, detail) => out.push({ name, status: ok ? 'PASS' : 'FAIL', detail: String(detail) })
  const skip = (name, why) => out.push({ name, status: 'SKIPPED', detail: why })

  // build identity: never sign A's numbers against B's exe
  if (buildInfo && buildInfo.commit) {
    add('metrics build.commit matches the exe', m.build.commit === buildInfo.commit, `${m.build.commit} vs ${buildInfo.commit}`)
  } else {
    skip('metrics build.commit matches the exe', 'no buildinfo.json next to the exe')
  }

  for (const id of CASE_IDS) {
    const c = byName(m, id)
    if (!c) { skip(`case ${id}`, 'not reported by this build'); continue }

    add(`${id} rows >= 6`, isNum(c.viewport?.rows) && c.viewport.rows >= 6, `rows=${c.viewport?.rows}`)
    add(`${id} theme recorded`, c.theme === 'light' || c.theme === 'dark', `theme=${c.theme}`)
    add(`${id} chrome is per-case`, c.chrome && ['titlebar', 'tabs', 'statusbar'].every(k => isNum(c.chrome[k])),
      `tabs=${c.chrome?.tabs} statusbar=${c.chrome?.statusbar}`)
    add(`${id} dockMode`, c.dockMode === 'full' || c.dockMode === 'rail', `dockMode=${c.dockMode}`)
    add(`${id} gate is one of five`, GATES.includes(c.gate), `gate=${c.gate}`)
    add(`${id} trust is one of four`, TRUST.includes(c.trust), `trust=${c.trust}`)
    add(`${id} autoRun is on/off`, c.autoRun === 'on' || c.autoRun === 'off', `autoRun=${c.autoRun}`)
    add(`${id} bar has no proposal => not mounted`, c.barMountedWhenNoProposal === false, `mounted=${c.barMountedWhenNoProposal}`)

    // statusbar hidden => armed state must be visible somewhere else
    if (c.chrome?.statusbar === 0) {
      const tv = c.trustVisible
      add(`${id} armed state visible with the statusbar hidden`,
        !!tv && (tv.where === 'tab' || tv.where === 'rail') && tv.armed === true,
        tv ? `where=${tv.where} armed=${tv.armed}` : 'trustVisible missing')
    }

    // collapsed terminal state: height 0, still mounted, not display:none
    if (TERMINAL_STATES.includes(c.bar?.state)) {
      const col = c.barCollapsed
      add(`${id} bar collapsed after ${col?.afterMs ?? '?'}ms`, col && col.afterMs === 8000 && col.heightPx === 0,
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
        panes.every(p => isNum(p.heightPx) && isNum(p.barMinHeightPx)), JSON.stringify(panes.map(p => p?.barMinHeightPx)))
    }
  }

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
