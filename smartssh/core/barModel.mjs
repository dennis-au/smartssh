// contract: v47
// barModel.mjs — the bar's data-* attributes, which controls exist, and the only legal transitions.
// Nothing here renders: it is the contract the DOM must express (v19 DOM, v26 states, v29 counting
// rules, v30 offline causes). A pure model makes "this state has no approve control" a unit test
// instead of a review comment: a control that does not exist cannot be pressed.
import { GATE } from './gate.mjs'

export const STATES = ['proposed', 'counting', 'settling', 'executing', 'exited', 'rejected', 'aborted', 'expired', 'offline']
export const RISKS = ['read', 'write', 'danger']
export const CAUSES = ['token', 'network']
export const REASONS = [
  'alt_screen', 'selection', 'scrolled', 'token_empty', 'token_untrusted', 'typed_input',
  'continuation', 'awaiting_echo', 'output_active', 'no_prompt_line',
]

// Which controls may exist per state. Anything not listed must be absent from the DOM.
// 'run_now' is deliberately NOT 'approve': the countdown path must never be wired into the
// approve path, or one double click feeds the command twice.
const CONTROLS = {
  proposed: ['approve', 'reject', 'expand', 'confirm_code'], // confirm_code only when risk === 'danger'
  counting: ['run_now', 'cancel'],
  settling: ['cancel'],
  executing: ['ctrl_c'],
  exited: ['dismiss'],
  rejected: ['dismiss', 'ask_again'],
  aborted: ['dismiss', 'ask_again'],
  expired: ['dismiss', 'ask_again'],
  offline: [], // resolved by cause, see OFFLINE_CONTROLS
}
// v30: one cause, one remedy. Retrying an expired token loops on 401; resetting a token because
// the network dropped makes the user do something unrelated to their problem.
const OFFLINE_CONTROLS = {
  token: ['reset_token', 'copy_diag', 'dismiss'],
  network: ['retry', 'copy_diag', 'dismiss'],
}

export function stateFor (event) {
  switch (event) {
    case 'proposal': return 'proposed'
    case 'countdown': return 'counting'
    case 'feed': return 'executing'
    case 'settle': return 'settling'
    case 'exit': return 'exited'
    case 'reject': return 'rejected'
    case 'dispatch_failed': return 'aborted'
    case 'expire': return 'expired'
    case 'token_lost': return 'offline'
    default: throw new Error(`unknown bar event: ${event}`)
  }
}

/** Only read-tier auto-run may enter `counting`. */
export function mayEnter (state, ctx = {}) {
  if (!STATES.includes(state)) throw new Error(`unknown state: ${state}`)
  if (state !== 'counting') return true
  return ctx.autoRun === 'on' && ctx.gate?.gate === GATE.CLEAN && ctx.risk === 'read'
}

const NEXT = {
  'proposed:approve': ctx => {
    if (ctx?.risk === 'danger') throw new Error('danger requires confirm_code, not approve')
    return (ctx?.autoRun === 'on' && ctx?.gate?.gate === GATE.CLEAN && ctx?.risk === 'read') ? 'counting' : 'executing'
  },
  'proposed:reject': () => 'rejected',
  // Expanding is a view action; it leaves the proposal state unchanged.
  'proposed:expand': () => 'proposed',
  // A danger confirmation bypasses the countdown and fails loudly on invalid input.
  'proposed:confirm_code': ctx => {
    if (ctx?.risk !== 'danger') throw new Error('confirm_code requires risk=danger')
    if (ctx?.gate?.gate !== 'clean') throw new Error('confirm_code requires a clean prompt')
    const attempts = ctx?.proposal?.attempts
    if (Number.isInteger(attempts) && attempts >= 3) throw new Error('proposal is dead: too many attempts')
    const expected = ctx?.proposal?.confirm_expected
    if (typeof expected !== 'string' || expected.length === 0) throw new Error('proposal has no confirm_expected')
    if (typeof ctx?.code !== 'string' || ctx.code !== expected) throw new Error('confirm_code mismatch')
    return 'executing'
  },
  // idempotent: running now only zeroes the countdown, it is not a second approval
  'counting:run_now': ctx => {
    if (ctx?.risk !== 'read') throw new Error('run_now is read-tier only')
    return 'executing'
  },
  'counting:cancel': () => 'proposed',
  'settling:cancel': () => 'proposed',
  'executing:ctrl_c': () => 'aborted',
  'exited:dismiss': () => 'hidden',
  'rejected:dismiss': () => 'hidden',
  'rejected:ask_again': () => 'hidden',
  'aborted:dismiss': () => 'hidden',
  'aborted:ask_again': () => 'hidden',
  'expired:dismiss': () => 'hidden',
  'expired:ask_again': () => 'hidden',
  // v30 is a TRANSITION contract, not just a render contract: the keyboard path and the
  // reconnect handler go through here, so a remedy must be refused for the wrong cause too.
  'offline:reset_token': ctx => { requireCause(ctx, 'token', 'reset_token'); return 'offline' },
  'offline:retry': ctx => { requireCause(ctx, 'network', 'retry'); return 'offline' },
  'offline:copy_diag': ctx => { requireCause(ctx); return 'offline' },
  'offline:dismiss': ctx => { requireCause(ctx); return 'hidden' },
}

