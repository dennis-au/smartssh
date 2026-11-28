// contract: v56
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { createStore } from './state.mjs'

const TOKEN = randomUUID()
process.env.RELAY_TOKEN = TOKEN
delete process.env.RELAY_DEV
const { createRelay } = await import('./server.mjs')

const PUSH = '/v1/context.push'
const REQUEST = '/v1/context.request'
const PROPOSAL = '/v1/proposal'
const ids = { tab_id: 'tab-1', session_id: 'session-1' }
const kept = { line_count: 1, truncated_lines: 0, redacted_segments: 0,
  severity: 'none', range: { fromLine: 1, toLine: 1 } }
const push = { ...ids, ...kept, text: 'hello', masks: [] }

function client (port) {
  return async (path, { method = 'POST', json, auth = true, headers } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, body: JSON.stringify(json), signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), ...headers },
    })
    return { status: response.status, body: await response.json() }
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
  const request = client(server.address().port)
  const inbox = ({ tab = ids.tab_id, auth = true } = {}) => request(`/v1/inbox/${tab}`, { method: 'GET', auth })
  return { request, inbox, store }
}

// Compare token-bearing data without including actual or expected values in failure output.
function expectShape (actual, expected, message) {
  assert.ok(isDeepStrictEqual(actual, expected), message)
}

function expectError (response, status, code) {
  assert.equal(response.status, status)
  assert.ok(response.body.error === code, 'unexpected error code')
}

test('a fresh tab push without a sample preserves the old response body', async t => {
  const { request, store } = await start(t)
  const { status, body } = await request(PUSH, { json: push })
  assert.equal(status, 200)
  expectShape(body, { session_id: ids.session_id, received: { ...kept, server_dropped_lines: 0 }, warnings: [] },
    'fresh push without a sample must keep the legacy response')
  assert.equal(store.promptLedger.size, 0)
})

test('only the relay counts agreements, caps the count and resets it when the suffix changes', async t => {
  const { request, inbox, store } = await start(t)
  for (const [token, trusted, samples] of [
    ['$ ', false, 1], ['$ ', true, 2], ['$ ', true, 3], ['$ ', true, 3],
    ['❯\t', false, 1], ['❯\t', true, 2],
  ]) {
    const { status, body } = await request(PUSH, { json: { ...push, prompt_sample: token, trusted: !trusted } })
    assert.equal(status, 200)
    const expected = { token, trusted, samples }
    expectShape(body.prompt, expected, 'push must report the relay agreement count and trust')
    expectShape(store.promptFor(ids.tab_id), expected, 'store must mirror push prompt state')
    expectShape(store.promptLedger.get(ids.tab_id), { token, agreements: samples }, 'ledger must hold the agreement count')
    assert.ok(!Object.hasOwn(store.contexts.get(ids.tab_id), 'prompt_sample'), 'sample must not be stored in context')
  }
  const expected = store.promptFor(ids.tab_id)
  const response = await request(PUSH, { json: push })
  assert.equal(response.status, 200)
  expectShape(response.body.prompt, expected, 'omitting the sample must not change existing prompt state')
  const next = await inbox()
  assert.equal(next.status, 200)
  expectShape(next.body.prompt, expected, 'inbox must report the same prompt state')
  const other = await inbox({ tab: 'tab-2' })
  assert.equal(other.status, 200)
  expectShape(other.body.prompt, null, 'prompt state must be isolated by tab')
})

test('invalid samples and invalid contexts leave the ledger untouched', async t => {
  const { request, store } = await start(t)
  assert.equal((await request(PUSH, { json: { ...push, prompt_sample: '$ ' } })).status, 200)
  const expected = store.promptFor(ids.tab_id)
  for (const prompt_sample of ['hermes@srv:~$ ', '$ echo hi', '$ \n', '$' + ' '.repeat(8), 42, randomUUID(), null]) {
    expectError(await request(PUSH, { json: { ...push, prompt_sample } }), 400, 'bad_request')
    expectShape(store.promptFor(ids.tab_id), expected, 'rejected samples must not change the ledger')
  }
  expectError(await request(PUSH, { json: { ...push, line_count: 2, prompt_sample: '$ ' } }), 400, 'bad_request')
  expectShape(store.promptFor(ids.tab_id), expected, 'invalid contexts must not count toward trust')
  assert.equal(store.promptLedger.size, 1)
})

