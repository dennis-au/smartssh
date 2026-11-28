// contract: v53
// proposalService.mjs — the single producer of bar state.
//
// The bar's template only renders what `barModel()` allows, but until now nothing ever produced a
// model, so `smartsshProposal` stayed null forever and the feature was dead in the shipped exe.
// This module is the missing producer: terminal buffer -> gate -> settler -> bar model.
//
// Design rules (deliberate, not incidental):
//  * No Angular, no Electron, no xterm import. The buffer, the token source, the clock, the timer
//    and the measurement provider are all injected, so the exact code that runs in the app also
//    runs under `node --test` headless.
//  * No hand-written state machine. Every state name comes from `stateFor(event)`; every user
//    action goes through `transition(state, action, ctx)`; every entry is checked by `mayEnter`.
//    If barModel refuses a move, the move does not happen — it throws, loudly.
//  * Fail-closed. A missing/blank/untrusted token, an alt screen, a selection, a scrolled
//    viewport, typed text after the cursor, or output still in flight all block `proposed`.
//    autoRun defaults to 'off'; nothing here may turn it on.
//  * The emitted model is validated by `barModel()` before it is published, so a model that the
//    DOM contract would reject can never reach the bar.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { isAtPrompt, GATE } from '../core/gate.mjs'
import { createSettler } from '../core/settle.mjs'
import { STATES, stateFor, transition, mayEnter, barModel, elementPolicy } from '../core/barModel.mjs'
import { tailIsHintFromSnapshot } from '../core/tailhint.mjs'
import { writeMetrics } from '../core/metricsWriter.mjs'
import { CASE_IDS } from '../core/metrics.mjs'
import { isMeasureEnabled, metricsBaseDir, resolveMetricsPath } from './metricsPath.mjs'
import { parseBuildInfo, formatVersion } from '../core/buildinfo.mjs'
import { isValidSha256, readExeSha } from './exeSha.mjs'

export const DEFAULT_INTERVAL_MS = 120
export const DEFAULT_QUIET_MS = 150
/** A proposal nobody answers stops being actionable; the bar then offers dismiss/ask_again. */
export const DEFAULT_EXPIRE_MS = 30_000
export const DEFAULT_BUILDINFO_PATHS = ['extras/smartssh-buildinfo.json', 'data/smartssh-buildinfo.json']

const LIVE_STATES = ['proposed', 'counting', 'executing', 'settling']
const EXIT_CODE_RE = /exit(?:ed)?(?: with)?(?: (?:code|status))?[ :=]*(-?\d+)\b/i

/**
 * The three window geometries of the UI measurement contract (designer v27 / metrics.mjs).
 * These are declared case *geometries*, not measurements of anything: the live numbers (rows,
 * cell height, theme, chrome) are supplied per reading by the host and override them.
 */
export const CASE_SPEC = {
  '683x512': {
    window: { wCss: 683, hCss: 512, dpr: 1.5 },
    dockMode: 'rail',
    theme: 'dark',
    chrome: { titlebar: 0, tabs: 28, statusbar: 0 },
    viewport: { heightPx: 147, rows: 7, cols: 78, cellHeightPx: 21 },
    panes: [{ id: 'only', heightPx: 183, compact: false, barMinHeightPx: 76 }],
    trustWhere: 'tab',
  },
  '911x512': {
    window: { wCss: 911, hCss: 512, dpr: 1.5 },
    dockMode: 'rail',
    theme: 'light',
    chrome: { titlebar: 0, tabs: 28, statusbar: 0 },
    viewport: { heightPx: 147, rows: 7, cols: 78, cellHeightPx: 21 },
    panes: [{ id: 'only', heightPx: 183, compact: false, barMinHeightPx: 76 }],
    trustWhere: 'tab',
  },
  '900-high-split': {
    window: { wCss: 1280, hCss: 900, dpr: 1 },
    dockMode: 'full',
    theme: 'dark',
    chrome: { titlebar: 0, tabs: 38, statusbar: 26 },
    viewport: { heightPx: 380, rows: 18, cols: 150, cellHeightPx: 21 },
    panes: [
      { id: 'top', heightPx: 450, compact: false, barMinHeightPx: 92 },
      { id: 'bottom', heightPx: 300, compact: true, barMinHeightPx: 76 },
    ],
    trustWhere: 'statusbar',
  },
}

