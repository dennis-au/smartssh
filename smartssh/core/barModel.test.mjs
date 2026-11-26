import assert from 'node:assert'
import { barModel, stateFor, elementPolicy, mayEnter, transition, STATES, RISKS, REASONS, CAUSES } from './barModel.mjs'
import { GATE } from './gate.mjs'
const r = []; const t = (n, f) => { try { f(); r.push(['PASS', n]) } catch (e) { r.push(['FAIL', n + ' :: ' + e.message]) } }
const clean = { gate: GATE.CLEAN, reason: 'clean' }
const m = (o = {}) => barModel({ state: 'proposed', risk: 'write', gate: clean, autoRun: 'off', ...o })
const autoCtx = { autoRun: 'on', gate: clean }
const confirmCtx = { ...autoCtx, risk: 'danger', code: '4218', proposal: { confirm_expected: '4218' } }

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
t('mayEnter: counting only for read risk with auto-run + clean gate', () => {
  assert.strictEqual(mayEnter('counting', { ...autoCtx, risk: 'read' }), true)
  assert.strictEqual(mayEnter('counting', { ...autoCtx, risk: 'read', autoRun: 'off' }), false)
  assert.strictEqual(mayEnter('counting', { ...autoCtx, risk: 'read', gate: { gate: 'prompt_dirty' } }), false)
  assert.strictEqual(mayEnter('counting', { ...autoCtx, risk: 'write' }), false)
  assert.strictEqual(mayEnter('counting', { ...autoCtx, risk: 'danger' }), false)
  assert.strictEqual(mayEnter('proposed', {}), true)
})
t('transition: plain approve refuses danger and counts down only for clean read auto-run', () => {
  assert.throws(() => transition('proposed', 'approve', { ...autoCtx, risk: 'danger' }), /danger requires confirm_code, not approve/)
  assert.strictEqual(transition('proposed', 'approve', { ...autoCtx, risk: 'read', autoRun: 'off' }), 'executing')
  assert.strictEqual(transition('proposed', 'approve', { ...autoCtx, risk: 'read' }), 'counting')
  assert.strictEqual(transition('proposed', 'approve', { ...autoCtx, risk: 'write' }), 'executing')
  assert.strictEqual(transition('proposed', 'approve', { ...autoCtx, risk: 'read', gate: { gate: 'prompt_dirty' } }), 'executing')
})
t('rendered controls have working transitions except for tier-guarded actions', () => {
  for (const state of STATES) {
    for (const cause of state === 'offline' ? CAUSES : ['token']) {
      for (const risk of RISKS) {
        const ctx = { ...confirmCtx, cause, risk }
        for (const control of barModel({ ...ctx, state }).controls) {
          const run = () => transition(state, control, ctx)
          const label = `${state}:${control} (${cause}, ${risk})`
          if (state === 'proposed' && control === 'approve' && risk === 'danger') {
            assert.throws(run, /danger requires confirm_code, not approve/, label)
          } else if (state === 'counting' && control === 'run_now' && risk !== 'read') {
            assert.throws(run, /read-tier only/, label)
          } else {
            assert.doesNotThrow(run, label)
          }
        }
      }
    }
  }
})
t('transition: expand leaves the proposal state unchanged', () => {
  assert.strictEqual(transition('proposed', 'expand'), 'proposed')
})
t('transition: confirm_code goes straight to executing even with auto-run on', () => {
  assert.strictEqual(transition('proposed', 'confirm_code', confirmCtx), 'executing')
})
t('transition: confirm_code rejects mismatched codes, non-danger risk, and dirty prompts', () => {
  assert.throws(() => transition('proposed', 'confirm_code', { ...confirmCtx, code: '0000' }), /confirm_code mismatch/)
  assert.throws(() => transition('proposed', 'confirm_code', { ...confirmCtx, risk: 'write' }), /confirm_code requires risk=danger/)
  assert.throws(() => transition('proposed', 'confirm_code', { ...confirmCtx, gate: { gate: 'prompt_dirty' } }), /confirm_code requires a clean prompt/)
})
t('transition: confirm_code requires a nonempty expected code from the proposal', () => {
  for (const proposal of [undefined, {}, { confirm_expected: '' }, { confirm_expected: 4218 }]) {
    assert.throws(() => transition('proposed', 'confirm_code', { ...confirmCtx, proposal }), /proposal has no confirm_expected/)
  }
})
t('transition: confirm_code rejects a dead proposal even with the correct code', () => {
  const proposal = { ...confirmCtx.proposal, attempts: 3 }
  assert.throws(() => transition('proposed', 'confirm_code', { ...confirmCtx, proposal }), /proposal is dead/)
})
t('transition: a mismatch at two server attempts does not consume another attempt locally', () => {
  const proposal = Object.freeze({ ...confirmCtx.proposal, attempts: 2 })
  assert.throws(() => transition('proposed', 'confirm_code', { ...confirmCtx, proposal, code: '0000' }), /confirm_code mismatch/)
  assert.strictEqual(transition('proposed', 'confirm_code', { ...confirmCtx, proposal }), 'executing')
})
t('transition: run_now is idempotent and never returns to counting', () => {
  assert.throws(() => transition('counting', 'run_now', { risk: 'write' }), /read-tier only/)
  const s1 = transition('counting', 'run_now', { risk: 'read' })
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
