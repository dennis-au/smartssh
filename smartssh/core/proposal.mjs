// SmartSSH proposal — pure, clock-injected. The caller owns feeding and timers.
import { ERROR_CODES, TRUST } from './diagnostics.mjs'
import { GATE } from './gate.mjs'

export const STATE = Object.freeze({
  PENDING: 'pending',
  COUNTING: 'counting',
  EXECUTING: 'executing',
  DONE: 'done',
  REJECTED: 'rejected',
  FAILED: 'failed',
})
export const ORIGIN = Object.freeze({ AUTO: 'auto', MANUAL: 'manual' })
export const COUNTDOWN_MS = 2000
const GATES = Object.freeze(Object.values(GATE))
const READONLY_AUTO = TRUST.find(value => value === 'readonly_auto')
const TERMINAL = Object.freeze([STATE.DONE, STATE.REJECTED, STATE.FAILED])

// Share one factory among the proposals in an app run.
export function createIdFactory () {
  let next = 0n
  return () => `sms-${++next}`
}

export function createProposal ({ id, command, tabId, hostId, trust, ts }) {
  const createdAt = ts
  trust = TRUST.includes(trust) ? trust : 'off'
  let phase = STATE.PENDING
  let gate = GATE.DIRTY
  let reason = GATE.DIRTY
  let origin = ORIGIN.MANUAL
  let deadline = null
  let decidedAt = null
  let autoSuppressed = false

  const state = () => ({
    id, state: phase, gate, reason, origin,
    countdownMs: phase === STATE.COUNTING ? COUNTDOWN_MS : null, decidedAt,
  })
  const no = why => ({ ok: false, why })
  const ok = () => ({ ok: true, why: null })
  const terminal = () => TERMINAL.includes(phase)
  const awaitingApproval = () => phase === STATE.PENDING || phase === STATE.COUNTING

  function offer (reading, ts) {
    if (terminal()) return no('terminal')
    if (!awaitingApproval()) return no('already_approved')
    if (GATES.includes(reading?.gate)) {
      gate = reading.gate
      reason = reading.reason || gate
    } else {
      gate = GATE.DIRTY
      reason = gate
    }
    if (trust !== READONLY_AUTO || gate !== GATE.CLEAN || autoSuppressed) {
      phase = STATE.PENDING
      deadline = null
      return { action: 'ask' }
    }
    // A refresh of a clean gate is not a new countdown.
    if (phase !== STATE.COUNTING) {
      phase = STATE.COUNTING
      deadline = ts + COUNTDOWN_MS
    }
    return { action: 'countdown', ms: Math.max(0, deadline - ts) }
  }

  function authorize (ts, source) {
    phase = STATE.EXECUTING
    origin = source
    deadline = null
    decidedAt = ts
    return ok()
  }

  function approve ({ ts, eventRepeat, override } = {}) {
    if (terminal()) return no('terminal')
    if (!awaitingApproval()) return no('already_approved')
    if (eventRepeat) return no('event_repeat')
    const uncertain = gate === GATE.SETTLING || (gate === GATE.DIRTY &&
      (reason === 'token_untrusted' || reason === 'token_empty'))
    if (gate !== GATE.CLEAN && !(override === true && uncertain)) return no(reason)
    return authorize(ts, ORIGIN.MANUAL)
  }

  // Forward a keypress, same-tab replacement, or disconnect here. An explicit
  // interruption leaves the proposal manual-only, even if the gate stays clean.
  function cancelCountdown ({ reason: interruption } = {}) {
    if (terminal()) return no('terminal')
    if (!awaitingApproval()) return no('already_approved')
    autoSuppressed = true
    phase = STATE.PENDING
    deadline = null
    if (interruption && gate === GATE.CLEAN) reason = interruption
    return ok()
  }

  // Caller offers the settler's latest gate first, then checks for expiry.
  // Only a successful approve() or settle() authorizes a feed.
  function settle ({ ts } = {}) {
    if (terminal()) return no('terminal')
    if (!awaitingApproval()) return no('already_approved')
    if (phase !== STATE.COUNTING) return no('not_counting')
    if (!(ts >= deadline)) return no('counting')
    return authorize(ts, ORIGIN.AUTO)
  }

  // Acknowledges dispatch; it cannot authorize a feed on its own.
  function markExecuting () {
    if (terminal()) return no('terminal')
    return phase === STATE.EXECUTING ? ok() : no('not_approved')
  }

  function finish (next, ts, why) {
    phase = next
    reason = why
    deadline = null
    decidedAt = ts
  }

  function reject ({ ts, reason: refusal = 'rejected' } = {}) {
    if (terminal()) return no('terminal')
    if (!awaitingApproval()) return no('already_approved')
    finish(STATE.REJECTED, ts, refusal)
    return ok()
  }

  function complete ({ ts, exitCode } = {}) {
    if (terminal()) return no('terminal')
    if (phase !== STATE.EXECUTING) return no('not_executing')
    const next = exitCode === 0 ? STATE.DONE : STATE.FAILED
    const why = next === STATE.DONE ? null : exitCode == null ? 'exit_unknown' : `exit_code:${exitCode}`
    finish(next, ts, why)
    return { state: next, reason: why }
  }

  function fail ({ ts, code } = {}) {
    if (terminal()) return no('terminal')
    if (!ERROR_CODES.includes(code)) return no('invalid_code')
    finish(STATE.FAILED, ts, code)
    return ok()
  }

  return Object.freeze({
    id, command, tabId, hostId, createdAt, trust,
    state, offer, approve, reject, markExecuting, complete, fail, settle, cancelCountdown,
  })
}
