// SmartSSH proposal service — buffer -> gate -> settler -> bar model.
//
// Two rules for this file:
//  1. the buffer is a REAL @xterm/headless buffer fed real ANSI byte streams (a hand-built cell
//     grid has already passed while the real buffer was red twice in this repo);
//  2. every assertion is about what the bar would see: state, gate reason, emitted model, and the
//     controls barModel() allows — not about internal fields.
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '@xterm/headless'

import { createProposalService, buildMeasurement, CASE_SPEC } from './proposalService.mjs'
import { STATES } from '../core/barModel.mjs'
import { CASE_IDS, judgeMetrics, parseMetrics, summarise } from '../core/metrics.mjs'

const { Terminal } = pkg

const HERE = dirname(fileURLToPath(import.meta.url))

const write = (term, text) => new Promise(resolve => term.write(text, resolve))
const PROMPT = '\x1b[32mhermes@srv:~$\x1b[0m '
const TOKEN = '$ '

function head (cols = 80, rows = 6) {
  return new Terminal({ cols, rows, allowProposedApi: true })
}

/** The injectable buffer reader, backed by a real xterm buffer. */
function reader (term, extra = {}) {
  const active = () => term.buffer.active
  return {
    get cols () { return term.cols },
    get rows () { return term.rows },
    get cursorX () { return active().cursorX },
    get cursorY () { return active().cursorY },
    get baseY () { return active().baseY },
    get viewportY () { return active().viewportY },
    get altScreen () { return active().type === 'alternate' },
    getLine (y) { return active().getLine(y) },
    ...extra,
  }
}

function fakeClock (start = 1000) {
  let t = start
  return { now: () => t, advance (ms) { t += ms; return t }, set (v) { t = v; return t } }
}

function makeService (term, opts = {}) {
  const clock = opts.clock ?? fakeClock()
  const service = createProposalService({
    buffer: () => reader(term, opts.bufferExtra ?? {}),
    token: { token: TOKEN, tokenTrusted: true, ...opts.token },
    clock,
    intervalMs: 0,
    schedule: false,
    quietMs: 150,
    autoRun: opts.autoRun ?? 'off',
    ...opts.service,
  })
  const states = []
  service.subscribe(model => { if (model) states.push(model.state) })
  return { service, clock, states }
}

/** Settle the clock past the quiet window and run one poll. */
function quietTick (service, clock, ms = 200) {
  clock.advance(ms)
  return service.tick()
}

const total = []
function test (name, fn) {
  total.push([name, fn])
}

// ---------------------------------------------------------------- gate negatives
test('A. clean prompt (real ANSI) => proposed', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock, states } = makeService(term)
  service.tick()
  assert.equal(service.gate().gate, 'clean')
  assert.deepEqual(service.propose({ command: 'ls -la', risk: 'read', why: 'list files' }), { queued: true })
  quietTick(service, clock)
  const model = service.model()
  assert.equal(model.state, 'proposed')
  assert.equal(model.attrs['data-state'], 'proposed')
  assert.equal(model.gate.gate, 'clean')
  assert.equal(model.command, 'ls -la')
  assert.equal(model.attrs['data-auto-run'], 'off')
  assert.deepEqual(model.controls, ['approve', 'reject', 'expand'])
  assert.deepEqual(states, ['proposed'])
})

test('B. typed text with the caret moved back => typed_input, never proposed (real ANSI)', async () => {
  const term = head()
  await write(term, PROMPT)
  await write(term, 'rm -rf x')
  await write(term, '\x1b[15G')                       // caret back to just after the prompt
  const { service, clock } = makeService(term)
  service.tick()
  assert.equal(term.buffer.active.cursorX, 14)
  assert.equal(service.gate().reason, 'typed_input')
  service.propose({ command: 'echo hi', risk: 'read' })
  quietTick(service, clock)
  quietTick(service, clock)
  assert.equal(service.state(), null)
  assert.equal(service.model(), null)
})

