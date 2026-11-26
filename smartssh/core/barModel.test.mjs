import assert from 'node:assert'
import { barModel, stateFor, elementPolicy, mayEnter, transition, STATES, RISKS, REASONS } from './barModel.mjs'
import { GATE } from './gate.mjs'
const r = []; const t = (n, f) => { try { f(); r.push(['PASS', n]) } catch (e) { r.push(['FAIL', n + ' :: ' + e.message]) } }
const clean = { gate: GATE.CLEAN, reason: 'clean' }
const m = (o = {}) => barModel({ state: 'proposed', risk: 'write', gate: clean, autoRun: 'off', ...o })

t('nine states on the DOM, three risks', () => {
  assert.deepStrictEqual(STATES, ['proposed','counting','settling','executing','exited','rejected','aborted','expired','offline'])
  assert.strictEqual(RISKS.length, 3)
})
t('proposed + danger exposes confirm_code; write does not', () => {
  assert.ok(m({ risk: 'danger' }).controls.includes('confirm_code'))
  assert.ok(!m({ risk: 'write' }).controls.includes('confirm_code'))
  assert.ok(!m({ risk: 'read' }).controls.includes('confirm_code'))
})
t('ONLY proposed and counting can approve (stale-approval UI defence)', () => {
  const withApprove = STATES.filter(s => m({ state: s, cause: 'token' }).controls.includes('approve'))
  assert.deepStrictEqual(withApprove, ['proposed'])
})
t('rejected / aborted / expired offer dismiss + ask_again, never approve', () => {
  for (const s of ['rejected', 'aborted', 'expired']) {
    const c = m({ state: s }).controls
    assert.deepStrictEqual(c, ['dismiss', 'ask_again'], s)
  }
})
t('executing offers only ctrl_c', () => assert.deepStrictEqual(m({ state: 'executing' }).controls, ['ctrl_c']))
t('offline splits by cause: token resets, network retries, neither both', () => {
  assert.deepStrictEqual(m({ state: 'offline', cause: 'token' }).controls, ['reset_token', 'copy_diag', 'dismiss'])
  assert.deepStrictEqual(m({ state: 'offline', cause: 'network' }).controls, ['retry', 'copy_diag', 'dismiss'])
  assert.ok(!m({ state: 'offline', cause: 'token' }).controls.includes('retry'))
  assert.ok(!m({ state: 'offline', cause: 'network' }).controls.includes('reset_token'))
  assert.throws(() => m({ state: 'offline' }), /offline requires cause/)
})
t('counting offers run_now + cancel, and never approve', () => {
  const c = m({ state: 'counting' }).controls
  assert.deepStrictEqual(c, ['run_now', 'cancel'])
  assert.ok(!c.includes('approve'))
})
t('mayEnter: counting only from auto-run + clean gate', () => {
  assert.strictEqual(mayEnter('counting', { autoRun: 'on', gate: { gate: 'clean' } }), true)
  assert.strictEqual(mayEnter('counting', { autoRun: 'off', gate: { gate: 'clean' } }), false)
  assert.strictEqual(mayEnter('counting', { autoRun: 'on', gate: { gate: 'prompt_dirty' } }), false)
  assert.strictEqual(mayEnter('proposed', {}), true)
})
t('transition: manual approve skips the countdown, auto-run goes through it', () => {
  assert.strictEqual(transition('proposed', 'approve', { autoRun: 'off', gate: { gate: 'clean' } }), 'executing')
  assert.strictEqual(transition('proposed', 'approve', { autoRun: 'on', gate: { gate: 'clean' } }), 'counting')
  assert.strictEqual(transition('proposed', 'approve', { autoRun: 'on', gate: { gate: 'prompt_dirty' } }), 'executing')
})
t('transition: run_now is idempotent and never returns to counting', () => {
  const s1 = transition('counting', 'run_now', {})
  assert.strictEqual(s1, 'executing')
  // a second press cannot re-enter the countdown, it is simply not an action of `executing`
  assert.throws(() => transition(s1, 'run_now', {}), /not available/)
})
t('v30 cause split holds in TRANSITION, not only in render', () => {
  assert.throws(() => transition('offline', 'retry', { cause: 'token' }), /not a remedy for cause=token/)
  assert.throws(() => transition('offline', 'reset_token', { cause: 'network' }), /not a remedy for cause=network/)
  assert.strictEqual(transition('offline', 'retry', { cause: 'network' }), 'offline')
  assert.strictEqual(transition('offline', 'reset_token', { cause: 'token' }), 'offline')
})
t('offline transition without a cause throws for every action', () => {
  for (const a of ['retry', 'reset_token', 'copy_diag', 'dismiss']) {
    assert.throws(() => transition('offline', a, {}), /requires cause/, a)
  }
  assert.strictEqual(transition('offline', 'copy_diag', { cause: 'token' }), 'offline')
  assert.strictEqual(transition('offline', 'copy_diag', { cause: 'network' }), 'offline')
})
t('transition: illegal actions throw instead of silently doing nothing', () => {
  assert.throws(() => transition('rejected', 'approve', {}), /not available/)
  assert.throws(() => transition('offline', 'approve', {}), /not available/)
  assert.throws(() => transition('executing', 'dismiss', {}), /not available/)
})
t('transition: dismiss and ask_again both leave the element hidden', () => {
  for (const s of ['exited', 'rejected', 'aborted', 'expired']) assert.strictEqual(transition(s, 'dismiss', {}), 'hidden', s)
  for (const s of ['rejected', 'aborted', 'expired']) assert.strictEqual(transition(s, 'ask_again', {}), 'hidden', s)
  assert.strictEqual(transition('executing', 'ctrl_c', {}), 'aborted')
})
t('attrs: ten reasons, empty when clean', () => {
  assert.strictEqual(REASONS.length, 10)
  assert.strictEqual(m({ gate: clean }).attrs['data-gate-reason'], '')
  assert.strictEqual(m({ gate: { gate: 'prompt_dirty', reason: 'scrolled' } }).attrs['data-gate-reason'], 'scrolled')
})
t('unknown gate collapses to prompt_dirty, never a sixth value', () => {
  const a = m({ gate: { gate: 'unknown', reason: 'whatever' } }).attrs
  assert.strictEqual(a['data-gate'], 'prompt_dirty')
  assert.strictEqual(a['data-gate-reason'], 'prompt_dirty')
})
t('exit code: 0 / nonzero / null', () => {
  assert.strictEqual(m({ state: 'exited', exitCode: 0 }).attrs['data-exit-code'], '0')
  assert.strictEqual(m({ state: 'exited', exitCode: 1 }).attrs['data-exit-code'], 'nonzero')
  assert.strictEqual(m({ state: 'exited', exitCode: null }).attrs['data-exit-code'], 'null')
  assert.strictEqual(m({ state: 'proposed' }).attrs['data-exit-code'], '')
})
t('auto-run and viewport are never undefined', () => {
  const a = m().attrs
  assert.strictEqual(a['data-auto-run'], 'off')
  assert.strictEqual(a['data-viewport'], 'ok')
  for (const v of Object.values(a)) assert.notStrictEqual(v, undefined)
})
t('bad inputs throw instead of rendering a half-bar', () => {
  assert.throws(() => m({ state: 'idle' }), /unknown state/)
  assert.throws(() => m({ risk: 'extreme' }), /unknown risk/)
})
t('lifecycle mapping is total and explicit', () => {
  const events = ['proposal','countdown','feed','settle','exit','reject','dispatch_failed','expire','token_lost']
  const states = events.map(stateFor)
  assert.deepStrictEqual(states, ['proposed','counting','executing','settling','exited','rejected','aborted','expired','offline'])
  assert.throws(() => stateFor('wat'), /unknown bar event/)
})
t('lazy mount, never unmount', () => {
  assert.strictEqual(elementPolicy('proposed', false), 'absent')       // never had a proposal
  assert.strictEqual(elementPolicy('proposed', true), 'mounted-open')
  for (const s of ['exited','rejected','aborted','expired']) {
    assert.strictEqual(elementPolicy(s, true), 'mounted-collapsed', s)
  }
  assert.strictEqual(elementPolicy('executing', true), 'mounted-open')
  assert.strictEqual(elementPolicy('offline', true), 'mounted-open')
})
for (const [s, n] of r) console.log(`${s}  ${n}`)
const f = r.filter(x => x[0] === 'FAIL').length
console.log(`\n${r.length - f}/${r.length} passed`)
process.exit(f ? 1 : 0)
