// contract: v53
// smartssh/verify/armed-flow.test.mjs — the ARMED path, end to end, headless (Linux-runnable).
//
// The v1.0.246 acceptance only ever exercised the unarmed path: every ci-status metrics file says
// `trust: 'watch'`, `trustVisible.armed: false`, `gateReason: 'token_empty'`. Nothing pinned what
// an ARMED session must produce, so "armed shows ARMED and dispatch really executes" was an
// untested claim. These cases are that contract:
//
//   1. an armed measurement carries trustVisible.armed === true and no blocking gate reason,
//   2. an armed live session writes a metrics document the real judge accepts at trust 'propose',
//   3. an approval on an armed session dispatches the exact relay target (injected fake relay),
//   4. an unarmed session can never dispatch (negative control),
//   5. the same two flows against the real relay v2 server: the armed proposal is executed by the
//      relay, the unarmed one is still only 'proposed'.
//
// No command is executed anywhere: the relay client is injected in cases 3/4 and case 5 runs the
// real relay server on loopback. No token is ever printed or written.
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import pkg from '@xterm/headless'

import { buildMeasurement, createProposalService } from '../app/proposalService.mjs'
import { createRelayBridge } from '../app/relayBridge.mjs'
import { createRelayClient } from '../app/relayClient.mjs'
import { createRelay } from '../relay/server.mjs'
import { createStore } from '../relay/state.mjs'
import { CASE_IDS, judgeMetrics, summarise } from '../core/metrics.mjs'

const { Terminal } = pkg

const PROMPT = '\x1b[32mhermes@srv:~$\x1b[0m '
const TOKEN = '$ '
const BUILD = { version: '1.0.999 · local.1 · armedflow', sha256: 'a'.repeat(64), commit: 'armedfl' }

const write = (term, text) => new Promise(resolve => term.write(text, resolve))

function fakeClock (start = 1000) {
  let t = start
  return { now: () => t, advance (ms) { t += ms; return t } }
}

/** The injectable buffer reader, backed by a real xterm buffer. */
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

/** A real xterm session + service. `trusted` is the whole point: it is the armed state. */
async function session ({ trusted = true, token = TOKEN, extra = {} } = {}) {
  const term = new Terminal({ cols: 78, rows: 7, allowProposedApi: true })
  await write(term, PROMPT)
  const clock = fakeClock()
  const service = createProposalService({
    buffer: () => reader(term),
    token: { token, tokenTrusted: trusted },
    clock,
    intervalMs: 0,
    schedule: false,
    quietMs: 150,
    autoRun: 'off',
    ...extra,
  })
  const quietTick = () => { clock.advance(200); return service.tick() }
  const cleanup = () => { service.stop(); term.dispose() }
  return { term, clock, service, quietTick, cleanup }
}

const waitFor = async (predicate, { ms = 3000, step = 20 } = {}) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, step))
  }
  return predicate()
}

// ---------------------------------------------------------------- 1. the measurement contract
test('armed measurement: trustVisible.armed true, and no blocking gate reason', () => {
  // Armed is a live boolean, never an assumption.
  assert.throws(() => buildMeasurement('683x512'), /requires the live armed state/)

  const armed = buildMeasurement('683x512', { armed: true })
  assert.equal(armed.trustVisible.armed, true)
  // `gateReason` is the blocking reason. An armed case carries none: a bare armed measurement
  // records the empty string (never a stale `token_empty`), and the live armed path below records
  // the gate it was taken at ('clean'). Null is not a value this field ever holds — see the note
  // in the case-2 assertion.
  assert.equal(armed.trustVisible.gateReason, '')
  assert.ok(!['token_empty', 'token_untrusted'].includes(armed.trustVisible.gateReason))

  // An unarmed case must explain itself, and that explanation is the visible trust state.
  const unarmed = buildMeasurement('683x512', { armed: false, gateReason: 'token_empty' })
  assert.equal(unarmed.trustVisible.armed, false)
  assert.equal(unarmed.trustVisible.gateReason, 'token_empty')
  assert.throws(() => buildMeasurement('683x512', { armed: false }), /must carry reading\.gateReason/)
})