test('C. alt screen => alt_screen, never proposed (real ANSI)', async () => {
  const term = head()
  await write(term, PROMPT)
  await write(term, '\x1b[?1049h\x1b[H\x1b[2Jtop - 12:00')
  const { service, clock } = makeService(term)
  service.tick()
  assert.equal(term.buffer.active.type, 'alternate')
  assert.equal(service.gate().gate, 'alt_screen')
  service.propose({ command: 'ls', risk: 'read' })
  quietTick(service, clock)
  assert.equal(service.state(), null)
})

test('D. selection => selection, never proposed', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock } = makeService(term, { bufferExtra: { selection: true } })
  service.tick()
  assert.equal(service.gate().reason, 'selection')
  service.propose({ command: 'ls', risk: 'read' })
  quietTick(service, clock)
  assert.equal(service.state(), null)
})

test('E. scrolled viewport => scrolled, never proposed (real scrollback)', async () => {
  const term = head(40, 6)
  for (let i = 0; i < 30; i++) await write(term, `line ${i}\r\n`)
  await write(term, PROMPT)
  term.scrollLines(-3)
  const { service, clock } = makeService(term)
  service.tick()
  assert.ok(term.buffer.active.baseY > 0, `baseY=${term.buffer.active.baseY}`)
  assert.notEqual(term.buffer.active.viewportY, term.buffer.active.baseY)
  assert.equal(service.gate().reason, 'scrolled')
  service.propose({ command: 'ls', risk: 'read' })
  quietTick(service, clock)
  assert.equal(service.state(), null)
})

test('F. empty or untrusted token => fail-closed (token_empty / token_untrusted)', async () => {
  const term = head()
  await write(term, PROMPT)
  const empty = makeService(term, { token: { token: '', tokenTrusted: true } })
  empty.service.tick()
  assert.equal(empty.service.gate().reason, 'token_empty')
  empty.service.propose({ command: 'ls', risk: 'read' })
  quietTick(empty.service, empty.clock)
  assert.equal(empty.service.state(), null)

  const untrusted = makeService(term, { token: { token: TOKEN, tokenTrusted: false } })
  untrusted.service.tick()
  assert.equal(untrusted.service.gate().reason, 'token_untrusted')
  untrusted.service.propose({ command: 'ls', risk: 'read' })
  quietTick(untrusted.service, untrusted.clock)
  assert.equal(untrusted.service.state(), null)
})

// ---------------------------------------------------------------- the execution cycle
test('G. feed then silence with no echo => settling (real ANSI)', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock } = makeService(term)
  service.tick()
  service.propose({ command: 'sleep 2', risk: 'read' })
  quietTick(service, clock)
  assert.equal(service.state(), 'proposed')
  assert.equal(service.approve(), 'executing')
  service.noteFeed()
  clock.advance(400)
  service.tick()                                       // still nothing on screen
  assert.equal(service.state(), 'settling')
  assert.equal(service.model().gateReason, 'awaiting_echo')
  assert.deepEqual(service.model().controls, ['cancel'])
})

test('H. output finished + prompt back => executing -> exited with the exit code (real ANSI)', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock, states } = makeService(term)
  service.tick()
  service.propose({ command: 'echo hi', risk: 'read' })
  quietTick(service, clock)
  service.approve()
  assert.equal(service.state(), 'executing')
  service.noteFeed()
  await write(term, 'echo hi\r\n')
  service.tick()                                       // echo arrived, no prompt line yet
  assert.ok(['executing', 'settling'].includes(service.state()))
  await write(term, 'hi\r\n')
  await write(term, PROMPT)
  service.noteExit(0)
  service.tick()                                       // output still hot
  quietTick(service, clock)                            // quiet window passed
  assert.equal(service.state(), 'exited')
  assert.equal(service.model().exitCode, 0)
  assert.equal(service.model().attrs['data-exit-code'], '0')
  assert.deepEqual(service.model().controls, ['dismiss'])
  assert.deepEqual(states.slice(0, 2), ['proposed', 'executing'])
  assert.ok(states.includes('exited'))
})

