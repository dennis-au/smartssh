import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { createStore } from './state.mjs'

const TOKEN = 'relay-http-test-token'
process.env.RELAY_TOKEN = TOKEN
delete process.env.RELAY_DEV
const { createRelay } = await import('./server.mjs')

const CONTEXT = '/v1/context.push'
const PROPOSAL = '/v1/proposal'
const DISPATCH = '/v1/command.dispatch'
const ids = { tab_id: 'tab-1', session_id: 'session-1' }
const canary = 'CANARY-not-for-storage'
const push = { ...ids, host: 'example.test', cwd: '/', exit_code: 0, invisible_escalation: 0,
  text: `echo hi\n${canary}`, line_count: 2, truncated_lines: 30, redacted_segments: 0,
  masks: [], severity: 'none', range: { fromLine: 31, toLine: 32, at: '2026-11-26T14:21:00Z' } }
const kept = { line_count: 2, truncated_lines: 30, redacted_segments: 0, severity: 'none', range: { fromLine: 31, toLine: 32 } }

function client (port) {
  return async (path, { method = 'POST', json, raw, headers, signal = AbortSignal.timeout(5000) } = {}) => {
    const requestHeaders = new Headers({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' })
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (value === undefined) requestHeaders.delete(name)
      else requestHeaders.set(name, value)
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: requestHeaders, body: raw ?? JSON.stringify(json), signal,
    })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
}

async function start (t, store = createStore()) {
  const server = createRelay({ store })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  return { request: client(server.address().port), store }
}

function expectError (response, status, code, fields = {}) {
  assert.equal(response.status, status)
  assert.equal(typeof response.body.message, 'string')
  assert.ok(response.body.message.length > 0)
  assert.deepEqual(response.body, { error: code, message: response.body.message, ...fields })
}
const expectDead = response => expectError(response, 410, 'proposal_dead', { attempts_left: 0 })
const expectMismatch = (response, attempts_left) => expectError(response, 422, 'confirm_mismatch', { attempts_left })

function propose (request, risk = 'read', extras = {}) {
  return request(PROPOSAL, { json: { ...ids, risk, command: 'echo hello', ...extras } })
}
async function create (request, risk, extras) {
  const response = await propose(request, risk, extras)
  assert.equal(response.status, 200)
  return response.body
}
function dispatch (request, proposal_id, key, extra = {}, headers = {}) {
  return request(DISPATCH, { json: { ...ids, proposal_id, command_id: key, ...extra }, headers: { 'Idempotency-Key': key, ...headers } })
}
const lookup = (request, id) => request(`${PROPOSAL}/${id}`, { method: 'GET' })
const reject = (request, id, json = { reason: 'user_rejected', ts: 100 }) => request(`${PROPOSAL}/${id}/reject`, { json })
const wrongCode = expected => expected === '0000' ? '0001' : '0000'
function expectReplay (response, command_id) {
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Idempotent-Replay'), 'true')
  assert.deepEqual(response.body, { status: 'executing', command_id, replay: true })
}

test('context push requires the configured token and retains only metadata', async t => {
  const { request, store } = await start(t)
  for (const Authorization of [undefined, 'Bearer wrong']) {
    expectError(await request(CONTEXT, { json: push, headers: { Authorization } }), 401, 'token_invalid')
  }
  assert.equal(store.contexts.size, 0)
  const { status, body } = await request(CONTEXT, { json: push })
  assert.equal(status, 200)
  assert.deepEqual(body, { session_id: ids.session_id, received: { ...kept, server_dropped_lines: 0 }, warnings: [] })
  assert.deepEqual([...store.contexts.values()], [{ ...ids, ...kept, at: push.range.at }])
})

test('context push rejects inconsistent text counts and ranges, even for oversized windows', async t => {
  const { request, store } = await start(t)
  for (const changes of [{ text: undefined }, { line_count: 201, range: { fromLine: 31, toLine: 231 } },
    { range: { fromLine: 1, toLine: 3 } }, { text: 'x\ny\n' }, { range: { fromLine: 0, toLine: 1 } }]) {
    expectError(await request(CONTEXT, { json: { ...push, ...changes } }), 400, 'bad_request')
  }
  assert.equal(store.contexts.size, 0)
})

test('context push rejects segment count mismatches and negative truncation counts', async t => {
  const { request } = await start(t)
  for (const changes of [{ redacted_segments: 1 }, { masks: undefined }, { truncated_lines: -1 }]) {
    expectError(await request(CONTEXT, { json: { ...push, ...changes } }), 400, 'bad_request')
  }
})

test('only danger proposals disclose a server-generated four-digit challenge', async t => {
  const { request } = await start(t, createStore({ now: () => 100 }))
  for (const risk of ['read', 'write', 'danger']) {
    const body = await create(request, risk, { confirm_expected: 'client-value', attempts: 3, expires_at: 0 })
    const { proposal_id, confirm_expected } = body
    assert.match(proposal_id, /^[0-9a-f-]{36}$/)
    if (risk === 'danger') assert.match(confirm_expected, /^\d{4}$/)
    assert.deepEqual(body, { proposal_id, risk, expires_at: 120100, ...(risk === 'danger' ? { confirm_expected } : {}) })
    const response = await lookup(request, proposal_id)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { proposal_id, status: 'proposed', rejection_reason: null, attempts_left: 3, expires_at: 120100 })
  }
  expectError(await propose(request, 'unknown'), 400, 'bad_request')
  for (const command of ['', ' ', 'x'.repeat(4097)]) expectError(await propose(request, 'read', { command }), 400, 'bad_request')
  await create(request, 'read', { command: 'x'.repeat(4096) })
})

