// contract: v56
// smartssh/verify/armed-wired.test.mjs — the wired armed path, end to end, headless.
//
// t_eb63a8c0's finding: the armed path existed in the modules but nothing in the shipped app could
// ever arm, because no producer was wired. This spec pins the wire itself, against the real relay v2
// server and a real xterm buffer:
//
//   app (promptSample)  -> context.push { prompt_sample }      (only after a relay context request)
//   relay (ledger)      -> prompt { token, trusted, samples }  (trusted only on 2 agreeing samples)
//   app (relayWork)     -> setSmartSSHProposalToken(token, trusted) -> armed -> gate clean
//   relay (inbox)       -> proposal -> proposeSmartSSHCommand() -> bar mounts -> approve -> dispatch
//
// No command is executed, no exe is needed, and the token value is never printed by this file.
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import pkg from '@xterm/headless'

import { createProposalService } from '../app/proposalService.mjs'
import { createRelayBridge } from '../app/relayBridge.mjs'
import { createRelayClient } from '../app/relayClient.mjs'
import { createRelayWork } from '../app/relayWork.mjs'
import { promptSample } from '../core/promptSample.mjs'
import { createRelay } from '../relay/server.mjs'
import { createStore } from '../relay/state.mjs'
import { CASE_IDS, judgeMetrics, summarise } from '../core/metrics.mjs'

const { Terminal } = pkg

const TOKEN = 'armed-wired-relay-token'
const TAB = 'tab-wired'
const SESSION = 'session-wired'
const BUILD = { version: '1.0.999 · local.1 · wired', sha256: 'b'.repeat(64), commit: 'wiredar' }
// cmd.exe prints no trailing space; bash does. Both end in a prompt terminator.
const CMD_PROMPT = 'C:\\Users\\hermes>'

const write = (term, text) => new Promise(resolve => term.write(text, resolve))

function reader (term) {
  const active = () => term.buffer.active
  return {
    get cols () { return term.cols },
    get rows () { return term.rows },
    get cursorX () { return active().cursorX },
    get cursorY () { return active().cursorY },
    get baseY () { return active().baseY },
    get viewportY () { return active().viewportY },
    get altScreen () { return active().type === 'alternate' },
    get selection () { return false },
    getLine (y) { return active().getLine(y) },
  }
}

/** Exactly what baseTerminalTab.component.ts does: cells before/after the cursor, then promptSample. */
function sampleFrom (term) {
  const active = term.buffer.active
  const line = active.getLine(active.baseY + active.cursorY)
  if (!line) return null
  let prefix = ''
  let tail = ''
  for (let col = 0; col < term.cols; col++) {
    const cell = line.getCell(col)
    const chars = cell && typeof cell.getChars === 'function' ? cell.getChars() : ''
    if (col < active.cursorX) prefix += chars
    else tail += chars
  }
  return promptSample({
    prefix,
    tail,
    altScreen: active.type === 'alternate',
    selection: false,
    scrolled: active.viewportY !== active.baseY,
  }).token
}

/** The renderer's visible window as push lines. */
function windowFrom (term) {
  const active = term.buffer.active
  const baseY = active.baseY
  const lines = []
  for (let i = 0; i < term.rows; i++) {
    const line = active.getLine(baseY + i)
    lines.push(typeof line?.translateToString === 'function' ? line.translateToString(true) : '')
  }
  return { lines, fromLine: baseY + 1, toLine: baseY + term.rows }
}

/**
 * A submitted line, the way the app produces one: the feed is announced first, then the shell echoes
 * the command and redraws its prompt, then the poll sees the new output and the quiet window passes.
 */
async function submit (term, service, command = '') {
  service.noteFeed()
  await write(term, '\r\n' + (command ? command + '\r\n' : '') + CMD_PROMPT)
  await new Promise(resolve => setTimeout(resolve, 200))
  service.tick()
  await new Promise(resolve => setTimeout(resolve, 200))
  service.tick()
}