test('I. reject => rejected, dismiss returns to no bar', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock } = makeService(term)
  service.tick()
  service.propose({ command: 'rm -rf /tmp/art', risk: 'write' })
  quietTick(service, clock)
  assert.equal(service.reject(), 'rejected')
  assert.equal(service.model().state, 'rejected')
  assert.deepEqual(service.model().controls, ['dismiss', 'ask_again'])
  assert.equal(service.dismiss(), 'hidden')
  assert.equal(service.model(), null)
  assert.equal(service.state(), null)
})

test('J. dispatch failure => aborted; ctrl_c on a running command => aborted', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock } = makeService(term)
  service.tick()
  service.propose({ command: 'ls', risk: 'read' })
  quietTick(service, clock)
  service.approve()
  assert.equal(service.state(), 'executing')
  assert.equal(service.ctrlC(), 'aborted')
  assert.deepEqual(service.model().controls, ['dismiss', 'ask_again'])

  const other = makeService(term)
  other.service.tick()
  other.service.propose({ command: 'ls', risk: 'read' })
  quietTick(other.service, other.clock)
  other.service.approve()
  assert.equal(other.service.dispatchFailed(), 'aborted')
})

test('K. token lost while live => offline/token; reset_token is the remedy', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock } = makeService(term)
  service.tick()
  service.propose({ command: 'ls', risk: 'read' })
  quietTick(service, clock)
  service.setToken({ token: '', tokenTrusted: false })
  service.tick()
  assert.equal(service.state(), 'offline')
  assert.equal(service.model().cause, 'token')
  assert.equal(service.model().attrs['data-cause'], 'token')
  assert.deepEqual(service.model().controls, ['reset_token', 'copy_diag', 'dismiss'])
  assert.throws(() => service.retry(), /not a remedy for cause=token/)
  assert.equal(service.resetToken(), 'offline')
  service.setToken({ token: TOKEN, tokenTrusted: true })
  assert.equal(service.model().state, 'offline')       // a remedy does not fake a reconnect
  assert.equal(service.dismiss(), 'hidden')
})

test('L. network drop => offline/network; retry is the remedy, reset_token is not', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock } = makeService(term)
  service.tick()
  service.propose({ command: 'ls', risk: 'read' })
  quietTick(service, clock)
  service.approve()
  service.noteFeed()
  service.noteOffline('network')
  assert.equal(service.state(), 'offline')
  assert.equal(service.model().cause, 'network')
  assert.deepEqual(service.model().controls, ['retry', 'copy_diag', 'dismiss'])
  assert.throws(() => service.resetToken(), /not a remedy for cause=network/)
  assert.equal(service.retry(), 'offline')
  assert.equal(service.dismiss(), 'hidden')
})

test('M. auto-run on + read tier => counting, run_now executes', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock } = makeService(term, { autoRun: 'on' })
  service.tick()
  service.propose({ command: 'df -h', risk: 'read' })
  quietTick(service, clock)
  assert.equal(service.approve(), 'counting')
  assert.equal(service.model().attrs['data-auto-run'], 'on')
  assert.deepEqual(service.model().controls, ['run_now', 'cancel'])
  assert.equal(service.runNow(), 'executing')
})

test('N. auto-run on but write tier => executing, never counting', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock } = makeService(term, { autoRun: 'on' })
  service.tick()
  service.propose({ command: 'rm -rf build', risk: 'write' })
  quietTick(service, clock)
  assert.equal(service.approve(), 'executing')
})

