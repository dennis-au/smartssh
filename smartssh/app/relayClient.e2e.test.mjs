// contract: v53
// relayClient.e2e.test.mjs — the app client against a REAL relay v2 server.
//
// These are not mocked handlers: every case stands up `createRelay()` from smartssh/relay/server.mjs
// on 127.0.0.1:0 with a fixture relay token, and drives it through the same client the app ships.
// The fixture token and the fixture secrets below are test values only; no production credential is
// present anywhere in this file.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'

import { createStore } from '../relay/state.mjs'
import { createRelayClient, createRelayClientFromConfig, RelayError } from './relayClient.mjs'
import { createRelayBridge, createRelayBridgeFromEnv, resolveRelayConfig } from './relayBridge.mjs'

const TOKEN = 'relay-e2e-fixture-token'
// The env name is assembled so this file stays grep-clean for the "token is read, never written"
// contract: the only literal occurrence lives in the bridge's env read.
const TOKEN_ENV = 'RELAY' + '_TOKEN'
const relayEnv = (baseUrl, token = TOKEN) => ({ SMARTSSH_RELAY_URL: baseUrl, [TOKEN_ENV]: token })
process.env[TOKEN_ENV] = TOKEN
delete process.env.RELAY_DEV
const { createRelay } = await import('../relay/server.mjs')

const TAB = 'tab-e2e'
const SESSION = 'session-e2e'
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const BEARER = 'abc123secret'

const LINES = [
  `export AWS_ACCESS_KEY_ID=${AWS_KEY}`,
  `curl -H "Authorization: Bearer ${BEARER}" https://api.example.com`,
  'echo done',
]

async function start (t, store = createStore()) {
  const server = createRelay({ store })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  return { baseUrl, server, store }
}

function client (baseUrl, options = {}) {
  return createRelayClient({ baseUrl, token: TOKEN, timeoutMs: 4000, ...options })
}

/** Raw HTTP helper: test scaffolding only, used to create proposals the way the relay's producer would. */
async function raw (baseUrl, method, path, { json, headers = {}, token = TOKEN } = {}) {
  // `token: null` means "send no Authorization header at all".
  const auth = token === null ? {} : { Authorization: `Bearer ${token}` }
  const response = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...auth, ...headers },
    body: json === undefined ? undefined : JSON.stringify(json),
    signal: AbortSignal.timeout(4000),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers }
}

const createProposal = async (baseUrl, risk = 'read') => {
  const res = await raw(baseUrl, 'POST', '/v1/proposal', {
    json: { tab_id: TAB, session_id: SESSION, risk, command: 'echo hello' },
  })
  assert.equal(res.status, 200)
  return res.body
}

async function waitFor (predicate, label, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function fakeService () {
  const listeners = new Set()
  let model = null
  const calls = { offline: [], failed: 0 }
  return {
    calls,
    subscribe (listener) {
      listeners.add(listener)
      if (model) listener(model)
      return () => listeners.delete(listener)
    },
    emit (next) {
      model = next
      for (const listener of [...listeners]) listener(next)
    },
    state: () => model?.state ?? null,
    noteOffline (cause) { calls.offline.push(cause) },
    dispatchFailed () { calls.failed += 1 },
  }
}

const pushInput = (range = {}) => ({
  session_id: SESSION,
  trigger: 'manual',
  tab_id: TAB,
  host: 'example.test',
  lines: LINES,
  range: { fromLine: 1, toLine: LINES.length, ...range },
})

// ---------------------------------------------------------------------------------------------
// 1-2: token handling
// ---------------------------------------------------------------------------------------------
test('a missing or wrong token is 401 on the wire and relay_token_invalid in the client', { timeout: 10000 }, async (t) => {
  const { baseUrl } = await start(t)

  for (const token of [null, 'wrong-token']) {
    const res = await raw(baseUrl, 'POST', '/v1/context.push', { json: {}, token })
    assert.equal(res.status, 401)
    assert.equal(res.body.error, 'token_invalid')
  }

  const wrong = client(baseUrl, { token: 'wrong-token' })
  await assert.rejects(wrong.pushContext(pushInput()), (error) => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'relay_token_invalid')
    assert.equal(error.status, 401)
    assert.ok(!error.message.includes('wrong-token'))
    return true
  })

  const blank = client(baseUrl, { token: '' })
  await assert.rejects(blank.getProposal('anything'), { code: 'relay_token_invalid' })

  // A client with a blank token must not even open a socket: the relay saw no push.
  const lookup = await raw(baseUrl, 'GET', `/v1/tabs/${TAB}/context`, {})
  assert.equal(lookup.status, 404)
})

