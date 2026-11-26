import pkg from '@xterm/headless'
const { Terminal } = pkg
import assert from 'node:assert'
import { gateInput } from './gateInput.mjs'
const write = (t, s) => new Promise(r => t.write(s, r))
const r = []; const t_ = (n, f) => { try { f(); r.push(['PASS', n]) } catch (e) { r.push(['FAIL', n + ' :: ' + e.message]) } }

async function scene (data) {
  const term = new Terminal({ cols: 60, rows: 4, allowProposedApi: true })
  await write(term, data)
  return term
}
const P = 'hermes@srv:~$ '
const opt = { token: '$ ', tokenTrusted: true }

const a = await scene(P)
t_('empty prompt => clean', () => assert.strictEqual(gateInput(a, opt).gate, 'clean'))

const b = await scene(P + '\x1b7\x1b[2mgit status --short\x1b8')
t_('dim suggestion after cursor => clean', () => assert.strictEqual(gateInput(b, opt).gate, 'clean'))

const c = await scene(P + 'rm -rf /tmp/art')
t_('half-typed command => prompt_dirty', () => assert.strictEqual(gateInput(c, opt).gate, 'prompt_dirty'))

const d = await scene(P + '\x1b[18G\x1b[22mXX\x1b[14G')
t_('caret moved back, user text after it => prompt_dirty', () => assert.strictEqual(gateInput(d, opt).gate, 'prompt_dirty'))

const e = await scene(P + '\x1b[?1049h')
t_('alternate screen => alt_screen', () => assert.strictEqual(gateInput(e, opt).gate, 'alt_screen'))

// CJK prompt: 5 wide chars before the cursor => column != code unit
const CJK = '[用户@主机 ~]$ '
const f = await scene(CJK)
t_('CJK prompt, empty => clean (column vs UTF-16 drift)', () => assert.strictEqual(gateInput(f, { token: '$ ', tokenTrusted: true }).gate, 'clean'))
const g = await scene(CJK + 'echo hi')
t_('CJK prompt + typed text => prompt_dirty', () => assert.strictEqual(gateInput(g, opt).gate, 'prompt_dirty'))

// control: the OLD string-slice path drifts on the same buffer, which is why cells are used
t_('control: line.slice(0,cursorX) would mis-slice a CJK prompt', () => {
  const b2 = f.buffer.active
  const line = b2.getLine(b2.baseY + b2.cursorY)
  const text = line.translateToString(false)
  const sliced = text.slice(0, b2.cursorX)
  assert.notStrictEqual(sliced, '[用户@主机 ~]$ ', 'slice is expected to drift; if it does not, this control is obsolete')
})

for (const [s, n] of r) console.log(`${s}  ${n}`)
const f2 = r.filter(x => x[0] === 'FAIL').length
console.log(`\n${r.length - f2}/${r.length} passed`)
process.exit(f2 ? 1 : 0)