test('O. unanswered proposal expires => expired', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock } = makeService(term, { service: { expireMs: 5000 } })
  service.tick()
  service.propose({ command: 'ls', risk: 'read' })
  quietTick(service, clock)
  assert.equal(service.state(), 'proposed')
  clock.advance(5001)
  service.tick()
  assert.equal(service.state(), 'expired')
  assert.deepEqual(service.model().controls, ['dismiss', 'ask_again'])
})

test('P. danger needs the confirm code, not approve', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock } = makeService(term)
  service.tick()
  service.propose({ command: 'rm -rf /', risk: 'danger', confirm_expected: '8391' })
  quietTick(service, clock)
  assert.ok(service.model().controls.includes('confirm_code'))
  assert.throws(() => service.approve(), /danger requires confirm_code/)
  assert.throws(() => service.confirmCode('0000'), /confirm_code mismatch/)
  assert.equal(service.confirmCode('8391'), 'executing')
})

// ---------------------------------------------------------------- coverage + hygiene
test('Q. all nine bar states are reachable', async () => {
  const seen = new Set()
  const record = (s) => { if (s) seen.add(s) }

  // proposed -> expired
  let term = head(); await write(term, PROMPT)
  let run = makeService(term, { service: { expireMs: 1000 } })
  run.service.subscribe(m => record(m?.state))
  run.service.tick(); run.service.propose({ command: 'ls', risk: 'read' }); quietTick(run.service, run.clock)
  run.clock.advance(1001); run.service.tick()

  // counting -> executing
  term = head(); await write(term, PROMPT)
  run = makeService(term, { autoRun: 'on' })
  run.service.subscribe(m => record(m?.state))
  run.service.tick(); run.service.propose({ command: 'df -h', risk: 'read' }); quietTick(run.service, run.clock)
  run.service.approve(); run.service.runNow()

  // settling
  term = head(); await write(term, PROMPT)
  run = makeService(term)
  run.service.subscribe(m => record(m?.state))
  run.service.tick(); run.service.propose({ command: 'sleep 1', risk: 'read' }); quietTick(run.service, run.clock)
  run.service.approve(); run.service.noteFeed(); run.clock.advance(400); run.service.tick()

  // exited
  term = head(); await write(term, PROMPT)
  run = makeService(term)
  run.service.subscribe(m => record(m?.state))
  run.service.tick(); run.service.propose({ command: 'echo hi', risk: 'read' }); quietTick(run.service, run.clock)
  run.service.approve(); run.service.noteFeed()
  await write(term, 'echo hi\r\nhi\r\n' + PROMPT)
  run.service.tick(); quietTick(run.service, run.clock)

  // rejected
  term = head(); await write(term, PROMPT)
  run = makeService(term)
  run.service.subscribe(m => record(m?.state))
  run.service.tick(); run.service.propose({ command: 'ls', risk: 'read' }); quietTick(run.service, run.clock)
  run.service.reject()

  // aborted
  term = head(); await write(term, PROMPT)
  run = makeService(term)
  run.service.subscribe(m => record(m?.state))
  run.service.tick(); run.service.propose({ command: 'ls', risk: 'read' }); quietTick(run.service, run.clock)
  run.service.approve(); run.service.dispatchFailed()

  // offline
  term = head(); await write(term, PROMPT)
  run = makeService(term)
  run.service.subscribe(m => record(m?.state))
  run.service.tick(); run.service.propose({ command: 'ls', risk: 'read' }); quietTick(run.service, run.clock)
  run.service.noteOffline('network')

  assert.deepEqual([...seen].sort(), [...STATES].sort(), `missing: ${STATES.filter(s => !seen.has(s))}`)
})