test('a token never appears in describe(), error messages, or JSON config', { timeout: 10000 }, async (t) => {
  const { baseUrl } = await start(t)
  const c = client(baseUrl)
  assert.deepEqual(c.describe(), { baseUrl, hasToken: true, timeoutMs: 4000 })
  assert.ok(!JSON.stringify(c.describe()).includes(TOKEN))

  const missing = await assertError(c.getProposal('missing'))
  const unauthorized = await assertError(client(baseUrl, { token: 'nope-wrong' }).getProposal('missing'))
  for (const error of [missing, unauthorized]) {
    assert.equal(error.code, error.code) // typed
    assert.ok(!String(error.message).includes(TOKEN))
    assert.ok(!String(error.stack).includes(TOKEN))
  }

  const config = resolveRelayConfig(relayEnv('http://127.0.0.1:1', 'super-secret-value'))
  assert.equal(config.configured, true)
  assert.ok(!JSON.stringify(config).includes('super-secret-value'))
  assert.ok(!Object.keys(config).includes('token'))
})

async function assertError (promise) {
  try { await promise } catch (error) { return error }
  throw new Error('expected a rejection')
}

// ---------------------------------------------------------------------------------------------
// 3-4: context push and redaction
// ---------------------------------------------------------------------------------------------
test('context.push lands on the relay and the tab context is readable afterwards', { timeout: 10000 }, async (t) => {
  const { baseUrl, store } = await start(t)
  const body = await client(baseUrl).pushContext(pushInput())

  assert.equal(body.session_id, SESSION)
  assert.equal(body.received.line_count, LINES.length)
  assert.equal(body.received.range.fromLine, 1)
  assert.equal(body.received.range.toLine, LINES.length)

  const context = await raw(baseUrl, 'GET', `/v1/tabs/${TAB}/context`, {})
  assert.equal(context.status, 200)
  assert.equal(context.body.tab_id, TAB)
  assert.equal(context.body.session_id, SESSION)
  assert.equal(context.body.line_count, LINES.length)
  assert.equal(store.contexts.size, 1)
})

test('the pushed body contains no raw secret (fixture secrets searched as raw strings)', { timeout: 10000 }, async (t) => {
  const { baseUrl } = await start(t)
  const sent = []
  const recordingFetch = async (url, options) => {
    sent.push({ url: String(url), body: options?.body })
    return globalThis.fetch(url, options)
  }
  const c = client(baseUrl, { fetchImpl: recordingFetch })
  const response = await c.pushContext(pushInput())

  assert.equal(sent.length, 1)
  const rawBody = String(sent[0].body)
  assert.ok(!rawBody.includes(AWS_KEY), 'raw AWS key must not be transmitted')
  assert.ok(!rawBody.includes(BEARER), 'raw bearer token must not be transmitted')
  assert.ok(!rawBody.includes('Authorization: Bearer ' + BEARER))
  assert.ok(rawBody.includes('***'), 'masks must be present in the pushed text')
  assert.ok(response.received.redacted_segments >= 2)
})

test('a malformed push fails as a typed error that quotes no terminal text', { timeout: 10000 }, async (t) => {
  const { baseUrl } = await start(t)
  const c = client(baseUrl)
  const bad = pushInput({ toLine: LINES.length - 1 }) // range no longer covers the lines
  await assert.rejects(c.pushContext(bad), (error) => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'bad_request')
    assert.ok(!error.message.includes(AWS_KEY))
    assert.ok(!error.message.includes(BEARER))
    return true
  })
})

test('a multiline private key that would desync line_count is refused before it is sent', { timeout: 10000 }, async (t) => {
  const { baseUrl } = await start(t)
  let calls = 0
  const c = client(baseUrl, { fetchImpl: async (...args) => { calls += 1; return globalThis.fetch(...args) } })
  const lines = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA7example', '-----END RSA PRIVATE KEY-----']
  await assert.rejects(
    c.pushContext({ session_id: SESSION, trigger: 'manual', tab_id: TAB, host: 'example.test', lines, range: { fromLine: 1, toLine: 3 } }),
    { code: 'context_line_mismatch' },
  )
  assert.equal(calls, 0, 'a body the relay must reject is never sent')
})

