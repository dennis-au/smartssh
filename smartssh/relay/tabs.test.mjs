// contract: v56
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { createRelayClient } from '../app/relayClient.mjs'
import { createStore } from './state.mjs'

const bearer = randomUUID()
process.env.RELAY_TOKEN = bearer
delete process.env.RELAY_DEV
const { createRelay } = await import('./server.mjs')

const TABS = '/v1/tabs'
const PUSH = '/v1/context.push'
const ids = { tab_id: 'tab-1', session_id: 'session-1' }
const tab = { ...ids, host: 'host.test' }
const kept = { line_count: 1, truncated_lines: 0, redacted_segments: 0,
  severity: 'none', range: { fromLine: 1, toLine: 1 } }
const push = { ...ids, ...kept, text: 'hello', masks: [] }

async function start (t) {
  let time = 100
  const store = createStore({ now: () => time })
  const server = createRelay({ store })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const request = async (path, { method = 'POST', json, auth = true } = {}) => {
    const response = await fetch(baseUrl + path, {
      method, body: JSON.stringify(json), signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${bearer}` } : {}) },
    })
    return { status: response.status, body: await response.json() }
  }
  const list = () => request(TABS, { method: 'GET' })
  return { request, list, store, setTime: value => { time = value }, baseUrl }
}

function expectShape (actual, expected, message) {
  assert.ok(isDeepStrictEqual(actual, expected), message)
}

function expectError (response, status, code) {
  assert.equal(response.status, status)
  assert.ok(response.body.error === code, 'unexpected error code')
}

test('registration requires auth and valid tab, session and host fields', async t => {
  const { request, list, store } = await start(t)
  expectError(await request(TABS, { json: tab, auth: false }), 401, 'token_invalid')
  assert.equal(store.tabs.size, 0)
  expectError(await request(TABS, { method: 'GET', auth: false }), 401, 'token_invalid')
  for (const field of Object.keys(tab)) {
    for (const value of [undefined, '', '  ', 42]) {
      expectError(await request(TABS, { json: { ...tab, [field]: value } }), 400, 'bad_request')
    }
  }
  expectError(await request(TABS, { json: { ...tab, host: 'x'.repeat(201) } }), 400, 'bad_request')
  expectShape(await list(), { status: 200, body: { tabs: [] } }, 'rejected registrations must not create tabs')
  assert.equal((await request(TABS, { json: { ...tab, host: 'x'.repeat(200) } })).status, 200)
})

test('re-registering preserves first_seen, moves last_seen and updates the session and host', async t => {
  const { request, list, setTime, baseUrl } = await start(t)
  expectShape(await request(TABS, { json: tab }), { status: 200, body: { tab_id: tab.tab_id } },
    'registration must return the tab ID')
  setTime(200)
  const client = createRelayClient({ baseUrl, token: bearer })
  const updated = { tab_id: tab.tab_id, session_id: 'session-2', host: 'new.test' }
  await assert.rejects(client.registerTab({ tabId: tab.tab_id }), {
    code: 'bad_request', relayCode: 'tab_fields_missing',
  })
  expectShape(await client.registerTab({ tabId: updated.tab_id, sessionId: updated.session_id, host: updated.host }),
    { tab_id: tab.tab_id }, 'the client must register the tab with the relay')
  expectShape(await list(), { status: 200, body: { tabs: [
    { ...updated, first_seen: 100, last_seen: 200, prompt: null },
  ] } }, 're-registration must update the existing tab')
})

test('tabs are listed by latest registration, with null prompts before sampling', async t => {
  const { request, list, setTime } = await start(t)
  const other = { tab_id: 'tab-2', session_id: 'session-2', host: 'other.test' }
  assert.equal((await request(TABS, { json: tab })).status, 200)
  setTime(200)
  assert.equal((await request(TABS, { json: other })).status, 200)
  expectShape(await list(), { status: 200, body: { tabs: [
    { ...other, first_seen: 200, last_seen: 200, prompt: null },
    { ...tab, first_seen: 100, last_seen: 100, prompt: null },
  ] } }, 'most recently seen tab must be first')
  setTime(300)
  assert.equal((await request(TABS, { json: tab })).status, 200)
  expectShape(await list(), { status: 200, body: { tabs: [
    { ...tab, first_seen: 100, last_seen: 300, prompt: null },
    { ...other, first_seen: 200, last_seen: 200, prompt: null },
  ] } }, 'listing order must update on re-registration')
})

test('the tab listing includes prompt trust and sample count but never the token', async t => {
  const { request, list } = await start(t)
  const sample = String.fromCharCode(62, 32)
  assert.equal((await request(TABS, { json: tab })).status, 200)
  for (const samples of [1, 2]) {
    assert.equal((await request(PUSH, { json: { ...push, prompt_sample: sample } })).status, 200)
    const { status, body } = await list()
    assert.equal(status, 200)
    assert.ok(!JSON.stringify(body).includes(sample), 'listing must not contain the prompt token')
    expectShape(body, { tabs: [{ ...tab, first_seen: 100, last_seen: 100,
      prompt: { trusted: samples >= 2, samples },
    }] }, 'listing must expose only prompt metadata')
  }
})

test('the context route remains distinct from the tab listing', async t => {
  const { request } = await start(t)
  const contextPath = `${TABS}/${tab.tab_id}/context`
  assert.equal((await request(TABS, { json: tab })).status, 200)
  expectError(await request(contextPath, { method: 'GET' }), 404, 'not_found')
  assert.equal((await request(PUSH, { json: { ...push, range: { ...push.range, at: 100 } } })).status, 200)
  expectShape(await request(contextPath, { method: 'GET' }), { status: 200, body: { ...ids, ...kept, at: 100 } },
    'context route must return the existing context metadata')
})
