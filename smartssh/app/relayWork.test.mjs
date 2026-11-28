// contract: v56
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import { createStore } from '../relay/state.mjs'
import { createProposalService } from './proposalService.mjs'
import { createRelayClient, RelayError } from './relayClient.mjs'
import { applyPromptEcho, createRelayWork } from './relayWork.mjs'

const promptToken = String.fromCharCode(62, 32)
const echo = (trusted = true, samples = 2) => ({ token: promptToken, trusted, samples })
const request = { kind: 'context_request', request_id: 'req-1' }
const proposal = { kind: 'proposal', proposal_id: 'prop-1', command: 'echo hello', risk: 'read', why: 'Check output' }
const box = (items = [], prompt = null) => ({ tab_id: 'tab-1', prompt, items })
const win = { lines: ['echo hello', 'hello'], fromLine: 11, toLine: 12 }

function fixture ({ inbox = () => box(), pushContext = () => ({}), ...options } = {}) {
  const inboxes = []
  const pushes = []
  const events = []
  const service = createProposalService({ buffer: {}, schedule: false, metrics: false })
  const client = {
    async inbox (tab) { inboxes.push(tab); return inbox(tab) },
    async pushContext (input) { pushes.push(input); return pushContext(input) },
  }
  const work = createRelayWork({
    client, service, tabId: 'tab-1', sessionId: 'session-1', host: 'host.test',
    capture: () => win, clock: () => 1234, onEvent: event => events.push(event), ...options,
  })
  return { work, client, service, inboxes, pushes, events }
}

const ofType = (events, type) => events.filter(event => event.type === type)

test('empty and proposal-only inboxes do not capture, sample or push; proposals arrive unchanged', async () => {
  let next = box()
  let terminalReads = 0
  const received = []
  const { work, pushes, events } = fixture({
    inbox: () => next, onProposal: item => received.push(item),
    capture: () => { terminalReads++; return win }, sample: () => { terminalReads++; return null },
  })
  await work.poll()
  assert.equal(pushes.length, 0)
  next = box([proposal])
  await work.poll()
  assert.equal(received.length, 1)
  assert.strictEqual(received[0], proposal)
  assert.equal(terminalReads, 0)
  assert.equal(pushes.length, 0)
  assert.deepEqual(ofType(events, 'proposal'), [{ type: 'proposal', proposalId: 'prop-1', risk: 'read' }])
  assert.equal(ofType(events, 'prompt').length, 1, 'unchanged prompt metadata is not repeated')
})

test('a context request sends one captured window with the current identifiers and time', async () => {
  let tab = 'old-tab'
  let session = 'old-session'
  let host = 'old-host'
  const { work, client, inboxes, pushes, events } = fixture({
    inbox: () => box([request]), tabId: () => tab, sessionId: () => session, host: () => host,
    sample: () => promptToken,
  })
  tab = 'new-tab'
  session = 'new-session'
  host = 'new-host'
  assert.strictEqual(work.client, client)
  await work.poll()
  assert.deepEqual(inboxes, ['new-tab'])
  assert.ok(isDeepStrictEqual(pushes, [{
    session_id: 'new-session', trigger: 'hermes_request', tab_id: 'new-tab', host: 'new-host',
    lines: win.lines, range: { fromLine: 11, toLine: 12, at: 1234 }, prompt_sample: promptToken,
  }]), 'push must contain the current identifiers, captured window and sample')
  assert.deepEqual(ofType(events, 'push'), [{ type: 'push', requestId: 'req-1', lines: 2, trusted: false, samples: 0 }])
})

test('only a trusted push echo arms the real proposal service', async () => {
  let trusted = true
  const { work, service, events } = fixture({
    inbox: () => box([request], echo(!trusted)), pushContext: () => ({ prompt: echo(trusted) }),
  })
  await work.poll()
  assert.equal(work.armed(), true)
  assert.equal(service.armed(), true)
  trusted = false
  await work.poll()
  assert.equal(service.armed(), false)
  assert.deepEqual(ofType(events, 'push').map(event => event.trusted), [true, false])
})

test('malformed and missing prompt echoes clear a previously armed service', () => {
  const { service } = fixture()
  for (const malformed of [{ token: 123, trusted: true }, { token: '   ', trusted: true }, 'x', undefined, null]) {
    assert.equal(applyPromptEcho(service, echo()), true)
    assert.equal(service.armed(), true)
    assert.equal(applyPromptEcho(service, malformed), false)
    assert.equal(service.armed(), false)
  }
  assert.equal(applyPromptEcho(service, { ...echo(), trusted: 'true' }), false)
  assert.equal(service.armed(), false)
  assert.equal(applyPromptEcho({ setToken () { throw new Error() } }, echo()), false)
})

