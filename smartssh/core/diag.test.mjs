import assert from 'node:assert'
import { buildDiagnostics, DIAG_KEYS, TRUST, GATE, ERROR_CODES, TRANSPORT_TIMEOUT_EVENT, toErrorCode } from './diagnostics.mjs'
const r = []; const t = (n, f) => { try { f(); r.push(['PASS', n]) } catch (e) { r.push(['FAIL', n + ' :: ' + e.message]) } }
const H = 'a'.repeat(64); const V = '1.0.238 · sms.42 · 54869e1'
const o = (x) => JSON.parse(buildDiagnostics(x))

// ---- SPEC OF RECORD: producer -> code, every row ----
t('SPEC: all 15 producer rows map exactly', () => {
  const rows = [
    [{ status: 401 }, 'token_invalid'],
    [{ status: 409 }, 'stale_approval'],
    [{ status: 410 }, 'proposal_dead'],
    [{ status: 413 }, 'truncation_refused'],
    [{ status: 422 }, 'confirm_mismatch'],
    [{ status: 429 }, 'rate_limited'],
    [{ status: 500 }, 'server_error'],
    [{ status: 503 }, 'server_error'],
    [{ type: 'dispatch_failed' }, 'dispatch_failed'],
    [{ type: 'aborted', reason: 'dispatch_timeout' }, 'dispatch_timeout'],
    [{ type: 'aborted', reason: 'session_replaced' }, 'session_replaced'],
    [{ type: TRANSPORT_TIMEOUT_EVENT }, 'transport_unknown'],
    [{ status: 200, replay: true }, null],
    [{ type: 'command.exit', exit_code: null }, null],
    [{ type: 'command.exit', exit_code: 1 }, null],
  ]
  for (const [input, want] of rows) assert.strictEqual(toErrorCode(input), want, JSON.stringify(input))
})
t('SPEC: exactly eleven codes, nothing outside the set', () => {
  assert.deepStrictEqual(ERROR_CODES, [
    'token_invalid', 'stale_approval', 'proposal_dead', 'truncation_refused', 'rate_limited',
    'server_error', 'dispatch_failed', 'dispatch_timeout', 'session_replaced', 'transport_unknown',
    'confirm_mismatch',
  ])
  for (const c of ERROR_CODES) assert.strictEqual(toErrorCode(c), c)
  for (const bad of ['exit_unknown', 'idempotent_replay', 'aborted:dispatch_timeout', 'exit_code:null', 'nope', 'mismatch']) {
    assert.strictEqual(toErrorCode(bad), null, bad)
  }
})
t('SPEC: 5xx and 429 are different codes (wait vs look at relay)', () => {
  assert.notStrictEqual(toErrorCode({ status: 500 }), toErrorCode({ status: 429 }))
})
t('SPEC: 4xx not in the table is not an error code', () => {
  for (const s of [400, 404, 405]) assert.strictEqual(toErrorCode({ status: s }), null, String(s))
})

t('SPEC: both legacy transport timeout shapes are rejected', () => {
  assert.strictEqual(TRANSPORT_TIMEOUT_EVENT, 'transport_timeout')
  assert.strictEqual(toErrorCode({ type: 'timeout' }), null)
  assert.strictEqual(toErrorCode({ status: 'unknown' }), null)
})