const isStr = v => typeof v === 'string' && v.length > 0

/**
 * Build one measurement case for metricsWriter/`metrics-check.mjs`.
 * `reading` carries whatever the host really measured; anything it omits falls back to the
 * declared case geometry. Armed comes from the live token state; an unarmed run records
 * `armed: false` plus the gate reason that explains it.
 * @param {string} caseId
 * @param {object} [reading]
 */
export function buildMeasurement (caseId, reading = {}) {
  const spec = CASE_SPEC[caseId]
  if (!spec) throw new Error(`unknown case id: ${String(caseId)}`)
  const { armed } = reading
  if (typeof armed !== 'boolean') {
    throw new Error('buildMeasurement requires the live armed state (reading.armed must be a boolean); armed is never assumed')
  }
  if (!armed && !isStr(reading.gateReason)) {
    throw new Error('an unarmed measurement must carry reading.gateReason')
  }

  const measured = reading.measured === true
  if (measured && !(Number.isInteger(reading.rows) && Number.isFinite(reading.devicePixelRatio) && reading.devicePixelRatio > 0)) {
    throw new Error('a measured case must carry devicePixelRatio and dprSource')
  }
  const devicePixelRatio = measured ? reading.devicePixelRatio : spec.window.dpr
  const dprSource = measured
    ? (isStr(reading.dprSource) ? reading.dprSource : 'window.devicePixelRatio')
    : 'CASE_SPEC'
  const rows = Number.isInteger(reading.rows) ? reading.rows : spec.viewport.rows
  const cellHeightPx = Number.isFinite(reading.cellHeightPx) ? reading.cellHeightPx : spec.viewport.cellHeightPx
  const heightPx = Number.isFinite(reading.heightPx)
    ? reading.heightPx
    : (rows === spec.viewport.rows ? spec.viewport.heightPx : rows * cellHeightPx)
  return {
    case: caseId,
    measured,
    declared: !measured,
    devicePixelRatio,
    dprSource,
    window: { ...spec.window, ...reading.window, dpr: devicePixelRatio },
    dockMode: reading.dockMode ?? spec.dockMode,
    theme: reading.theme ?? spec.theme,
    chrome: { ...spec.chrome, ...reading.chrome },
    viewport: { heightPx, rows, cols: reading.cols ?? spec.viewport.cols, cellHeightPx },
    bar: { state: reading.state, mounted: true, heightPx: Number.isFinite(reading.barHeightPx) ? reading.barHeightPx : 76 },
    barCollapsed: { afterMs: 8000, heightPx: 0, stillMounted: true, display: 'flex' },
    panes: reading.panes ?? spec.panes,
    trustVisible: { where: reading.trustWhere ?? spec.trustWhere, armed, gateReason: reading.gateReason ?? '' },
  }
}

/**
 * Where the build identity is looked for, exe first.
 *
 * electron-builder copies `extras/` to `<exe dir>\resources\extras` (see electron-builder.yml
 * `extraResources`), which is exactly where windows-checklist.ps1 reads the identity from. The
 * cwd-relative dev paths stay last so `yarn start` from a checkout keeps working. A metrics file
 * with no build identity is rejected by metrics-check, so this lookup decides PASS vs "invalid".
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [execPath]
 * @returns {string[]}
 */
export function buildInfoPaths (env = process.env, execPath = process.execPath) {
  const out = []
  let base = null
  try { base = metricsBaseDir(env, execPath) } catch { /* no exe dir known: dev paths only */ }
  if (base) {
    out.push(
      join(base, 'resources', 'extras', 'smartssh-buildinfo.json'),
      join(base, 'data', 'smartssh-buildinfo.json'),
      join(base, 'extras', 'smartssh-buildinfo.json'),
    )
  }
  out.push(...DEFAULT_BUILDINFO_PATHS)
  return out
}