test('R. published models always satisfy barModel(); controls never leak across states', async () => {
  const term = head()
  await write(term, PROMPT)
  const { service, clock } = makeService(term)
  const models = []
  service.subscribe(m => { if (m) models.push(m) })
  service.tick()
  service.propose({ command: 'echo hi', risk: 'read' })
  quietTick(service, clock)
  service.approve()
  service.noteFeed()
  await write(term, 'echo hi\r\nhi\r\n' + PROMPT)
  service.tick()
  quietTick(service, clock)
  assert.ok(models.length >= 3)
  for (const m of models) {
    assert.ok(STATES.includes(m.state))
    assert.equal(m.attrs['data-state'], m.state)
    assert.equal(m.policy, m.state === 'exited' ? 'mounted-collapsed' : 'mounted-open')
    if (m.state === 'executing') assert.ok(!m.controls.includes('approve'))
    if (m.state === 'proposed') assert.ok(!m.controls.includes('ctrl_c'))
    if (m.state === 'exited') assert.deepEqual(m.controls, ['dismiss'])
  }
})

test('S. stop() clears the timer and stops publishing; unsubscribe detaches', async () => {
  const term = head()
  await write(term, PROMPT)
  const clock = fakeClock()
  const service = createProposalService({
    buffer: () => reader(term),
    token: { token: TOKEN, tokenTrusted: true },
    clock,
    intervalMs: 10,
    quietMs: 150,
    schedule: false,
  })
  let calls = 0
  const off = service.subscribe(() => calls++)
  service.tick()
  service.propose({ command: 'ls', risk: 'read' })
  quietTick(service, clock)
  assert.equal(calls, 1)
  off()
  service.reject()
  assert.equal(calls, 1, 'unsubscribe must detach the listener')

  const monitored = makeService(term)
  monitored.service.tick()
  monitored.service.propose({ command: 'ls', risk: 'read' })
  quietTick(monitored.service, monitored.clock)
  monitored.service.start()
  monitored.service.stop()
  monitored.clock.advance(500)
  const before = monitored.service.state()
  monitored.service.tick()                              // tick() after stop() is a no-op
  assert.equal(monitored.service.state(), before)
  assert.equal(monitored.states.length, 1)
})

test('T. Xlarge: CJK prompt prefix is measured in cells, not UTF-16 units (real ANSI)', async () => {
  const term = head()
  await write(term, '\x1b[36m用戶@srv:~$\x1b[0m ')
  const { service, clock } = makeService(term)
  service.tick()
  assert.equal(service.gate().gate, 'clean', `cursorX=${term.buffer.active.cursorX}`)
  service.propose({ command: 'ls', risk: 'read' })
  quietTick(service, clock)
  assert.equal(service.state(), 'proposed')
})

