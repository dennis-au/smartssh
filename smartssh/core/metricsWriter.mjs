// contract: v53
import { CASE_IDS, SCHEMA, SHA256_RE } from './metrics.mjs'

export function measurementToCase (m) {
  const id = m?.case
  if (!CASE_IDS.includes(id)) throw new Error(`unknown case id: ${String(id)}`)

  const { theme, chrome, viewport, trustVisible, measured, declared, devicePixelRatio, dprSource } = m
  if (theme !== 'light' && theme !== 'dark') throw new Error('theme must be light or dark')
  if (!chrome || !['titlebar', 'tabs', 'statusbar'].every(key => Number.isFinite(chrome[key]) && chrome[key] >= 0)) {
    throw new Error('chrome requires non-negative titlebar, tabs, and statusbar')
  }
  const rows = viewport?.rows
  if (!Number.isInteger(rows) || rows < 1 || rows > 200) {
    throw new Error('viewport.rows must be an integer in 1..200')
  }
  if (!trustVisible || !['tab', 'rail', 'statusbar'].includes(trustVisible.where) || typeof trustVisible.armed !== 'boolean') {
    throw new Error('trustVisible requires tab, rail, or statusbar and a boolean armed state')
  }
  if (trustVisible.armed === false && (typeof m.gateReason !== 'string' || !m.gateReason)) {
    throw new Error('an unarmed case must carry a non-empty gateReason')
  }
  if (typeof measured !== 'boolean' || typeof declared !== 'boolean' || measured === declared) {
    throw new Error('measured and declared are mutually exclusive and one of them is required')
  }
  const dprOk = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
  if (measured) {
    if (!dprOk || typeof dprSource !== 'string' || !dprSource || dprSource === 'CASE_SPEC') {
      throw new Error('a measured case must carry a real devicePixelRatio and dprSource')
    }
    if (![m.window?.wCss, m.window?.hCss].every(value => Number.isFinite(value) && value > 0)) {
      throw new Error('a measured case must state the real window it was measured in (window.wCss and window.hCss)')
    }
  } else if (!dprOk || dprSource !== 'CASE_SPEC') {
    throw new Error('a declared case must carry a positive devicePixelRatio and dprSource CASE_SPEC')
  }

  return {
    case: id,
    measured,
    declared,
    devicePixelRatio,
    dprSource,
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
    ...(typeof m.measurementNote === 'string' && m.measurementNote.length > 0 && { measurementNote: m.measurementNote }),
  }
}

export function writeMetrics ({ build, cases }) {
  if (!build || typeof build !== 'object' || Array.isArray(build) || typeof build.commit !== 'string' || !build.commit) {
    throw new Error('build.commit missing')
  }
  if (typeof build.sha256 !== 'string' || !SHA256_RE.test(build.sha256)) {
    throw new Error('build.sha256 must be the exe sha256 (64 hex); an empty sha binds the numbers to no binary')
  }
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