test('context requests require auth and both IDs, and inbox delivery is one-shot', async t => {
  const { request, inbox } = await start(t, createStore({ now: () => 100 }))
  expectError(await request(REQUEST, { json: ids, auth: false }), 401, 'token_invalid')
  expectError(await request(REQUEST, { json: { session_id: ids.session_id } }), 400, 'bad_request')
  expectError(await request(REQUEST, { json: { tab_id: ids.tab_id } }), 400, 'bad_request')
  const empty = { tab_id: ids.tab_id, prompt: null, items: [] }
  expectShape(await inbox(), { status: 200, body: empty }, 'rejected requests must not enqueue anything')

  const { status, body } = await request(REQUEST, { json: ids })
  assert.equal(status, 200)
  assert.ok(/^[0-9a-f-]{36}$/u.test(body.request_id), 'request must have a generated UUID')
  assert.equal(body.expires_at, 120100)
  expectError(await inbox({ auth: false }), 401, 'token_invalid')
  expectShape(await inbox(), { status: 200, body: { ...empty,
    items: [{ kind: 'context_request', request_id: body.request_id }] } }, 'request must appear once after authentication')
  expectShape(await inbox(), { status: 200, body: empty }, 'delivered request must not repeat')
})

test('the inbox keeps the latest eight pending requests per tab', async t => {
  const { store } = await start(t)
  expectError(store.inbox(''), 400, 'bad_request')
  const enqueue = (tab_id = ids.tab_id) => {
    const result = store.createContextRequest({ ...ids, tab_id })
    assert.equal(result.status, 200)
    return { kind: 'context_request', request_id: result.body.request_id }
  }
  const other = enqueue('tab-2')
  const items = Array.from({ length: 9 }, () => enqueue())
  expectShape(store.inbox(ids.tab_id).body.items, items.slice(1), 'oldest pending request must be dropped')
  expectShape(store.inbox('tab-2').body.items, [other], 'the cap must apply separately to each tab')
  const next = enqueue()
  expectShape(store.inbox(ids.tab_id).body.items, [next], 'delivered requests must not repeat')
})

test('the inbox delivers requests before proposals and skips dispatched proposals', async t => {
  const { request, inbox } = await start(t)
  const command = 'echo hello'
  const why = 'Explain the proposal'
  const propose = async (risk, extras) => {
    const { status, body } = await request(PROPOSAL, { json: { ...ids, risk, command, ...extras } })
    assert.equal(status, 200)
    assert.ok(!Object.hasOwn(body, 'why'), 'proposal creation response must not include why')
    return body
  }
  const dispatch = async ({ proposal_id, confirm_expected }) => {
    const response = await request('/v1/command.dispatch', {
      json: { ...ids, proposal_id, confirm: confirm_expected, command_id: proposal_id },
      headers: { 'Idempotency-Key': proposal_id },
    })
    assert.equal(response.status, 200)
  }
  const danger = await propose('danger', { why: `  ${why}  ` })
  assert.ok(/^\d{4}$/u.test(danger.confirm_expected), 'danger proposal must include a four-digit challenge')
  const read = await propose('read')
  const skipped = await propose('danger')
  await dispatch(skipped)
  const context = await request(REQUEST, { json: ids })
  assert.equal(context.status, 200)
  const first = await inbox()
  assert.equal(first.status, 200)
  expectShape(first.body.items, [
    { kind: 'context_request', request_id: context.body.request_id },
    { kind: 'proposal', proposal_id: danger.proposal_id, command, risk: 'danger', why, confirm_expected: danger.confirm_expected },
    { kind: 'proposal', proposal_id: read.proposal_id, command, risk: 'read', why: '' },
  ], 'inbox must deliver only pending items, including the danger challenge and trimmed reason')
  const empty = { status: 200, body: { tab_id: ids.tab_id, prompt: null, items: [] } }
  expectShape(await inbox(), empty, 'proposals must not be delivered twice')
  await dispatch(danger)
  expectShape(await inbox(), empty, 'dispatched proposals must not be delivered')
})

test('proposal reasons are optional strings limited to 280 trimmed characters', async t => {
  const { request } = await start(t)
  const proposal = { ...ids, command: 'echo hello', risk: 'read' }
  for (const why of [null, 42, 'x'.repeat(281)]) {
    expectError(await request(PROPOSAL, { json: { ...proposal, why } }), 400, 'bad_request')
  }
  assert.equal((await request(PROPOSAL, { json: { ...proposal, why: ` ${'x'.repeat(280)} ` } })).status, 200)
})

test('an inbox without samples is usable and never exposes pushed terminal text', async t => {
  const { request, inbox } = await start(t)
  const expected = { status: 200, body: { tab_id: ids.tab_id, prompt: null, items: [] } }
  expectShape(await inbox(), expected, 'fresh inbox must have no prompt and no items')
  const canary = `terminal-text-canary-${randomUUID()}`
  assert.equal((await request(PUSH, { json: { ...push, text: `echo ${canary}` } })).status, 200)
  const response = await inbox()
  assert.ok(!Object.hasOwn(response.body, 'text'), 'inbox body must not have a text key')
  assert.ok(!JSON.stringify(response.body).includes(canary), 'inbox body must not contain pushed text')
  expectShape(response, expected, 'pushing context without a sample must not change the inbox')
})