const waitFor = async (predicate, { ms = 3000, step = 20 } = {}) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, step))
  }
  return predicate()
}

test('wired armed path: relay pushes arm the session, arm the metrics and deliver the bar', async (t) => {
  const previousToken = process.env.RELAY_TOKEN
  const previousDev = process.env.RELAY_DEV
  delete process.env.RELAY_DEV
  process.env.RELAY_TOKEN = TOKEN
  const store = createStore()
  const server = createRelay({ store })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
    if (previousToken === undefined) delete process.env.RELAY_TOKEN
    else process.env.RELAY_TOKEN = previousToken
    if (previousDev !== undefined) process.env.RELAY_DEV = previousDev
  }))

  const api = async (method, path, body) => {
    const response = await fetch(baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return response.json()
  }
  const listTab = async () => (await api('GET', '/v1/tabs')).tabs.find(tab => tab.tab_id === TAB)

  // ---- the app: a real xterm at a real cmd.exe prompt, with a live sample provider
  const term = new Terminal({ cols: 80, rows: 8, allowProposedApi: true })
  await write(term, CMD_PROMPT)
  const writes = []
  const service = createProposalService({
    buffer: () => reader(term),
    token: { token: '', tokenTrusted: false },
    clock: { now: Date.now },
    intervalMs: 0,
    schedule: false,
    quietMs: 100,
    autoRun: 'off',
    metrics: true,
    metricsPath: 'memory-only',
    writeFile: (path, text) => writes.push({ path, text }),
    build: BUILD,
    measurement: caseId => caseId === '683x512'
      ? { measuredViewport: { wCss: 683, hCss: 512, devicePixelRatio: 1, rows: 24, cols: 80, heightPx: 408, cellHeightPx: 17 } }
      : {},
  })
  t.after(() => { service.stop(); term.dispose() })

  const events = []
  // The renderer's rule: a sample is only eligible right after a submitted line.
  let sampleEligible = false
  const client = createRelayClient({ baseUrl, token: TOKEN, timeoutMs: 2000 })
  const work = createRelayWork({
    client,
    service,
    apply: (token, trusted) => service.setToken({ token, tokenTrusted: trusted }),
    tabId: TAB,
    sessionId: SESSION,
    host: 'local',
    capture: () => windowFrom(term),
    sample: () => (sampleEligible ? sampleFrom(term) : null),
    onEvent: event => events.push(event),
    pollMs: 60_000,
  })
  t.after(() => work.stop())

  // ---- 1. the app announces its tab; the trusted side can now find it
  work.start()
  assert.ok(await waitFor(() => store.tabs.has(TAB), { ms: 2000 }), 'start() must register the tab with the relay')
  const registered = store.tabs.get(TAB)
  assert.equal(registered.session_id, SESSION)
  assert.equal(registered.host, 'local')
  assert.equal((await listTab()).prompt, null, 'no sample yet: the relay owns no token')

  // ---- 2. first context request: a sample is pushed, the relay counts 1 and does not trust it
  service.tick()
  assert.equal(service.armed(), false, 'nothing can arm before the relay answered')
  await submit(term, service, 'echo hi')
  sampleEligible = true
  const first = await api('POST', '/v1/context.request', { tab_id: TAB, session_id: SESSION })
  assert.ok(first.request_id, 'the relay must accept a context request')
  await work.poll()
  const afterFirst = store.promptFor(TAB)
  assert.deepEqual(afterFirst, { token: '>', trusted: false, samples: 1 })
  service.tick()
  assert.equal(service.armed(), false, 'one sample is never trusted')
  assert.equal(service.gate().reason, 'token_untrusted')

  // ---- 3. a second agreeing sample flips the relay to trusted and the app arms
  await submit(term, service)
  sampleEligible = true
  await api('POST', '/v1/context.request', { tab_id: TAB, session_id: SESSION })
  await work.poll()
  assert.deepEqual(store.promptFor(TAB), { token: '>', trusted: true, samples: 2 })
  await submit(term, service)
  assert.equal(service.armed(), true, 'the relay-verified token is what arms the tab')
  assert.equal(service.gate().gate, 'clean')
  assert.equal(service.gate().reason, 'clean')
  // The arming signal is the push response's echo; the pre-push inbox read can only be one sample old.
  const lastSignal = events.filter(event => event.type === 'prompt' || event.type === 'push').pop()
  assert.equal(lastSignal.trusted, true)
  assert.equal(lastSignal.samples, 2)

  // ---- 4. the metrics document of the armed session, judged by the real judge
  const { doc } = service.flushMetrics()
  assert.ok(doc.cases.some(c => c.trustVisible.armed === true))
  for (const id of CASE_IDS) {
    const c = doc.cases.find(x => x.case === id)
    assert.equal(c.trustVisible.armed, true, `${id} armed`)
    assert.equal(c.trust, 'propose', `${id} trust`)
    assert.equal(c.gateReason, 'clean', `${id} gateReason`)
    assert.notEqual(c.gateReason, 'token_empty')
  }
  const results = judgeMetrics(doc, { commit: BUILD.commit, sha256: BUILD.sha256 })
  const summary = summarise(results)
  assert.equal(summary.fail, 0, results.filter(r => r.status === 'FAIL').map(r => `${r.name}: ${r.detail}`).join('\n'))
  assert.equal(summary.skip, 0)
  assert.ok(writes.length >= 1)

  // ---- 5. a proposal on the relay reaches the app through the inbox and mounts the bar
  const proposal = await api('POST', '/v1/proposal', { tab_id: TAB, session_id: SESSION, risk: 'read', command: 'echo armed', why: 'wired' })
  assert.ok(proposal.proposal_id)
  const bridge = createRelayBridge({
    service,
    // The real client: the approval must be a real POST /v1/command.dispatch against the real relay.
    client,
    config: { configured: true, cause: '' },
    proposalId: proposal.proposal_id,
    tabId: TAB,
    sessionId: SESSION,
    commandId: () => 'command-wired',
  })
  bridge.start()
  t.after(() => bridge.stop())
  // The real client is the one that must fetch the inbox; the bridge uses the fake above on purpose so
  // this case proves the inbox delivery and the dispatch target separately.
  const workWithProposal = createRelayWork({
    client,
    service,
    apply: (token, trusted) => service.setToken({ token, tokenTrusted: trusted }),
    tabId: TAB,
    sessionId: SESSION,
    host: 'local',
    capture: () => windowFrom(term),
    sample: () => null,
    onProposal: item => {
      assert.equal(item.proposal_id, proposal.proposal_id)
      service.propose({ command: item.command, risk: item.risk, why: item.why ?? '' })
    },
    pollMs: 60_000,
  })
  await workWithProposal.poll()
  // A clean prompt is all the bar needs; no new feed (a proposal queued while output is still in
  // flight enters the post-dispatch 'settling' path, which is a separate, pre-existing behaviour).
  service.tick()
  assert.equal(service.state(), 'proposed', 'a relay proposal must mount the bar')
  assert.equal(service.approve(), 'executing')
  assert.ok(await waitFor(() => store.dispatchCount === 1), 'the approval must reach the relay target')
  // The relay itself moved the proposal: a real POST, not a stub.
  assert.equal(store.proposals.get(proposal.proposal_id).status, 'executing')
  assert.equal((await api('GET', `/v1/proposal/${proposal.proposal_id}`)).status, 'executing')

  // ---- 6. the token never leaves the app-side echo: no event carries it
  for (const event of events) {
    assert.equal('token' in event, false, 'no event may carry a prompt token field')
    assert.equal('prompt' in event, false, 'no event may carry the raw prompt echo')
  }
  assert.ok(!JSON.stringify(events).includes(TOKEN), 'events must not carry the relay token')
})
