// contract: v56
// smartssh/relay/cors.test.mjs — the app talks to this relay from an Electron renderer, so the relay
// must be readable from a page origin. These cases pin the browser-visible contract:
//   * a preflight (no Authorization header, by definition) is answered 204, not 401,
//   * every response — including the 401 — carries the CORS metadata, or the renderer cannot read it,
//   * the allow-headers list covers what the client actually sends (authorization, content-type,
//     idempotency-key).
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'

import { createRelay } from './server.mjs'
import { createStore } from './state.mjs'

const TOKEN = 'cors-test-token'

async function withRelay (t) {
  const previous = process.env.RELAY_TOKEN
  process.env.RELAY_TOKEN = TOKEN
  const server = createRelay({ store: createStore() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
    if (previous === undefined) delete process.env.RELAY_TOKEN
    else process.env.RELAY_TOKEN = previous
  }))
  return `http://127.0.0.1:${server.address().port}`
}

const baseHeaders = { Origin: 'app://tabby', Authorization: `Bearer ${TOKEN}` }

test('preflight is answered without auth and allows the headers the client sends', async t => {
  const base = await withRelay(t)
  const response = await fetch(`${base}/v1/tabs`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'app://tabby',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.match(response.headers.get('access-control-allow-methods'), /GET/)
  assert.match(response.headers.get('access-control-allow-methods'), /POST/)
  const allowed = response.headers.get('access-control-allow-headers').toLowerCase()
  for (const header of ['authorization', 'content-type', 'idempotency-key']) {
    assert.ok(allowed.includes(header), `preflight must allow ${header}`)
  }
})

test('a rejected request is still readable from the page', async t => {
  const base = await withRelay(t)
  const response = await fetch(`${base}/v1/tabs`, { headers: { Origin: 'app://tabby', Authorization: 'Bearer wrong' } })
  assert.equal(response.status, 401)
  // Without this header the renderer sees an opaque network error instead of `token_invalid`, and the
  // UI can never tell "wrong token" from "relay down".
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal((await response.json()).error, 'token_invalid')
})

test('an authorised response carries the CORS metadata too', async t => {
  const base = await withRelay(t)
  const response = await fetch(`${base}/v1/tabs`, { headers: baseHeaders })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  const body = await response.json()
  assert.deepEqual(body.tabs, [])

  const registered = await fetch(`${base}/v1/tabs`, {
    method: 'POST',
    headers: { ...baseHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab_id: 'tab-cors', session_id: 'session-cors', host: 'local' }),
  })
  assert.equal(registered.status, 200)
  assert.equal(registered.headers.get('access-control-allow-origin'), '*')
  assert.equal((await registered.json()).tab_id, 'tab-cors')
})