/** Read buildinfo and bind it to the executable this instance is running from. */
export function readBuildInfo (paths = buildInfoPaths(), deps = {}) {
  const injected = isValidSha256(deps.exeSha) ? deps.exeSha : ''
  const defaultCompute = () => readExeSha(deps.env ?? process.env, deps.execPath ?? process.execPath)
  for (const p of paths) {
    if (!p) continue
    let info
    try { info = parseBuildInfo(readFileSync(p, 'utf8')) } catch { continue }
    if (!info) continue

    let sha = isValidSha256(info.sha256) ? info.sha256 : injected
    if (!sha) {
      try {
        const computed = (deps.computeExeSha ?? defaultCompute)()
        if (isValidSha256(computed)) sha = String(computed).toUpperCase()
      } catch { /* unreadable exe: no build identity */ }
    }
    return sha ? { version: formatVersion(info), sha256: sha, commit: info.commit } : null
  }
  return null
}

/**
 * @param {object} options
 * @param {object|(() => object)} options.buffer   terminal buffer reader (getLine/cursorX/baseY/...)
 * @param {{token?: string, tokenTrusted?: boolean, getToken?: () => {token: string, tokenTrusted: boolean}}} [options.token]
 * @param {{now: () => number}} [options.clock]
 * @param {number} [options.intervalMs]      poll interval; 0 disables the internal timer
 * @param {number} [options.quietMs]         settler quiet window
 * @param {number} [options.expireMs]        proposal TTL
 * @param {'on'|'off'} [options.autoRun]     default 'off' — never turned on here
 * @param {'off'|'watch'|'propose'|'readonly_auto'} [options.trust] label used in metrics
 * @param {boolean} [options.metrics]        default: SMARTSSH_MEASURE === '1'
 * @param {string} [options.metricsPath]     default: resolveMetricsPath() -> <exe dir>/data/metrics.json
 * @param {object} [options.build]           {version, sha256, commit}; default: buildinfo on disk
 * @param {(caseId: string, ctx: object) => object} [options.measurement]  per-case reading
 * @param {(path: string, text: string) => void} [options.writeFile]       injectable for tests
 */
