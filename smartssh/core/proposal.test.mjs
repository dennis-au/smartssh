import assert from 'node:assert'
import { ERROR_CODES, TRUST } from './diagnostics.mjs'
import { GATE } from './gate.mjs'
import { createProposal, createIdFactory, STATE } from './proposal.mjs'
const r = []; const t = (n, f) => { try { f(); r.push(['PASS', n]) } catch (e) { r.push(['FAIL', n + ' :: ' + e.message]) } }
const nextId = createIdFactory()
const make = (trust = 'propose') => createProposal({ id: nextId(), command: 'pwd', tabId: 'tab', hostId: 'host', trust, ts: 10 })
const clean = { gate: GATE.CLEAN, reason: 'clean' }
const settling = { gate: GATE.SETTLING, reason: 'awaiting_echo' }

// ---- manual decisions ----
t('new proposal preserves metadata, defaults to pending and requires a gate', () => {
  const m = make()
  assert.deepStrictEqual([m.command, m.tabId, m.hostId, m.createdAt, m.trust], ['pwd', 'tab', 'host', 10, 'propose'])
  assert.deepStrictEqual(m.state(), {
    id: m.id, state: STATE.PENDING, gate: GATE.DIRTY, reason: 'prompt_dirty',
    origin: 'manual', countdownMs: null, decidedAt: null,
  })
  assert.strictEqual(m.approve({ ts: 11 }).ok, false)
  assert.ok(Object.isFrozen(STATE))
})
t('approve on clean is single-use and idempotent', () => {
  const m = make()
  m.offer(clean, 20)
  assert.strictEqual(m.approve({ ts: 21 }).ok, true)
  const approved = m.state()
  assert.strictEqual(approved.state, STATE.EXECUTING)
  assert.strictEqual(approved.decidedAt, 21)
  assert.strictEqual(approved.origin, 'manual')
  assert.strictEqual(m.approve({ ts: 22 }).ok, false)
  assert.deepStrictEqual(m.state(), approved)
})
t('auto-repeat does not consume the approval', () => {
  const m = make()
  m.offer(clean, 20)
  assert.strictEqual(m.approve({ ts: 21, eventRepeat: true }).ok, false)
  assert.strictEqual(m.state().state, STATE.PENDING)
  assert.strictEqual(m.approve({ ts: 22 }).ok, true)
})
t('uncertain gates require explicit manual override', () => {
  for (const reading of [settling, { gate: GATE.DIRTY, reason: 'token_untrusted' }, { gate: GATE.DIRTY, reason: 'token_empty' }]) {
    const m = make('readonly_auto')
    m.offer(reading, 20)
    const before = m.state()
    assert.deepStrictEqual(m.approve({ ts: 21 }), { ok: false, why: reading.reason })
    assert.deepStrictEqual(m.state(), before)
    assert.strictEqual(m.approve({ ts: 22, override: true }).ok, true)
    assert.strictEqual(m.state().origin, 'manual')
  }
})
t('hard refusals name the gate reason and do not mutate even with override', () => {
  const readings = [
    { gate: GATE.ALT, reason: 'alt_screen' }, { gate: GATE.CONT, reason: 'continuation' },
    ...['selection', 'scrolled', 'text_after_cursor', 'continuation'].map(reason => ({ gate: GATE.DIRTY, reason })),
  ]
  for (const reading of readings) {
    const m = make()
    m.offer(clean, 19)
    m.offer(reading, 20)
    const before = m.state()
    assert.deepStrictEqual(m.approve({ ts: 21, override: true }), { ok: false, why: reading.reason })
    assert.deepStrictEqual(m.state(), before)
  }
})
t('unknown gates fall back to prompt_dirty without allowing an override', () => {
  const m = make('readonly_auto')
  m.offer(clean, 20)
  assert.deepStrictEqual(m.offer({ gate: 'unknown', reason: 'token_empty' }, 21), { action: 'ask' })
  assert.strictEqual(m.state().gate, GATE.DIRTY)
  assert.strictEqual(m.state().state, STATE.PENDING)
  assert.strictEqual(m.approve({ ts: 22, override: true }).ok, false)
})