test('danger mismatches ignore client attempts: 0 and kill the proposal after three', async t => {
  const { request, store } = await start(t)
  const { proposal_id, confirm_expected } = await create(request, 'danger')
  const send = confirm => dispatch(request, proposal_id, 'same-key', { confirm, attempts: 0 })
  for (const remaining of [2, 1, 0]) expectMismatch(await send(wrongCode(confirm_expected)), remaining)
  expectDead(await send(confirm_expected))
  expectDead(await lookup(request, proposal_id))
  expectDead(await reject(request, proposal_id))
  assert.equal(store.dispatchCount, 0)
})

test('correct danger code with spaces transitions to executing on the first attempt', async t => {
  const { request, store } = await start(t)
  const { proposal_id, confirm_expected } = await create(request, 'danger')
  const { status, body } = await dispatch(request, proposal_id, 'first', { confirm: confirm_expected.split('').join(' ') })
  assert.equal(status, 200)
  assert.ok(Number.isInteger(body.started_at))
  assert.deepEqual(body, { status: 'executing', proposal_id, command_id: 'first', started_at: body.started_at })
  const current = await lookup(request, proposal_id)
  assert.equal(current.body.status, 'executing')
  assert.equal(current.body.attempts_left, 3)
  assert.ok(!Object.hasOwn(current.body, 'confirm_expected'))
  assert.equal(store.dispatchCount, 1)
})

test('same key replays without confirmation and creates only one execution', async t => {
  const { request, store } = await start(t, createStore({ now: () => 100 }))
  const { proposal_id, confirm_expected } = await create(request, 'danger')
  const first = await dispatch(request, proposal_id, 'repeat', { confirm: confirm_expected })
  assert.equal(first.status, 200)
  assert.deepEqual(first.body, { status: 'executing', started_at: 100, proposal_id, command_id: 'repeat' })
  assert.equal(first.headers.get('Idempotent-Replay'), null)
  expectReplay(await dispatch(request, proposal_id, 'repeat'), 'repeat')
  assert.equal(store.dispatchCount, 1)
})

test('a different key after dispatch is stale', async t => {
  const { request, store } = await start(t)
  const { proposal_id } = await create(request)
  assert.equal((await dispatch(request, proposal_id, 'first')).status, 200)
  expectError(await dispatch(request, proposal_id, 'different'), 409, 'stale_approval')
  assert.equal(store.dispatchCount, 1)
})

test('Idempotency-Key header is required; the body cannot supply or override it', async t => {
  const { request } = await start(t)
  const { proposal_id } = await create(request)
  expectError(await dispatch(request, proposal_id, 'key', { idempotency_key: 'key' }, { 'Idempotency-Key': undefined }), 400, 'missing_idempotency_key')
  assert.equal((await dispatch(request, proposal_id, 'key')).status, 200)
  expectReplay(await dispatch(request, proposal_id, 'key', { idempotency_key: 'ignored' }), 'key')
})