test('the app writer handles inbox and push echoes, including clearing, without calling service.setToken', async () => {
  let writesBehindApp = 0
  let items = [request]
  let prompt = echo()
  const calls = []
  const service = {
    setToken () {
      writesBehindApp++
      throw new Error('unexpected service write')
    },
  }
  const { work } = fixture({
    service, inbox: () => box(items, prompt), pushContext: () => ({ prompt: echo(false, 1) }),
    apply: (token, trusted) => calls.push({ matches: token === promptToken, cleared: token === '', trusted }),
  })
  await work.poll()
  items = []
  prompt = null
  await work.poll()
  assert.equal(writesBehindApp, 0)
  assert.deepEqual(calls, [
    { matches: true, cleared: false, trusted: true },
    { matches: true, cleared: false, trusted: false },
    { matches: false, cleared: true, trusted: false },
  ])
})

test('a throwing app writer does not arm the session or stop relay work', async () => {
  let proposals = 0
  const { work, inboxes, events } = fixture({
    inbox: () => box([request, proposal], echo()), pushContext: () => ({ prompt: echo() }),
    apply: () => { throw new Error('app write failed') }, onProposal: () => { proposals++ },
  })
  await work.poll()
  assert.equal(work.armed(), false)
  await work.poll()
  assert.equal(work.armed(), false)
  assert.equal(inboxes.length, 2)
  assert.equal(proposals, 2)
  assert.deepEqual(ofType(events, 'prompt'), [{ type: 'prompt', trusted: false, samples: 2 }])
  assert.deepEqual(ofType(events, 'push').map(event => event.trusted), [false, false])
})

test('inbox prompt changes are reported and a null inbox prompt disarms', async () => {
  let prompt = echo(true, 2)
  const { work, service, events } = fixture({ inbox: () => box([], prompt) })
  await work.poll()
  assert.equal(service.armed(), true)
  await work.poll()
  prompt = echo(true, 3)
  await work.poll()
  prompt = null
  await work.poll()
  assert.equal(service.armed(), false)
  assert.deepEqual(ofType(events, 'prompt'), [
    { type: 'prompt', trusted: true, samples: 2 },
    { type: 'prompt', trusted: true, samples: 3 },
    { type: 'prompt', trusted: false, samples: 0 },
  ])
})

test('the default proposal handler delegates only command, risk and why', async () => {
  const calls = []
  const service = { setToken () {}, propose: input => calls.push(input) }
  const { work, pushes } = fixture({ service, inbox: () => box([proposal, { ...proposal, why: undefined }]) })
  await work.poll()
  assert.deepEqual(calls, [
    { command: proposal.command, risk: proposal.risk, why: proposal.why },
    { command: proposal.command, risk: proposal.risk, why: '' },
  ])
  assert.equal(pushes.length, 0)
})

for (const [code, cause, status] of [['relay_token_invalid', 'token', 401], ['network', 'network', 0]]) {
  test(`inbox failure ${code} reports offline/${cause}`, async () => {
    const { work, service, events } = fixture({ inbox: () => { throw new RelayError(code, { status }) } })
    await work.poll()
    assert.equal(service.state(), 'offline')
    assert.equal(service.model().cause, cause)
    assert.deepEqual(events, [{ type: 'error', where: 'inbox', code }])
  })
}

test('no prompt_sample key is sent when sampling returns null', async () => {
  const { work, pushes } = fixture({ inbox: () => box([request]), sample: () => null })
  await work.poll()
  assert.equal(pushes.length, 1)
  assert.equal(Object.hasOwn(pushes[0], 'prompt_sample'), false)
})

test('missing and invalid capture windows skip the push and never sample', async () => {
  let capture
  let sampleCalls = 0
  const { work, pushes, events } = fixture({
    inbox: () => box([request]), capture: () => capture, sample: () => { sampleCalls++; return null },
  })
  for (capture of [null, {}, { ...win, toLine: 13 }, { ...win, lines: [null, 'hello'] }]) await work.poll()
  assert.equal(pushes.length, 0)
  assert.equal(sampleCalls, 0)
  assert.deepEqual(ofType(events, 'skipped').map(event => event.reason), [
    'no_window', 'bad_window', 'bad_window', 'bad_window',
  ])
})

test('events never serialize the prompt token or relay bearer, even on errors', async () => {
  const bearer = randomUUID()
  const { work, events } = fixture({
    inbox: () => box([request, proposal], echo()), pushContext: () => ({ prompt: echo() }),
    onProposal: () => { throw new Error(`${promptToken} ${bearer}`) },
  })
  await work.poll()
  assert.equal(JSON.stringify(events).includes(promptToken), false)
  assert.equal(JSON.stringify(events).includes(bearer), false)
  assert.deepEqual(ofType(events, 'error'), [{ type: 'error', where: 'proposal', code: 'internal_error' }])
})

test('overlapping polls skip without making a second inbox request', async () => {
  const { promise, resolve } = Promise.withResolvers()
  const { work, inboxes } = fixture({ inbox: () => promise })
  const pending = work.poll()
  assert.deepEqual(await work.poll(), { skipped: true })
  assert.equal(inboxes.length, 1)
  resolve(box())
  await pending
  await work.poll()
  assert.equal(inboxes.length, 2)
})