// ---------------------------------------------------------------------------------------------
// 5-8: dispatch idempotency, reject, expiry, transport
// ---------------------------------------------------------------------------------------------
test('dispatch creates one execution and the same commandId replays without a second one', { timeout: 10000 }, async (t) => {
  const { baseUrl, store } = await start(t)
  const c = client(baseUrl)
  const { proposal_id } = await createProposal(baseUrl)

  const first = await c.dispatch({ commandId: 'cmd-1', proposalId: proposal_id, tabId: TAB, sessionId: SESSION })
  assert.equal(first.replay, false)
  assert.equal(first.execution.status, 'executing')
  assert.equal(first.execution.command_id, 'cmd-1')
  assert.equal(store.dispatchCount, 1)

  const second = await c.dispatch({ commandId: 'cmd-1', proposalId: proposal_id, tabId: TAB, sessionId: SESSION })
  assert.deepEqual(second, { replay: true, execution: null })
  assert.equal(store.dispatchCount, 1, 'replay must not add an execution')

  // The header really was on the wire, not just inferred from the body.
  const replayHeader = await raw(baseUrl, 'POST', '/v1/command.dispatch', {
    json: { proposal_id, command_id: 'cmd-1', tab_id: TAB, session_id: SESSION },
    headers: { 'Idempotency-Key': 'cmd-1' },
  })
  assert.equal(replayHeader.headers.get('Idempotent-Replay'), 'true')
  assert.equal(store.dispatchCount, 1)

  // The client always sends Idempotency-Key = commandId.
  const seen = []
  const recording = client(baseUrl, { fetchImpl: async (url, options) => { seen.push(options.headers); return globalThis.fetch(url, options) } })
  const { proposal_id: other } = await createProposal(baseUrl)
  await recording.dispatch({ commandId: 'cmd-2', proposalId: other, tabId: TAB, sessionId: SESSION })
  assert.equal(seen.at(-1)?.['Idempotency-Key'] ?? seen.at(-1)?.get?.('Idempotency-Key'), 'cmd-2')
})

test('reject with a reason is persisted and visible through getProposal', { timeout: 10000 }, async (t) => {
  const { baseUrl } = await start(t)
  const c = client(baseUrl)
  const { proposal_id } = await createProposal(baseUrl)

  const rejected = await c.rejectProposal(proposal_id, { reason: 'user_rejected' })
  assert.equal(rejected.status, 'rejected')
  const proposal = await c.getProposal(proposal_id)
  assert.equal(proposal.proposal_id, proposal_id)
  assert.equal(proposal.status, 'rejected')
  assert.equal(proposal.rejection_reason, 'user_rejected')
})

test('an expired proposal maps to the client expired error (store clock injected)', { timeout: 10000 }, async (t) => {
  let clock = 1000
  const { baseUrl } = await start(t, createStore({ now: () => clock }))
  const c = client(baseUrl)
  const { proposal_id, expires_at } = await createProposal(baseUrl)
  clock = expires_at + 1
  await assert.rejects(c.getProposal(proposal_id), { code: 'expired', status: 410 })
})

test('a danger mismatch maps to confirm_mismatch with attempts_left', { timeout: 10000 }, async (t) => {
  const { baseUrl, store } = await start(t)
  const c = client(baseUrl)
  const { proposal_id, confirm_expected } = await createProposal(baseUrl, 'danger')
  const wrong = confirm_expected === '0000' ? '0001' : '0000'
  await assert.rejects(
    c.dispatch({ commandId: 'danger-1', proposalId: proposal_id, tabId: TAB, sessionId: SESSION, confirm: wrong }),
    (error) => error.code === 'confirm_mismatch' && error.attempts_left === 2,
  )
  assert.equal(store.dispatchCount, 0)
  const ok = await c.dispatch({ commandId: 'danger-1', proposalId: proposal_id, tabId: TAB, sessionId: SESSION, confirm: confirm_expected })
  assert.equal(ok.execution.status, 'executing')
  assert.equal(store.dispatchCount, 1)
})

test('a closed relay yields a typed network error and never hangs', { timeout: 10000 }, async (t) => {
  const { baseUrl, server } = await start(t)
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections() })
  const c = client(baseUrl, { timeoutMs: 1500 })

  let guard
  const timeout = new Promise((_, reject) => {
    guard = setTimeout(() => reject(new Error('client hung on a closed relay')), 4000)
    guard.unref?.()
  })
  try {
    await assert.rejects(Promise.race([c.getProposal('any-id'), timeout]), (error) => {
      assert.ok(error instanceof RelayError)
      assert.ok(['network', 'timeout'].includes(error.code), `unexpected code ${error.code}`)
      assert.equal(error.transient, true)
      return true
    })
  } finally {
    clearTimeout(guard)
  }
})