test('expired and unknown proposals cannot be dispatched, retrieved or rejected', async t => {
  let clock = 100
  const { request, store } = await start(t, createStore({ now: () => clock }))
  const { proposal_id, expires_at } = await create(request)
  clock = expires_at + 1
  for (const id of [proposal_id, 'not-found']) {
    expectDead(await dispatch(request, id, 'attempt'))
    expectDead(await lookup(request, id))
    expectDead(await reject(request, id))
  }
  assert.equal(store.dispatchCount, 0)
})

test('replay works at the TTL boundary but not after it', async t => {
  let clock = 100
  const { request } = await start(t, createStore({ now: () => clock }))
  const { proposal_id, expires_at } = await create(request)
  const send = () => dispatch(request, proposal_id, 'same')
  assert.equal((await send()).status, 200)
  clock = expires_at
  expectReplay(await send(), 'same')
  clock++
  expectDead(await send())
})

test('proposal lookup reports the declining attempts_left', async t => {
  const { request } = await start(t)
  const { proposal_id, confirm_expected } = await create(request, 'danger')
  for (const remaining of [3, 2, 1]) {
    const response = await lookup(request, proposal_id)
    assert.equal(response.status, 200)
    assert.equal(response.body.attempts_left, remaining)
    if (remaining > 1) expectMismatch(await dispatch(request, proposal_id, 'count', { confirm: wrongCode(confirm_expected) }), remaining - 1)
  }
})

test('without RELAY_DEV the fault and reset endpoints return 404', async t => {
  const { request } = await start(t)
  expectError(await request('/__fault', { raw: '{' }), 404, 'not_found')
  expectError(await request('/__reset'), 404, 'not_found')
})