// ---- countdown and settlement ----
t('settling degrades without dropping the proposal; clean can start its countdown', () => {
  const m = make('readonly_auto')
  assert.deepStrictEqual(m.offer(settling, 20), { action: 'ask' })
  assert.strictEqual(m.state().state, STATE.PENDING)
  assert.strictEqual(m.settle({ ts: 2020 }).ok, false)
  assert.deepStrictEqual(m.offer(clean, 2021), { action: 'countdown', ms: 2000 })
  assert.strictEqual(m.state().state, STATE.COUNTING)
  assert.strictEqual(m.state().id, m.id)
})
t('off, watch, and propose only ask, even on clean', () => {
  for (const trust of TRUST.filter(value => value !== 'readonly_auto')) {
    const m = make(trust)
    assert.deepStrictEqual(m.offer(settling, 20), { action: 'ask' })
    assert.deepStrictEqual(m.offer(clean, 21), { action: 'ask' })
    assert.strictEqual(m.state().state, STATE.PENDING)
    assert.strictEqual(m.settle({ ts: 3000 }).ok, false)
  }
})
t('readonly_auto on clean counts down for 2000ms and authorizes once', () => {
  const m = make('readonly_auto')
  assert.deepStrictEqual(m.offer(clean, 20), { action: 'countdown', ms: 2000 })
  assert.strictEqual(m.state().countdownMs, 2000)
  assert.deepStrictEqual(m.offer(clean, 1020), { action: 'countdown', ms: 1000 })
  assert.strictEqual(m.settle({ ts: 2019 }).ok, false)
  assert.strictEqual(m.settle({ ts: 2020 }).ok, true)
  assert.deepStrictEqual(m.state(), {
    id: m.id, state: STATE.EXECUTING, gate: GATE.CLEAN, reason: 'clean',
    origin: 'auto', countdownMs: null, decidedAt: 2020,
  })
  assert.strictEqual(m.settle({ ts: 2021 }).ok, false)
  assert.strictEqual(m.approve({ ts: 2021 }).ok, false)
})
t('any non-clean gate cancels countdown; clean starts a fresh window', () => {
  for (const gate of Object.values(GATE).filter(value => value !== GATE.CLEAN)) {
    const m = make('readonly_auto')
    m.offer(clean, 20)
    assert.deepStrictEqual(m.offer({ gate }, 21), { action: 'ask' })
    assert.strictEqual(m.state().state, STATE.PENDING)
    assert.strictEqual(m.state().countdownMs, null)
    assert.strictEqual(m.settle({ ts: 2020 }).ok, false)
    assert.deepStrictEqual(m.offer(clean, 2021), { action: 'countdown', ms: 2000 })
    assert.strictEqual(m.settle({ ts: 4020 }).ok, false)
  }
})
for (const reason of ['keypress', 'same-tab proposal', 'disconnect']) {
  t(`${reason} cancels countdown without auto-rearming on a clean refresh`, () => {
    const m = make('readonly_auto')
    m.offer(clean, 20)
    assert.strictEqual(m.cancelCountdown({ ts: 21, reason }).ok, true)
    assert.strictEqual(m.state().state, STATE.PENDING)
    assert.strictEqual(m.state().countdownMs, null)
    assert.strictEqual(m.settle({ ts: 2020 }).ok, false)
    assert.deepStrictEqual(m.offer(clean, 2021), { action: 'ask' })
    assert.strictEqual(m.approve({ ts: 2022 }).ok, true)
    assert.strictEqual(m.state().origin, 'manual')
  })
}
t('manual approval during countdown preempts auto approval', () => {
  const m = make('readonly_auto')
  m.offer(clean, 20)
  assert.strictEqual(m.approve({ ts: 21 }).ok, true)
  assert.strictEqual(m.state().origin, 'manual')
  assert.strictEqual(m.settle({ ts: 2020 }).ok, false)
})

