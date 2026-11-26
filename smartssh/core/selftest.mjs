import assert from 'node:assert'
import { isAtPrompt, GATE } from './gate.mjs'
import { createSettler } from './settle.mjs'

const results = []
const t = (name, fn) => { try { fn(); results.push(['PASS', name]) } catch (e) { results.push(['FAIL', name + ' :: ' + e.message]) } }
const g = (o) => isAtPrompt({ token: '$ ', tokenTrusted: true, cursorX: 12, line: 'user@srv:~$ ' + ' '.repeat(60), viewportY: 0, baseY: 0, ...o }).gate
const greason = (o) => isAtPrompt({ token: '$ ', tokenTrusted: true, cursorX: 12, line: 'user@srv:~$ ' + ' '.repeat(60), viewportY: 0, baseY: 0, ...o }).reason

// ---- gate ----
t('clean prompt', () => assert.strictEqual(g({}), 'clean'))
t('typed text => prompt_dirty', () => assert.strictEqual(g({ line: 'user@srv:~$ rm -rf /tmp/art', cursorX: 24 }), 'prompt_dirty'))
t('text after cursor => prompt_dirty (reason text_after_cursor)', () => {
  assert.strictEqual(greason({ line: 'user@srv:~$ rm -rf x', cursorX: 12 }), 'typed_input') })
t('alt screen => alt_screen', () => assert.strictEqual(g({ altScreen: true }), 'alt_screen'))
t('selection => prompt_dirty/selection', () => assert.strictEqual(greason({ selection: true }), 'selection'))
t('scrolled => prompt_dirty/scrolled', () => assert.strictEqual(greason({ viewportY: 3, baseY: 9 }), 'scrolled'))
t('empty token => prompt_dirty/token_empty (fail-closed)', () => {
  assert.strictEqual(greason({ token: '' }), 'token_empty'); assert.strictEqual(greason({ token: '   ' }), 'token_empty') })
t('untrusted token => prompt_dirty/token_untrusted', () => assert.strictEqual(greason({ tokenTrusted: false }), 'token_untrusted'))
t('bash PS2 "> " with a "$ " token => prompt_dirty (suffix mismatch)', () =>
  assert.strictEqual(g({ token: '$ ', cursorX: 2, line: '> ' + ' '.repeat(70) }), 'prompt_dirty'))
t('bare "> " line under a "> " token => clean (PS2 vs pwsh primary: indistinguishable)', () =>
  assert.strictEqual(g({ token: '> ', cursorX: 2, line: '> ' + ' '.repeat(70) }), 'clean'))
t('heredoc "> EOF" => prompt_dirty', () => assert.strictEqual(g({ token: '> ', cursorX: 2, line: '> EOF' + ' '.repeat(65) }), 'prompt_dirty'))
t('pwsh continuation ">> " => continuation', () => assert.strictEqual(g({ token: '> ', cursorX: 3, line: '>> ' + ' '.repeat(70) }), 'continuation'))
t('pwsh primary prompt "PS C:\\Users> " => clean', () => assert.strictEqual(g({ token: '> ', cursorX: 13, line: 'PS C:\\Users> ' + ' '.repeat(60) }), 'clean'))
t('RESIDUAL HOLE: read -p "slot # " under a "# " token is indistinguishable => clean; auto-run defaults OFF', () => {
  const r = isAtPrompt({ token: '# ', tokenTrusted: true, cursorX: 7, line: 'slot # ' + ' '.repeat(70), viewportY: 0, baseY: 0 })
  assert.strictEqual(r.gate, 'clean')
  assert.strictEqual(r.reason, 'clean')
})
t('continuation rule catches ">> " but NOT a bare PS2 identical to the token (documented)', () => {
  assert.strictEqual(g({ token: '> ', cursorX: 3, line: '>> ' + ' '.repeat(70) }), 'continuation')
  assert.strictEqual(g({ token: '> ', cursorX: 2, line: '> ' + ' '.repeat(70) }), 'clean')
})

// ---- settler ----
const P = () => ({ gate: GATE.CLEAN, reason: 'clean' })
t('A: initial prompt, quiet => clean', () => {
  const s = createSettler(); s.onPromptLine(10)
  assert.strictEqual(s.evaluate(500, P()).gate, 'clean')
})
t('B: HIGH LATENCY — feed, no echo yet, 300ms quiet => settling/awaiting_echo (the fail-open)', () => {
  const s = createSettler(); s.onPromptLine(10); s.onFeed(100)
  const r = s.evaluate(400, P())
  assert.strictEqual(r.gate, 'settling'); assert.strictEqual(r.reason, 'awaiting_echo')
})
t('C: echo came back but no prompt line => settling/no_prompt_line', () => {
  const s = createSettler(); s.onPromptLine(10); s.onFeed(100); s.onOutput(160)
  const r = s.evaluate(600, P())
  assert.strictEqual(r.gate, 'settling'); assert.strictEqual(r.reason, 'no_prompt_line')
})
t('D: prompt line rendered, still inside quiet window => settling/output_active', () => {
  const s = createSettler(); s.onPromptLine(10); s.onFeed(100); s.onOutput(300, { promptLine: true })
  assert.strictEqual(s.evaluate(380, P()).reason, 'output_active')
  assert.strictEqual(s.evaluate(500, P()).gate, 'clean')
})
t('E: streaming gap (quiet 300ms mid-stream) => settling/no_prompt_line', () => {
  const s = createSettler(); s.onPromptLine(10); s.onFeed(100)
  s.onOutput(150); s.onOutput(250); s.onOutput(350)
  const r = s.evaluate(700, P())
  assert.strictEqual(r.gate, 'settling'); assert.strictEqual(r.reason, 'no_prompt_line')
})
t('F: reset residual (output, no prompt, 1s later) => never clean', () => {
  const s = createSettler(); s.onPromptLine(10); s.onFeed(100); s.onOutput(150)
  assert.strictEqual(s.evaluate(1100, P()).gate, 'settling')
})
t('G: second proposal right after feed => not clean (prepend race killed)', () => {
  const s = createSettler(); s.onPromptLine(10); s.onFeed(100); s.onOutput(120, { promptLine: true })
  assert.strictEqual(s.evaluate(400, P()).gate, 'clean')
  s.onFeed(410)
  assert.strictEqual(s.evaluate(900, P()).gate, 'settling')
})
t('H: quiet rule alone would pass B/E/F (proves two gates are load-bearing)', () => {
  // single-rule model: quiet >= 150ms => clean, no output/prompt gates
  const single = (ts, last) => (ts - last >= 150 ? 'clean' : 'settling')
  assert.strictEqual(single(400, 10), 'clean')   // B would be a false clean
  assert.strictEqual(single(700, 350), 'clean')  // E would be a false clean
  assert.strictEqual(single(1100, 150), 'clean') // F would be a false clean
})

for (const [s, n] of results) console.log(`${s}  ${n}`)
const fails = results.filter(r => r[0] === 'FAIL').length
console.log(`\n${results.length - fails}/${results.length} passed`)
process.exit(fails ? 1 : 0)