// ---- payload shape ----
t('keys are exactly the five', () => assert.deepStrictEqual(Object.keys(o({ version: V, sha256: H })).sort(), [...DIAG_KEYS].sort()))
t('LEAK-A free-text error carrying a token is dropped', () => {
  const s = buildDiagnostics({ errors: [('relay 401 token=' + 'ghp' + '_CANARY123')] })
  assert.ok(!s.includes('ghp' + '_') && !s.includes('CANARY'), s)
  assert.deepStrictEqual(o({ errors: [('relay 401 token=' + 'ghp' + '_CANARY123')] }).errors, [])
})
t('LEAK-B credential inside trust is dropped (enum)', () => {
  const s = buildDiagnostics({ trust: 'auto@https://user:pw@relay' })
  assert.strictEqual(o({ trust: 'auto@https://user:pw@relay' }).trust, 'off'); assert.ok(!s.includes('pw@'))
})
t('LEAK-C gate with a token canary is dropped (enum)', () => {
  const s = buildDiagnostics({ gate: ('scrolled token=' + 'sk' + '-CANARY999') })
  assert.strictEqual(o({ gate: ('scrolled token=' + 'sk' + '-CANARY999') }).gate, 'prompt_dirty'); assert.ok(!s.includes('sk' + '-'))
})
t('extra properties never survive', () => {
  const s = buildDiagnostics({ version: V, token: ('ghp' + '_X'), scrollback: ('export K=' + 'sk' + '-Y'), env: { PASSWORD: 'hunter2' } })
  for (const c of [('ghp' + '_X'), ('sk' + '-Y'), 'hunter2', 'PASSWORD']) assert.ok(!s.includes(c), c)
})
t('v16 ring buffer: last 3 distinct, dedupe keeps LAST position, oldest -> newest', () => {
  const got = o({ errors: [{ status: 401 }, { status: 401 }, { type: 'aborted', reason: 'dispatch_timeout' }, { status: 429 }, { status: 500 }] }).errors
  assert.deepStrictEqual(got, ['dispatch_timeout', 'rate_limited', 'server_error'])
})
t('v16 ring buffer: a repeat moves the code to the end (last element = newest)', () => {
  const got = o({ errors: [{ status: 401 }, { status: 409 }, { status: 401 }] }).errors
  assert.deepStrictEqual(got, ['stale_approval', 'token_invalid'])
})
t('v16 ring buffer: caps at 3', () => {
  const got = o({ errors: [{ status: 401 }, { status: 409 }, { status: 410 }, { status: 429 }] }).errors
  assert.deepStrictEqual(got, ['stale_approval', 'proposal_dead', 'rate_limited'])
})
t('v16 ring buffer: a repeat refreshes recency before eviction; unmapped events are ignored', () => {
  const [A, B, C, D] = ERROR_CODES
  const errors = [A, B, C, { type: 'timeout' }, { status: 403 }, D, { status: 200 }]
  assert.deepStrictEqual(o({ errors }).errors, [C, A, D])
})
t('v16: 403 collapses into token_invalid (same remedy as 401)', () => {
  assert.strictEqual(toErrorCode({ status: 403 }), 'token_invalid')
  assert.strictEqual(toErrorCode({ status: 401 }), 'token_invalid')
})
t('trust four values, gate five values, fallbacks off/prompt_dirty', () => {
  assert.strictEqual(TRUST.length, 4); assert.strictEqual(GATE.length, 5)
  assert.strictEqual(o({ trust: 'readonly-auto' }).trust, 'off')
  assert.strictEqual(o({ gate: 'unknown' }).gate, 'prompt_dirty')
  assert.strictEqual(o({}).gate, 'prompt_dirty')
})
t('version: three-part only, else dev', () => {
  assert.strictEqual(o({ version: V }).version, V)
  for (const bad of ['1.0.238-sms1', 'v1.0.238', '1.0.238', '']) assert.strictEqual(o({ version: bad }).version, 'dev', bad)
})
t('sha256: 64 hex upper, else dev label', () => {
  assert.strictEqual(o({ sha256: H }).sha256, H.toUpperCase())
  assert.strictEqual(o({ sha256: 'deadbeef' }).sha256, 'unpacked/dev build')
})
t('dev payload contains no 64-hex anywhere', () => {
  assert.strictEqual(/([0-9a-fA-F]{64})/.test(buildDiagnostics({ version: 'dev', sha256: 'nope' })), false)
})
t('payload stays small (guard, not a tripwire)', () => {
  const s = buildDiagnostics({ version: V, sha256: H, trust: 'readonly_auto', gate: 'clean', errors: ERROR_CODES })
  assert.ok(Buffer.byteLength(s) < 512, 'bytes=' + Buffer.byteLength(s))
})
for (const [s, n] of r) console.log(`${s}  ${n}`)
const f = r.filter(x => x[0] === 'FAIL').length
console.log(`\n${r.length - f}/${r.length} passed`)
process.exit(f ? 1 : 0)