// ---- dispatch and terminal states ----
t('reject closes approval, records the reason, and clears countdown', () => {
  const m = make('readonly_auto')
  m.offer(clean, 20)
  assert.strictEqual(m.reject({ ts: 21, reason: 'user dismissed' }).ok, true)
  assert.strictEqual(m.state().state, STATE.REJECTED)
  assert.strictEqual(m.state().reason, 'user dismissed')
  assert.strictEqual(m.state().decidedAt, 21)
  assert.strictEqual(m.state().countdownMs, null)
  assert.strictEqual(m.approve({ ts: 22 }).ok, false)
})
t('markExecuting only acknowledges an authorized dispatch', () => {
  const m = make()
  assert.strictEqual(m.markExecuting({ ts: 20 }).ok, false)
  assert.strictEqual(m.complete({ ts: 20, exitCode: 0 }).ok, false)
  m.offer(clean, 21)
  m.approve({ ts: 22 })
  const before = m.state()
  assert.strictEqual(m.markExecuting({ ts: 23 }).ok, true)
  assert.deepStrictEqual(m.state(), before)
})
t('complete records success, nonzero exits, and unknown exits', () => {
  for (const [exitCode, state, reason] of [[0, STATE.DONE, null], [7, STATE.FAILED, 'exit_code:7'], [null, STATE.FAILED, 'exit_unknown']]) {
    const m = make()
    m.offer(clean, 20)
    m.approve({ ts: 21 })
    assert.deepStrictEqual(m.complete({ ts: 22, exitCode }), { state, reason })
    assert.strictEqual(m.state().state, state)
    assert.strictEqual(m.state().reason, reason)
    assert.strictEqual(m.state().decidedAt, 22)
  }
})
t('fail accepts the ten diagnostic codes and refuses unknown codes', () => {
  for (const code of ERROR_CODES) {
    const m = make()
    const before = m.state()
    assert.strictEqual(m.fail({ ts: 20, code: 'not_a_code' }).ok, false)
    assert.deepStrictEqual(m.state(), before)
    assert.strictEqual(m.fail({ ts: 21, code }).ok, true)
    assert.strictEqual(m.state().state, STATE.FAILED)
    assert.strictEqual(m.state().reason, code)
    assert.strictEqual(m.state().decidedAt, 21)
  }
})
for (const phase of [STATE.DONE, STATE.FAILED, STATE.REJECTED]) {
  t(`${phase} is terminal for every mutator`, () => {
    const m = make()
    m.offer(clean, 20)
    if (phase === STATE.DONE) {
      m.approve({ ts: 21 })
      m.complete({ ts: 22, exitCode: 0 })
    } else if (phase === STATE.FAILED) {
      m.fail({ ts: 22, code: 'dispatch_failed' })
    } else {
      m.reject({ ts: 22, reason: 'dismissed' })
    }
    const before = m.state()
    assert.strictEqual(before.state, phase)
    for (const [method, args] of [
      ['offer', [settling, 23]], ['approve', [{ ts: 23 }]], ['reject', [{ ts: 23 }]],
      ['markExecuting', [{ ts: 23 }]], ['complete', [{ ts: 23, exitCode: 0 }]],
      ['fail', [{ ts: 23, code: 'dispatch_failed' }]], ['settle', [{ ts: 23 }]],
      ['cancelCountdown', [{ ts: 23, reason: 'disconnect' }]],
    ]) {
      assert.deepStrictEqual(m[method](...args), { ok: false, why: 'terminal' }, method)
      assert.deepStrictEqual(m.state(), before, method)
    }
  })
}
t('one shared factory issues sms-n ids without reuse after a proposal closes', () => {
  const issue = createIdFactory()
  const first = createProposal({ id: issue(), ts: 10 })
  first.reject({ ts: 20 })
  const second = createProposal({ id: issue(), ts: 21 })
  assert.strictEqual(first.state().id, 'sms-1')
  assert.strictEqual(second.state().id, 'sms-2')
  const ids = [first.state().id, second.state().id, ...Array.from({ length: 100 }, () => issue())]
  assert.strictEqual(new Set(ids).size, ids.length)
})
for (const [s, n] of r) console.log(`${s}  ${n}`)
const f = r.filter(x => x[0] === 'FAIL').length
console.log(`\n${r.length - f}/${r.length} passed`)
process.exit(f ? 1 : 0)