// ---------------------------------------------------------------- 2. the metrics document
test('armed live session: metrics carry armed:true at trust propose and pass the judge', async () => {
  const writes = []
  const { service, quietTick, cleanup } = await session({
    extra: {
      metrics: true,
      metricsPath: 'memory-only',
      writeFile: (path, text) => { writes.push({ path, text }) },
      build: BUILD,
      // One case backed by a real runtime viewport, so the document has a live measurement.
      measurement: caseId => caseId === '683x512'
        ? { measuredViewport: { wCss: 683, hCss: 512, devicePixelRatio: 1.25, rows: 24, cols: 78, heightPx: 432, cellHeightPx: 18 } }
        : {},
    },
  })
  try {
    service.tick()
    assert.equal(service.armed(), true, 'a trusted prompt token is what arms the session')
    assert.equal(service.gate().gate, 'clean')
    assert.equal(service.gate().reason, 'clean')
    assert.deepEqual(service.propose({ command: 'ls -la', risk: 'read' }), { queued: true })
    quietTick()
    assert.equal(service.state(), 'proposed')

    const { doc } = service.flushMetrics()
    assert.deepEqual(doc.cases.map(c => c.case).sort(), [...CASE_IDS].sort())
    for (const c of doc.cases) {
      assert.equal(c.trustVisible.armed, true, `${c.case} trustVisible.armed`)
      assert.equal(c.trust, 'propose', `${c.case} trust`)
      // The armed document records the gate it was measured at; the point is that the reason is
      // the real gate ('clean'), not an arming failure ('token_empty'/'token_untrusted').
      assert.equal(c.gate, 'clean', `${c.case} gate`)
      assert.equal(c.gateReason, 'clean', `${c.case} gateReason`)
      assert.equal(c.trustVisible.gateReason, c.gateReason, `${c.case} trustVisible.gateReason`)
    }
    assert.ok(doc.cases.some(c => c.trustVisible.armed === true))

    // The armed document is not just well-shaped: the real judge must accept it with nothing
    // skipped, because a skipped armed assertion would read as green in a CI summary line.
    const results = judgeMetrics(doc, { commit: BUILD.commit, sha256: BUILD.sha256 })
    const summary = summarise(results)
    assert.equal(summary.fail, 0, results.filter(r => r.status === 'FAIL').map(r => `${r.name}: ${r.detail}`).join('\n'))
    assert.equal(summary.skip, 0)
    const armedChecks = results.filter(r => r.name.endsWith('armed flag is derived from the live trust level'))
    assert.equal(armedChecks.length, CASE_IDS.length, 'every case is checked for the armed flag')
    assert.ok(armedChecks.every(r => r.status === 'PASS'))
    assert.ok(writes.length >= 1, 'the document reached the injected writer')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------- 3. dispatch (fake relay)
function fakeRelay (calls) {
  return {
    async getProposal (id) { return { id, status: 'pending' } },
    async dispatch (payload) { calls.push(payload); return { replay: false, execution: { status: 'executing', command_id: payload.commandId } } },
  }
}

test('armed approval dispatches the exact relay target', async () => {
  const calls = []
  const { service, quietTick, cleanup } = await session()
  const bridge = createRelayBridge({
    service,
    client: fakeRelay(calls),
    config: { configured: true, cause: '' },
    proposalId: 'proposal-armed',
    tabId: 'tab-armed',
    sessionId: 'session-armed',
    commandId: () => 'command-armed',
  })
  bridge.start()
  try {
    service.tick()
    service.propose({ command: 'printf armed', risk: 'read' })
    quietTick()
    assert.equal(service.state(), 'proposed')
    assert.equal(service.approve(), 'executing')
    assert.ok(await waitFor(() => calls.length === 1), `dispatch never left the bridge (calls=${calls.length})`)
    // The relay owns proposal/tab/session ids: the payload must echo exactly those, not invented ones.
    assert.deepEqual(calls[0], {
      commandId: 'command-armed',
      proposalId: 'proposal-armed',
      tabId: 'tab-armed',
      sessionId: 'session-armed',
      confirm: undefined,
    })
    assert.equal(service.state(), 'executing')
  } finally {
    bridge.stop()
    cleanup()
  }
})

// ---------------------------------------------------------------- 4. the negative control
test('unarmed session never dispatches', async () => {
  const calls = []
  // Untrusted token, and a second shape: trusted flag with a blank token. Neither is armed.
  for (const shape of [{ trusted: false }, { trusted: true, token: '   ' }]) {
    const { service, quietTick, cleanup } = await session(shape)
    const bridge = createRelayBridge({
      service,
      client: fakeRelay(calls),
      config: { configured: true, cause: '' },
      proposalId: 'proposal-unarmed',
      tabId: 'tab-unarmed',
      sessionId: 'session-unarmed',
      commandId: () => 'command-unarmed',
    })
    bridge.start()
    try {
      service.tick()
      assert.equal(service.armed(), false, `armed must be false for ${JSON.stringify(shape)}`)
      assert.notEqual(service.gate().gate, 'clean')
      assert.ok(['token_untrusted', 'token_empty'].includes(service.gate().reason))
      service.propose({ command: 'printf nope', risk: 'read' })
      quietTick()
      // The gate, not the proposal call, decides: no bar state is ever entered, so there is no
      // approve edge for the bridge to see.
      assert.equal(service.state(), null)
      assert.equal(service.approve(), null)
      assert.equal(await waitFor(() => calls.length > 0, { ms: 200 }), false, 'unarmed must not dispatch')
    } finally {
      bridge.stop()
      cleanup()
    }
  }
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------- 5. real relay v2 server
test('real relay v2: the armed proposal is executed, the unarmed one stays proposed', async (t) => {
  const token = 'armed-flow-test-token'
  const previousToken = process.env.RELAY_TOKEN
  const previousDev = process.env.RELAY_DEV
  delete process.env.RELAY_DEV
  process.env.RELAY_TOKEN = token
  const store = createStore()
  const server = createRelay({ store })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
    if (previousToken === undefined) delete process.env.RELAY_TOKEN
    else process.env.RELAY_TOKEN = previousToken
    if (previousDev !== undefined) process.env.RELAY_DEV = previousDev
  }))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const ids = { tab_id: 'tab-relay', session_id: 'session-relay' }

  const makeProposal = () => {
    const created = store.createProposal({ ...ids, risk: 'read', command: 'echo armed' })
    assert.equal(created.status, 200, 'the relay must accept the proposal')
    return created.body.proposal_id
  }

  const armedId = makeProposal()
  const armed = await session()
  const armedClient = createRelayClient({ baseUrl, token, timeoutMs: 2000 })
  const armedBridge = createRelayBridge({
    service: armed.service,
    client: armedClient,
    config: { configured: true, cause: '' },
    proposalId: armedId,
    tabId: ids.tab_id,
    sessionId: ids.session_id,
    commandId: () => 'command-relay-armed',
  })
  armedBridge.start()
  try {
    armed.service.tick()
    armed.service.propose({ command: 'echo armed', risk: 'read' })
    armed.quietTick()
    assert.equal(armed.service.state(), 'proposed')
    assert.equal(armed.service.approve(), 'executing')
    assert.ok(await waitFor(() => store.dispatchCount === 1), `relay recorded no dispatch (count=${store.dispatchCount})`)
    // The relay itself moved the proposal: this is a real POST /v1/command.dispatch, not a stub.
    assert.equal(store.proposals.get(armedId).status, 'executing')
  } finally {
    armedBridge.stop()
    armed.cleanup()
  }

  // Same bridge, same relay, same ids — only arming differs.
  const unarmedId = makeProposal()
  const unarmed = await session({ trusted: false })
  const unarmedBridge = createRelayBridge({
    service: unarmed.service,
    client: createRelayClient({ baseUrl, token, timeoutMs: 2000 }),
    config: { configured: true, cause: '' },
    proposalId: unarmedId,
    tabId: ids.tab_id,
    sessionId: ids.session_id,
    commandId: () => 'command-relay-unarmed',
  })
  unarmedBridge.start()
  try {
    unarmed.service.tick()
    unarmed.service.propose({ command: 'echo armed', risk: 'read' })
    unarmed.quietTick()
    assert.equal(unarmed.service.state(), null)
    assert.equal(unarmed.service.approve(), null)
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(store.dispatchCount, 1, 'the unarmed session must not add a dispatch')
    assert.equal(store.proposals.get(unarmedId).status, 'proposed', 'the relay never saw an approval')
  } finally {
    unarmedBridge.stop()
    unarmed.cleanup()
  }
})