function requireCause (ctx, expected, action) {
  if (!CAUSES.includes(ctx?.cause)) throw new Error(`offline action ${action ?? ''} requires cause token|network`.trim())
  if (expected && ctx.cause !== expected) throw new Error(`${action} is not a remedy for cause=${ctx.cause}`)
}

export function transition (state, action, ctx = {}) {
  if (!STATES.includes(state)) throw new Error(`unknown state: ${state}`)
  const fn = NEXT[`${state}:${action}`]
  if (!fn) throw new Error(`action ${action} is not available in state ${state}`)
  const next = fn(ctx)
  if (next !== 'hidden' && !mayEnter(next, ctx)) throw new Error(`entry to ${next} refused by mayEnter`)
  return next
}

/**
 * @param {object} p
 * @param {string} p.state        one of STATES
 * @param {string} p.risk         read|write|danger
 * @param {object} p.gate         {gate, reason} from isAtPrompt()
 * @param {'on'|'off'} p.autoRun
 * @param {'ok'|'too_narrow'} [p.viewport]
 * @param {'token'|'network'} [p.cause]  required when state === 'offline'
 * @param {number|null} [p.exitCode]
 */
export function barModel (p) {
  const state = String(p.state ?? '')
  if (!STATES.includes(state)) throw new Error(`unknown state: ${state}`)
  const risk = String(p.risk ?? '')
  if (!RISKS.includes(risk)) throw new Error(`unknown risk: ${risk}`)

  let cause = ''
  let controls
  if (state === 'offline') {
    cause = String(p.cause ?? '')
    if (!CAUSES.includes(cause)) throw new Error(`offline requires cause token|network, got: ${cause}`)
    controls = OFFLINE_CONTROLS[cause]
  } else {
    controls = CONTROLS[state].filter(c => c !== 'confirm_code' || risk === 'danger')
  }

  const gate = p.gate?.gate ?? GATE.DIRTY
  const reason = p.gate?.reason ?? 'prompt_dirty'
  const gateValue = ['clean', 'prompt_dirty', 'settling', 'alt_screen', 'continuation'].includes(gate) ? gate : 'prompt_dirty'
  const reasonValue = gateValue === 'clean' ? '' : (REASONS.includes(reason) ? reason : 'prompt_dirty')

  let exit = ''
  if (state === 'exited') {
    if (p.exitCode === null || p.exitCode === undefined) exit = 'null'
    else exit = p.exitCode === 0 ? '0' : 'nonzero'
  }

  return {
    mounted: true,
    attrs: {
      'data-state': state,
      'data-risk': risk,
      'data-gate': gateValue,
      'data-gate-reason': reasonValue,
      'data-auto-run': p.autoRun === 'on' ? 'on' : 'off',
      'data-viewport': p.viewport === 'too_narrow' ? 'too_narrow' : 'ok',
      'data-cause': cause,
      'data-exit-code': exit,
    },
    controls,
  }
}

/** Lazy mount, never unmount: no proposal at all => no element; terminal => height 0, still present. */
export function elementPolicy (state, everHadProposal) {
  if (!everHadProposal) return 'absent'
  if (['exited', 'rejected', 'aborted', 'expired'].includes(state)) return 'mounted-collapsed'
  return 'mounted-open'
}