export function createProposalService (options = {}) {
  const resolveBuffer = typeof options.buffer === 'function' ? options.buffer : () => options.buffer
  const clock = options.clock ?? { now: () => Date.now() }
  const now = () => Number(clock.now())
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const expireMs = options.expireMs ?? DEFAULT_EXPIRE_MS
  const autoRun = options.autoRun === 'on' ? 'on' : 'off'
  const writeFile = options.writeFile ?? ((path, text) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text, 'utf8')
  })
  const metricsEnabled = options.metrics ?? isMeasureEnabled(process.env)
  // Resolved lazily: an app run with metrics off never needs an exe path, and a host that has no
  // process.execPath (renderer without node) must not fail service construction over it.
  const metricsPath = () => options.metricsPath ?? resolveMetricsPath(process.env)
  const measurementOptions = options.measurementOptions ?? {}

  const settler = createSettler({ quietMs: options.quietMs ?? DEFAULT_QUIET_MS })

  let tokenState = { token: '', tokenTrusted: false }
  let stopped = false
  let state = null             // null = no bar mounted
  let everHadProposal = false
  let pending = null           // proposal request that has not cleared the gate yet
  let proposal = null          // the proposal the bar is showing
  let cause = ''               // offline cause: token | network
  let exitCode = null
  let proposedAt = 0
  let lastGate = { gate: GATE.DIRTY, reason: 'prompt_dirty' }
  let lastDigest = null
  let published = null
  let timer = null
  let metricsError = null
  const listeners = new Set()

  // ---------------------------------------------------------------- token / arming
  // The token is either pushed in (setToken, the latest push's token) or read live from the host.
  let getTokenState = typeof options.getToken === 'function' ? options.getToken : () => tokenState
  if (options.token) setToken(options.token)

  const armed = () => {
    const t = getTokenState() ?? {}
    return t.tokenTrusted === true && typeof t.token === 'string' && t.token.trimEnd().length > 0
  }

  function setToken (next = {}) {
    if (typeof next === 'string') next = { token: next, tokenTrusted: true }
    tokenState = {
      token: typeof next.token === 'string' ? next.token : '',
      tokenTrusted: next.tokenTrusted === true,
    }
    return { ...tokenState }
  }

  // ---------------------------------------------------------------- buffer -> gate
  function readSnapshot () {
    const b = resolveBuffer()
    if (!b) return null
    const baseY = Number.isInteger(b.baseY) ? b.baseY : 0
    const viewportY = Number.isInteger(b.viewportY) ? b.viewportY : baseY
    const cursorY = Number.isInteger(b.cursorY) ? b.cursorY : (Number.isInteger(b.rows) ? b.rows - 1 : 0)
    const line = typeof b.getLine === 'function' ? b.getLine(baseY + cursorY) : null
    const text = typeof line?.translateToString === 'function' ? line.translateToString(false) : ''
    const cursorX = Number.isInteger(b.cursorX) ? b.cursorX : 0
    const cols = Number.isInteger(b.cols) ? b.cols : text.length
    const rows = Number.isInteger(b.rows) ? b.rows : 24
    const cellAt = typeof line?.getCell === 'function' ? (col) => line.getCell(col) : null

    let prefix
    let tail
    let tailIsHint = false
    if (cellAt) {
      // Cell-accurate form: a JS string index is not a column when wide characters precede the
      // cursor, so the gate is fed cells, not `line.slice(0, cursorX)`.
      const cells = []
      for (let col = 0; col < cols; col++) cells.push(cellAt(col))
      const chars = (cell) => {
        if (!cell) return ''
        if (typeof cell.getChars === 'function') return cell.getChars()
        return ''
      }
      prefix = cells.slice(0, cursorX).map(chars).join('')
      tail = cells.slice(cursorX).map(chars).join('')
      tailIsHint = tailIsHintFromSnapshot({ cursorX, cols, getCell: cellAt })
    }

    return {
      text,
      cursorX,
      cols,
      rows,
      baseY,
      viewportY,
      cursorY,
      altScreen: !!b.altScreen,
      selection: !!b.selection,
      // The whole viewport, not just the cursor row: echoing a command and its output leaves the
      // cursor row (the prompt) identical, so a cursor-row-only digest would look like silence and
      // the settler would never see the output come back.
      viewport: (() => {
        const parts = []
        for (let i = 0; i < rows; i++) {
          const row = typeof b.getLine === 'function' ? b.getLine(baseY + i) : null
          parts.push(typeof row?.translateToString === 'function' ? row.translateToString(true) : '')
        }
        return parts.join('\n')
      })(),
      prefix,
      tail,
      tailIsHint,
    }
  }

  function gateFrom (snapshot) {
    const { token, tokenTrusted } = getTokenState() ?? {}
    const common = {
      token,
      tokenTrusted,
      altScreen: snapshot.altScreen,
      selection: snapshot.selection,
      viewportY: snapshot.viewportY,
      baseY: snapshot.baseY,
    }
    if (typeof snapshot.prefix === 'string') {
      return isAtPrompt({
        ...common,
        prefix: snapshot.prefix,
        tail: snapshot.tail,
        tailIsHint: snapshot.tailIsHint,
      })
    }
    return isAtPrompt({ ...common, line: snapshot.text, cursorX: snapshot.cursorX })
  }

  // ---------------------------------------------------------------- model emission
  const riskOf = () => proposal?.risk ?? pending?.risk ?? 'write'

  function buildModel () {
    const model = {
      state,
      risk: riskOf(),
      command: proposal?.command ?? '',
      why: proposal?.why ?? '',
      time: proposal?.time ?? '',
      gate: { gate: lastGate.gate, reason: lastGate.reason },
      gateReason: lastGate.reason,
      cause: state === 'offline' ? cause : '',
      exitCode: state === 'exited' ? exitCode : null,
      autoRun,
    }
    // Validate against the DOM contract before anything can see it.
    const built = barModel(model)
    return {
      ...model,
      attrs: built.attrs,
      controls: built.controls,
      policy: elementPolicy(state, everHadProposal),
    }
  }

  function publish (model) {
    const key = model === null ? 'null' : JSON.stringify([
      model.state, model.risk, model.command, model.gate.gate, model.gateReason,
      model.cause, model.exitCode, model.autoRun,
    ])
    const prev = published === null ? 'null' : JSON.stringify([
      published.state, published.risk, published.command, published.gate.gate, published.gateReason,
      published.cause, published.exitCode, published.autoRun,
    ])
    published = model
    if (key === prev) return
    if (metricsEnabled && model) recordMeasurement(model)
    for (const listener of [...listeners]) {
      try { listener(model) } catch { /* a broken UI listener must not stop the service */ }
    }
  }

  function emit () {
    publish(state === null ? null : buildModel())
  }

  // ---------------------------------------------------------------- state moves
  function enter (next, extra = {}) {
    if (next === 'hidden') { state = null; proposal = null; emit(); return }
    if (!STATES.includes(next)) throw new Error(`unknown state: ${next}`)
    if (!mayEnter(next, { autoRun, gate: lastGate, risk: riskOf() })) {
      throw new Error(`entry to ${next} refused by mayEnter`)
    }
    state = next
    if (extra.cause !== undefined) cause = extra.cause
    if (extra.exitCode !== undefined) exitCode = extra.exitCode
    if (LIVE_STATES.includes(next)) cause = ''
    if (next === 'proposed') { proposedAt = now(); everHadProposal = true }
    emit()
  }

  function act (action, ctx = {}) {
    if (stopped || state === null) return null
    const next = transition(state, action, {
      risk: riskOf(),
      gate: lastGate,
      autoRun,
      proposal: proposal ?? {},
      code: ctx.code,
      cause: state === 'offline' ? cause : ctx.cause,
    })
    if (next === 'hidden') { enter('hidden'); return 'hidden' }
    enter(next, ctx)
    return next
  }

  function startProposal () {
    proposal = pending
    pending = null
    enter(stateFor('proposal'))
  }

  // ---------------------------------------------------------------- public API
  /**
   * Ask for a proposal. It is not shown until the gate is clean and the terminal is quiet: the
   * gate, not this call, decides when a command may be proposed.
   */
  function propose (request = {}) {
    if (typeof request.command !== 'string' || request.command.trim().length === 0) {
      throw new Error('propose() requires a non-empty command')
    }
    const risk = request.risk ?? 'write'
    if (!['read', 'write', 'danger'].includes(risk)) throw new Error(`unknown risk: ${risk}`)
    if (state !== null) return { queued: false, reason: 'busy', state }
    pending = { ...request, risk }
    return { queued: true }
  }

  function cancelPending () { pending = null }

  /** The host calls this the moment it feeds bytes to the pty. */
  function noteFeed () {
    // Do NOT clear the digest: the next poll must see the echo as new output and prove it came
    // back after the feed (settler gate (a)), or every dispatched command would look dead.
    settler.onFeed(now())
    return settler.state()
  }

  function noteExit (code = null) {
    exitCode = Number.isInteger(code) ? code : null
    return exitCode
  }

  /** Losing the relay token is not a user error: offline/token offers reset_token, not retry. */
  function noteOffline (why = 'network') {
    if (!['token', 'network'].includes(why)) throw new Error(`unknown offline cause: ${why}`)
    if (stopped) return null
    // Through enter(): an entry check, the cause, and one publish, not a second state machine.
    enter(stateFor('token_lost'), { cause: why })
    return state
  }

  function dispatchFailed () {
    if (stopped) return null
    enter(stateFor('dispatch_failed'))
    return state
  }

  // ---------------------------------------------------------------- tick
  function tick () {
    if (stopped) return state
    const t = now()
    const snapshot = readSnapshot()
    if (!snapshot) return state

    const raw = gateFrom(snapshot)
    const digest = [snapshot.viewport, snapshot.cursorX, snapshot.baseY, snapshot.viewportY, snapshot.altScreen ? 1 : 0].join('\u0000')
    // The first poll has nothing to compare against: whatever is already on screen is not "new
    // output", so it must not start a quiet window or a proposal could never be clean.
    if (lastDigest !== null && digest !== lastDigest) {
      settler.onOutput(t, { promptLine: raw.gate === GATE.CLEAN })
    }
    lastDigest = digest
    lastGate = settler.evaluate(t, raw)

    // Arming is checked before anything else: a lost token invalidates every live state.
    if (state !== null && LIVE_STATES.includes(state) && !armed()) {
      enter(stateFor('token_lost'), { cause: 'token' })
      return state
    }

    switch (state) {
      case null:
        if (pending) {
          if (lastGate.gate === GATE.CLEAN) startProposal()
          else if (lastGate.gate === GATE.SETTLING) enter(stateFor('settle'))
        }
        break
      case 'proposed':
      case 'counting':
        if (t - proposedAt >= expireMs) enter(stateFor('expire'))
        break
      case 'executing':
      case 'settling': {
        const next = lastGate.gate === GATE.CLEAN
          ? stateFor('exit')
          : (lastGate.gate === GATE.SETTLING && state === 'executing' ? stateFor('settle') : null)
        if (next === 'exited') enter(next, { exitCode: pendingExitCode() })
        else if (next === 'settling') enter(next)
        break
      }
      default:
        break
    }
    emit()
    return state
  }

  const pendingExitCode = () => (exitCode === null ? null : exitCode)

  // ---------------------------------------------------------------- metrics
  const measurements = new Map()
  let last = null

  function recordMeasurement (model) {
    last = model
    if (typeof options.measurement === 'function') {
      const isArmed = armed()
      for (const id of CASE_IDS) {
        try {
          const reading = options.measurement(id, { state: model.state, model, gate: model.gate }) ?? {}
          measurements.set(id, buildMeasurement(id, {
            ...measurementOptions, ...reading, state: model.state, armed: isArmed, gateReason: model.gate.reason,
          }))
        } catch (error) {
          metricsError = error
        }
      }
    }
  }

  function metricsDocument () {
    const build = options.build ?? readBuildInfo()
    if (!build) throw new Error('UI metrics need build identity: pass build, or ship resources/extras/smartssh-buildinfo.json next to the exe')
    const gate = last?.gate ?? lastGate
    const isArmed = armed()
    const trust = options.trust ?? (isArmed ? 'propose' : 'watch')
    const decorate = (measurement) => ({
      ...measurement,
      gate: gate.gate,
      gateReason: gate.reason,
      trust,
      // Cached geometry may predate a token change; use the document's live trust snapshot.
      trustVisible: { ...measurement.trustVisible, armed: isArmed, gateReason: gate.reason },
      autoRun,
      barMountedWhenNoProposal: false,
    })
    const cases = CASE_IDS.map((id) => {
      const measurement = measurements.get(id)
      if (measurement) return decorate(measurement)
      const reading = typeof options.measurement === 'function'
        ? options.measurement(id, { state: last?.state ?? 'proposed', model: last ?? null, gate }) ?? {}
        : {}
      return decorate(buildMeasurement(id, {
        ...measurementOptions, ...reading, state: last?.state ?? 'proposed', armed: isArmed, gateReason: gate.reason,
      }))
    })
    return JSON.parse(writeMetrics({ build, cases }))
  }

  function flushMetrics () {
    if (!metricsEnabled) return null
    if (metricsError) throw metricsError
    const doc = metricsDocument()
    const path = metricsPath()
    writeFile(path, JSON.stringify(doc))
    return { path, doc }
  }

  // ---------------------------------------------------------------- lifecycle
  function subscribe (listener) {
    if (typeof listener !== 'function') throw new Error('subscribe() requires a function')
    listeners.add(listener)
    if (published) listener(published)
    return () => listeners.delete(listener)
  }

  function start () {
    if (stopped || timer || !(intervalMs > 0)) return
    timer = setInterval(tick, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stop () {
    if (stopped) return
    stopped = true
    if (timer) { clearInterval(timer); timer = null }
    if (metricsEnabled) {
      try { flushMetrics() } catch (error) { metricsError = error }
    }
    listeners.clear()
  }

  if ((options.schedule ?? intervalMs > 0) === true) start()

  return {
    // observation
    tick,
    subscribe,
    start,
    stop,
    model: () => (state === null ? null : buildModel()),
    gate: () => ({ ...lastGate }),
    state: () => state,
    everHadProposal: () => everHadProposal,
    settlerState: () => settler.state(),
    // token / arming
    setToken,
    armed,
    // proposal lifecycle
    propose,
    cancelPending,
    approve: () => act('approve'),
    confirmCode: (code) => act('confirm_code', { code }),
    runNow: () => act('run_now'),
    cancel: () => act('cancel'),
    reject: () => act('reject'),
    dismiss: () => act('dismiss'),
    askAgain: () => act('ask_again'),
    expand: () => act('expand'),
    ctrlC: () => act('ctrl_c'),
    resetToken: () => act('reset_token'),
    retry: () => act('retry'),
    copyDiag: () => act('copy_diag'),
    // terminal / transport events
    noteFeed,
    noteExit,
    noteOffline,
    dispatchFailed,
    // metrics
    flushMetrics,
    metricsError: () => metricsError,
  }
}
