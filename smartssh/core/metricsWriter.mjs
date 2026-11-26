// contract: v40
import { CASE_IDS, SCHEMA } from './metrics.mjs'

export function measurementToCase (m) {
  const id = m?.case
  if (!CASE_IDS.includes(id)) throw new Error(`unknown case id: ${String(id)}`)

  const { theme, chrome, viewport, trustVisible } = m
  if (theme !== 'light' && theme !== 'dark') throw new Error('theme must be light or dark')
  if (!chrome || !['titlebar', 'tabs', 'statusbar'].every(key => Number.isFinite(chrome[key]) && chrome[key] >= 0)) {
    throw new Error('chrome requires non-negative titlebar, tabs, and statusbar')
  }
  const rows = viewport?.rows
  if (!Number.isInteger(rows) || rows < 1 || rows > 200) {
    throw new Error('viewport.rows must be an integer in 1..200')
  }
  if (!trustVisible || !['tab', 'rail', 'statusbar'].includes(trustVisible.where) || trustVisible.armed !== true) {
    throw new Error('trustVisible requires tab, rail, or statusbar and armed === true')
  }

  return {
    case: id,
    window: m.window,
    dockMode: m.dockMode,
    theme,
    chrome,
    viewport,
    bar: m.bar,
    barCollapsed: m.barCollapsed,
    panes: m.panes,
    gate: m.gate,
    gateReason: m.gateReason,
    trust: m.trust,
    autoRun: m.autoRun,
    barMountedWhenNoProposal: m.barMountedWhenNoProposal,
    trustVisible,
  }
}

export function writeMetrics ({ build, cases }) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('cases[] missing')

  const ids = new Set()
  const normalized = []
  for (const m of cases) {
    const c = measurementToCase(m)
    if (ids.has(c.case)) throw new Error(`duplicate case id: ${c.case}`)
    ids.add(c.case)
    normalized.push(c)
  }

  const missing = CASE_IDS.filter(id => !cases.some(c => c && c.case === id))
  if (missing.length) throw new Error(`missing required cases: ${missing.join(', ')}`)

  // Escape any literal U+FEFF in string values without changing their decoded content.
  return JSON.stringify({ schema: SCHEMA, build, cases: normalized }).replace(/\uFEFF/g, '\\uFEFF')
}