test('a throwing proposal callback and a failed push do not drop later items', async () => {
  const handled = []
  const next = { ...proposal, proposal_id: 'prop-2' }
  const { work, pushes, events } = fixture({
    inbox: () => box([proposal, request, next, { kind: 'other' }]),
    onProposal: item => {
      handled.push(item)
      if (item === proposal) throw new Error('callback failed')
    },
    pushContext: () => { throw new RelayError('bad_request') },
  })
  await work.poll()
  assert.deepEqual(handled, [proposal, next])
  assert.equal(pushes.length, 1)
  assert.deepEqual(events.slice(1), [
    { type: 'error', where: 'proposal', code: 'internal_error' },
    { type: 'error', where: 'push', code: 'bad_request' },
    { type: 'proposal', proposalId: next.proposal_id, risk: next.risk },
    { type: 'ignored', kind: 'other' },
  ])
})

test('start registers the tab before polling and refreshes registration every 60 polls', async t => {
  let host = 'host.test'
  const calls = []
  const { work, client, inboxes } = fixture({
    tabId: () => 'tab-1', sessionId: () => 'session-1', host: () => host,
    inbox: () => { calls.push({ inbox: true }); return box() }, pollMs: 60_000,
  })
  client.registerTab = async input => { calls.push(input) }
  t.after(work.stop)
  work.start()
  work.start()
  assert.deepEqual(calls, [{ tabId: 'tab-1', sessionId: 'session-1', host }, { inbox: true }])
  await setImmediate()
  for (let i = 1; i < 59; i++) await work.poll()
  assert.equal(inboxes.length, 59)
  assert.equal(calls.length, 60, 'registration must not repeat before the 60th poll')
  host = 'new.test'
  await work.poll()
  assert.equal(inboxes.length, 60)
  assert.deepEqual(calls.slice(60), [{ inbox: true }, { tabId: 'tab-1', sessionId: 'session-1', host }])
})

test('a network failure registering the tab reports an error and the next tick still polls', async t => {
  const { promise, resolve, reject } = Promise.withResolvers()
  const deadline = setTimeout(() => reject(new Error('the next inbox poll did not run')), 1000)
  t.after(() => clearTimeout(deadline))
  let polls = 0
  const { work, client, events } = fixture({
    pollMs: 5,
    inbox: () => {
      if (++polls === 2) resolve()
      return box()
    },
  })
  client.registerTab = async () => { throw new RelayError('network') }
  t.after(work.stop)
  work.start()
  assert.equal(polls, 1)
  await promise
  assert.equal(polls, 2)
  assert.deepEqual(ofType(events, 'error'), [{ type: 'error', where: 'register', code: 'network' }])
})

test('start with an older client polls immediately and stop discards a pending inbox', async (t) => {
  const { promise, resolve } = Promise.withResolvers()
  const { work, client, inboxes, pushes, events } = fixture({ inbox: () => promise })
  assert.equal(typeof client.registerTab, 'undefined')
  t.after(work.stop)
  work.start()
  work.start()
  assert.deepEqual(events, [{ type: 'started' }])
  assert.equal(inboxes.length, 1)
  work.stop()
  resolve(box([request], echo()))
  assert.deepEqual(await work.poll(), { skipped: true })
  assert.equal(work.armed(), false)
  assert.equal(pushes.length, 0)
})

test('the real client forwards requested samples to the relay ledger, which decides when to arm', async () => {
  const store = createStore()
  const bearer = randomUUID()
  const routes = []
  const client = createRelayClient({
    baseUrl: 'https://relay.test', token: bearer,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname
      routes.push([options.method, path])
      if (options.headers.Authorization !== `Bearer ${bearer}`) return new Response(null, { status: 401 })
      const { body, status } = options.method === 'GET'
        ? store.inbox(path.split('/').at(-1)) : store.pushContext(JSON.parse(options.body))
      return Response.json(body, { status })
    },
  })
  const { work, service } = fixture({ client, sample: () => promptToken })
  await assert.rejects(client.inbox(' '), { code: 'bad_request', relayCode: 'tab_id_missing' })
  assert.equal(routes.length, 0)
  await work.poll()
  assert.equal(service.armed(), false)
  for (const trusted of [false, true]) {
    assert.equal(store.createContextRequest({ tab_id: 'tab-1', session_id: 'session-1' }).status, 200)
    await work.poll()
    assert.equal(service.armed(), trusted)
  }
  assert.deepEqual(routes, [
    ['GET', '/v1/inbox/tab-1'],
    ['GET', '/v1/inbox/tab-1'], ['POST', '/v1/context.push'],
    ['GET', '/v1/inbox/tab-1'], ['POST', '/v1/context.push'],
  ])
})