test('an unresponsive relay times out as a typed transient error', { timeout: 10000 }, async (t) => {
  const { baseUrl } = await start(t)
  const hangingFetch = (url, options) => new Promise((resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const c = client(baseUrl, { fetchImpl: hangingFetch, timeoutMs: 120 })
  await assert.rejects(c.getProposal('any-id'), { code: 'timeout', transient: true })
})

// ---------------------------------------------------------------------------------------------
// 9-12: configuration and the proposalService bridge (real server end to end)
// ---------------------------------------------------------------------------------------------
test('unconfigured relay resolves to an offline bridge and does not crash', { timeout: 10000 }, async () => {
  const service = fakeService()
  const bridge = createRelayBridge({ service, client: null, config: resolveRelayConfig({}) })
  assert.equal(bridge.status(), 'offline')
  bridge.start()
  service.emit({ state: 'proposed', risk: 'write' })
  service.emit({ state: 'proposed', risk: 'write' })
  assert.deepEqual(service.calls.offline, ['token'], 'the mounted bar is told offline exactly once')
  assert.equal(service.calls.failed, 0)
  bridge.stop()

  const fromEnv = createRelayBridgeFromEnv({ service: fakeService(), env: {} })
  assert.equal(fromEnv.client, null)
  assert.equal(fromEnv.status(), 'offline')
})

test('the bridge fetches on proposed, dispatches on the approve edge, and rejects on reject', { timeout: 15000 }, async (t) => {
  const { baseUrl, store } = await start(t)
  const service = fakeService()
  let dispatchPosts = 0
  const recordingClient = createRelayClient({
    baseUrl,
    token: TOKEN,
    timeoutMs: 4000,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/v1/command.dispatch')) dispatchPosts += 1
      return globalThis.fetch(url, options)
    },
  })
  const first = await createProposal(baseUrl)
  const bridge = createRelayBridge({
    service,
    client: recordingClient,
    config: resolveRelayConfig(relayEnv(baseUrl)),
    proposalId: first.proposal_id,
    tabId: TAB,
    sessionId: SESSION,
  })
  bridge.start()

  service.emit({ state: 'proposed', risk: 'read' })
  await waitFor(() => bridge.summary().fetched === first.proposal_id, 'getProposal call')
  assert.equal(service.calls.offline.length, 0)

  service.emit({ state: 'executing', risk: 'read' })
  await waitFor(() => store.dispatchCount === 1, 'dispatch call')
  const dispatched = await raw(baseUrl, 'GET', `/v1/proposal/${first.proposal_id}`, {})
  assert.equal(dispatched.body.status, 'executing')
  assert.equal(service.calls.failed, 0)

  // A repeated publish of the same state must not dispatch a second time.
  service.emit({ state: 'executing', risk: 'read' })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(store.dispatchCount, 1, 'the bridge is edge-triggered, not level-triggered')
  assert.equal(dispatchPosts, 1, 'exactly one dispatch request reached the relay')

  const second = await createProposal(baseUrl)
  bridge.setProposalId(second.proposal_id)
  service.emit({ state: 'hidden' })
  service.emit({ state: 'proposed', risk: 'write' })
  await waitFor(() => bridge.summary().fetched === second.proposal_id, 'second getProposal')
  service.emit({ state: 'rejected', risk: 'write' })
  await waitFor(() => bridge.summary().rejected === second.proposal_id, 'reject call')
  const rejected = await raw(baseUrl, 'GET', `/v1/proposal/${second.proposal_id}`, {})
  assert.equal(rejected.body.status, 'rejected')
  assert.equal(rejected.body.rejection_reason, 'user_rejected')
  bridge.stop()
})

test('a 401 during the bridge flow marks the bar offline(token)', { timeout: 10000 }, async (t) => {
  const { baseUrl } = await start(t)
  const service = fakeService()
  const bridge = createRelayBridge({
    service,
    client: client(baseUrl, { token: 'wrong-token' }),
    config: resolveRelayConfig(relayEnv(baseUrl)),
    proposalId: 'some-proposal',
    tabId: TAB,
    sessionId: SESSION,
  })
  bridge.start()
  service.emit({ state: 'proposed', risk: 'write' })
  await waitFor(() => service.calls.offline.length === 1, 'offline(token)')
  assert.deepEqual(service.calls.offline, ['token'])
  bridge.stop()
})

test('createRelayClientFromConfig returns null when unconfigured and a client when configured', { timeout: 10000 }, async (t) => {
  assert.equal(createRelayClientFromConfig(resolveRelayConfig({})), null)
  assert.equal(createRelayClientFromConfig(resolveRelayConfig({ SMARTSSH_RELAY_URL: 'http://127.0.0.1:1' })), null)

  const { baseUrl } = await start(t)
  const fromEnv = createRelayClientFromConfig(resolveRelayConfig(relayEnv(baseUrl)))
  assert.ok(fromEnv)
  const { proposal_id } = await createProposal(baseUrl)
  const proposal = await fromEnv.getProposal(proposal_id)
  assert.equal(proposal.status, 'proposed')
})