// ---------------------------------------------------------------- metrics
test('U. SMARTSSH_MEASURE=1 (app default wiring) writes data/metrics.json for the three cases, armed', async () => {
  const term = head(78, 7)
  await write(term, PROMPT)
  const commit = (() => {
    try { return execSync('git rev-parse --short HEAD', { cwd: HERE, encoding: 'utf8' }).trim() } catch { return '0000000' }
  })()
  const build = { version: `1.0.238 · local.1 · ${commit}`, sha256: 'a'.repeat(64), commit }
  // No metrics/metricsPath option on purpose: exercise the app's env switch and real resolver
  // without overwriting any metrics evidence in the checkout.
  const dir = mkdtempSync(join(tmpdir(), 'smartssh-proposal-metrics-'))
  const metricsPath = join(dir, 'data', 'metrics.json')
  const env = { ...process.env }
  let parsed
  try {
    process.env.SMARTSSH_MEASURE = '1'
    process.env.SMARTSSH_MEASURE_PATH = metricsPath
    const { service, clock } = makeService(term, {
      service: {
        build,
        measurement: caseId => ({ rows: CASE_SPEC[caseId].viewport.rows }),
      },
    })
    service.tick()
    service.propose({ command: 'ls -la', risk: 'read' })
    quietTick(service, clock)
    service.reject()
    const flushed = service.flushMetrics()
    service.stop()

    assert.equal(flushed.path, resolve(metricsPath))
    parsed = parseMetrics(readFileSync(metricsPath, 'utf8'))
  } finally {
    process.env = env
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(parsed.error, undefined, `metrics.json invalid: ${parsed.error}`)
  assert.deepEqual(parsed.metrics.cases.map(c => c.case).sort(), [...CASE_IDS].sort())
  for (const c of parsed.metrics.cases) {
    // Armed comes from the trusted token, and the document carries the gate that was used.
    assert.equal(c.trustVisible.armed, true, `${c.case} trustVisible.armed`)
    assert.ok(c.gateReason.length > 0)
    assert.equal(c.trustVisible.gateReason, c.gateReason)
    assert.ok(['tab', 'rail', 'statusbar'].includes(c.trustVisible.where))
    assert.equal(c.bar.state, 'rejected')
    assert.equal(c.autoRun, 'off')
  }
  assert.ok(parsed.metrics.cases.every(c => c.gate === 'clean'))

  // the same judge core/metrics-check.mjs runs, with build identity supplied
  const results = judgeMetrics(parsed.metrics, { commit, sha256: build.sha256 })
  const summary = summarise(results)
  assert.equal(summary.fail, 0, results.filter(r => r.status === 'FAIL').map(r => `${r.name}: ${r.detail}`).join('\n'))
  assert.equal(summary.skip, 0)
  assert.ok(results.some(r => r.name.includes('683x512')))
  assert.ok(results.some(r => r.name.includes('911x512')))
  assert.ok(results.some(r => r.name.includes('900-high-split')))
})

test('V. measurement helpers require explicit armed and live geometry provenance', () => {
  assert.throws(() => buildMeasurement('1280x999'), /unknown case id/)
  // Arming is no longer assumed and an unarmed case must explain why.
  assert.throws(() => buildMeasurement('683x512'), /requires the live armed state/)
  assert.throws(() => buildMeasurement('683x512', { armed: false }), /must carry reading.gateReason/)
  assert.throws(() => buildMeasurement('683x512', { armed: true, measured: true, rows: 6 }), /must carry devicePixelRatio and dprSource/)
  const m = buildMeasurement('683x512', {
    armed: true, measured: true, devicePixelRatio: 2, dprSource: 'window.devicePixelRatio', rows: 6, cellHeightPx: 20,
  })
  assert.equal(m.viewport.rows, 6)
  assert.equal(m.viewport.heightPx, 120)
  assert.equal(m.trustVisible.armed, true)
  assert.equal(m.measured, true)
  assert.equal(m.declared, false)
  assert.equal(m.devicePixelRatio, 2)
  assert.equal(m.dprSource, 'window.devicePixelRatio')
})

test('W. flushing cached geometry after token removal still records the live armed and trust levels', async () => {
  const term = head()
  await write(term, PROMPT)
  let readings = 0
  const { service, clock } = makeService(term, {
    service: {
      metrics: true,
      metricsPath: 'memory-only',
      writeFile: () => {},
      build: { commit: 'local', sha256: 'a'.repeat(64) },
      measurement: () => { readings++; return {} },
    },
  })
  service.tick()
  service.propose({ command: 'ls', risk: 'read' })
  quietTick(service, clock)
  assert.equal(readings, CASE_IDS.length)
  service.setToken()
  const { doc } = service.flushMetrics()
  assert.equal(readings, CASE_IDS.length, 'flush uses cached geometry')
  for (const c of doc.cases) {
    assert.equal(c.trustVisible.armed, false)
    assert.equal(c.trust, 'watch')
    assert.equal(c.gateReason, 'clean', 'the gate still comes from the last published model')
    assert.equal(c.trustVisible.gateReason, c.gateReason)
  }
  service.stop()
})

// ---------------------------------------------------------------- runner
let fails = 0
for (const [name, fn] of total) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    fails++
    console.log(`FAIL  ${name} :: ${error.message}`)
  }
}
console.log(`\n${total.length - fails}/${total.length} passed`)
process.exit(fails ? 1 : 0)