async function startDev (t) {
  const serverUrl = new URL('./server.mjs', import.meta.url)
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { createRelay } from ${JSON.stringify(serverUrl.href)}
    const server = createRelay()
    server.listen(0, '127.0.0.1', () => process.send(server.address().port))
  `], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, RELAY_DEV: '1' } })
  const closed = new Promise(resolve => child.once('close', resolve))
  t.after(async () => {
    child.kill()
    await closed
  })
  const [port] = await once(child, 'message', { signal: AbortSignal.timeout(5000) })
  return client(port)
}

async function arm (request, fault) {
  const response = await request('/__fault', { json: fault })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { armed: true })
}

test('a one-shot 500 in a separate dev server only fails the next dispatch', async t => {
  const request = await startDev(t)
  await arm(request, { route: DISPATCH, mode: 'status', status: 500, delay_ms: 0 })
  const { proposal_id } = await create(request)
  const send = () => dispatch(request, proposal_id, 'retry')
  expectError(await send(), 500, 'internal_error')
  assert.equal((await lookup(request, proposal_id)).body.status, 'proposed')
  assert.equal((await send()).status, 200)
})

test('dev timeout never responds and body fault substitutes the configured body', async t => {
  const request = await startDev(t)
  await arm(request, { route: PROPOSAL, mode: 'timeout' })
  await assert.rejects(request(PROPOSAL, { json: {}, signal: AbortSignal.timeout(250) }), { name: 'TimeoutError' })
  const body = { custom: 'response' }
  await arm(request, { route: PROPOSAL, mode: 'body', body, delay_ms: 10 })
  const res = await propose(request)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, body)
  await create(request)
})

test('reject persists a readable reason and timestamp and prevents dispatch', async t => {
  const { request, store } = await start(t)
  const { proposal_id, expires_at } = await create(request, 'danger')
  expectMismatch(await dispatch(request, proposal_id, 'cmd'), 2)
  const res = await reject(request, proposal_id)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { proposal_id, status: 'rejected', reason: 'user_rejected', rejected_at: 100, attempts_left: 2 })
  const current = await lookup(request, proposal_id)
  assert.equal(current.status, 200)
  assert.deepEqual(current.body, { proposal_id, status: 'rejected', rejection_reason: 'user_rejected', rejected_at: 100, attempts_left: 2, expires_at })
  expectError(await dispatch(request, proposal_id, 'cmd'), 409, 'stale_approval')
  assert.equal(store.dispatchCount, 0)
})

test('double rejection returns the first reason and timestamp', async t => {
  const { request } = await start(t)
  const { proposal_id } = await create(request)
  const first = await reject(request, proposal_id)
  const second = await reject(request, proposal_id, { reason: 'different', ts: 101 })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(second.body, first.body)
})

test('cannot reject an already dispatched proposal', async t => {
  const { request } = await start(t)
  const { proposal_id } = await create(request)
  assert.equal((await dispatch(request, proposal_id, 'cmd')).status, 200)
  expectError(await reject(request, proposal_id), 410, 'proposal_done')
  assert.equal((await lookup(request, proposal_id)).body.status, 'executing')
})

test('a 401 dispatch leaves the proposal proposed and attempts and executions untouched', async t => {
  const { request, store } = await start(t)
  const { proposal_id } = await create(request)
  expectError(await dispatch(request, proposal_id, 'cmd', {}, { Authorization: 'Bearer wrong' }), 401, 'token_invalid')
  const { body } = await lookup(request, proposal_id)
  assert.equal(body.status, 'proposed')
  assert.equal(body.attempts_left, 3)
  assert.equal(store.dispatchCount, 0)
})

test('auth precedes body parsing even for malformed JSON', async t => {
  const { request } = await start(t)
  for (const Authorization of [undefined, 'Bearer wrong']) {
    expectError(await request(DISPATCH, { raw: '{', headers: { Authorization } }), 401, 'token_invalid')
  }
  expectError(await request(DISPATCH, { raw: '{' }), 400, 'bad_request')
})

test('context GET has counts only, with no pushed text in its serialized response', async t => {
  const { request } = await start(t)
  assert.equal((await request(CONTEXT, { json: push })).status, 200)
  const res = await request(`/v1/tabs/${ids.tab_id}/context`, { method: 'GET' })
  assert.equal(res.status, 200)
  assert.ok(!JSON.stringify(res).includes(canary))
  assert.deepEqual(res.body, { ...ids, ...kept, at: push.range.at })
})

test('the client cannot add warnings; the relay records even deception severity', async t => {
  const { request } = await start(t)
  const res = await request(CONTEXT, { json: { ...push, severity: 'deception', warnings: [{ code: 'audit_findings' }] } })
  assert.equal(res.status, 200)
  assert.ok(!JSON.stringify(res).includes('audit_findings'))
  assert.equal(res.body.received.severity, 'deception')
  assert.deepEqual(res.body.warnings, [{ code: 'severity_recorded' }])
})

test('server truncation reports its share, cumulative drops and the kept range in both endpoints', async t => {
  const { request } = await start(t)
  const json = { ...push, text: Array(250).fill('line').join('\n'), line_count: 250,
    truncated_lines: 100, range: { fromLine: 101, toLine: 350, at: push.range.at } }
  const res = await request(CONTEXT, { json })
  assert.equal(res.status, 200)
  const { received, warnings } = res.body
  assert.deepEqual(warnings, [{ code: 'server_truncated', dropped_lines: 50 }])
  assert.equal(received.server_dropped_lines, 50)
  assert.equal(received.truncated_lines, json.truncated_lines + received.server_dropped_lines)
  for (const counts of [received, (await request(`/v1/tabs/${ids.tab_id}/context`, { method: 'GET' })).body]) {
    assert.deepEqual(counts.range, { fromLine: 151, toLine: 350 })
    assert.equal(counts.line_count, 200)
    assert.equal(counts.truncated_lines, 150)
    assert.equal(counts.range.toLine - counts.range.fromLine + 1, counts.line_count)
  }
})

test('the byte cap measures UTF-8, accepting exactly 262144 bytes', async t => {
  const { request } = await start(t)
  const json = { ...push, text: 'é'.repeat(131072), line_count: 1, range: { fromLine: 1, toLine: 1 } }
  assert.equal((await request(CONTEXT, { json })).status, 200)
  expectError(await request(CONTEXT, { json: { ...json, text: `${json.text}a` } }), 413, 'truncation_refused')
})

test('four-digit codes never repeat, even when the code space runs out', () => {
  const store = createStore()
  const seen = new Set()
  const proposal = { ...ids, command: 'echo test', risk: 'danger' }
  for (let i = 0; i < 10000; ++i) {
    const { status, body } = store.createProposal(proposal)
    assert.equal(status, 200)
    assert.match(body.confirm_expected, /^\d{4}$/)
    assert.ok(!seen.has(body.confirm_expected))
    seen.add(body.confirm_expected)
  }
  assert.notEqual(store.createProposal(proposal).status, 200)
})
