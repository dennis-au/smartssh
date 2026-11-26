// Integration test: REAL xterm buffer, not synthetic cells.
// Two bugs already shipped because synthetic cells were green and the real buffer was red,
// so this file is the third line of defence: it writes into @xterm/headless, leaves the cursor
// at the end of the prompt and asks the adapter about the hint the shell drew after it.
import pkg from '@xterm/headless'
const { Terminal } = pkg
import assert from 'node:assert'
import { tailIsHintFromSnapshot } from './tailhint.mjs'

const write = (t, s) => new Promise(res => t.write(s, res))

const results = []
const t_ = (name, fn) => { try { fn(); results.push(['PASS', name]) } catch (e) { results.push(['FAIL', name + ' :: ' + e.message]) } }

async function build ({ hint, dim = true, save = true }) {
  const term = new Terminal({ cols: 80, rows: 4, allowProposedApi: true })
  await write(term, '\x1b[32mhermes@srv:~$\x1b[0m ')
  if (save) await write(term, '\x1b7')                       // save cursor at prompt end
  await write(term, (dim ? '\x1b[2m' : '\x1b[22m') + hint + '\x1b[0m')
  if (save) await write(term, '\x1b8')                       // restore cursor to prompt end
  return term
}

function snapOf (term, { withEndCol = true } = {}) {
  const b = term.buffer.active
  const line = b.getLine(b.baseY + b.cursorY)
  const snap = {
    cursorX: b.cursorX,
    cols: term.cols,
    getCell: col => {
      const c = line.getCell(col)
      // real CellData exposes isDim()/isItalic()/getChars(); guard for nulls past the row end
      return c || null
    },
  }
  // getTrimmedLength() is internal in xterm 6; the public equivalent is
  // translateToString(false) with trailing whitespace removed.
  if (withEndCol) snap.endCol = line.translateToString(false).replace(/\s+$/, '').length
  return snap
}

// A. the real case: prompt + dim suggestion, cursor parked at the prompt end
const a = await build({ hint: 'git status --short' })
t_('A. real buffer: dim suggestion after cursor => TRUE (endCol path)', () => {
  assert.strictEqual(a.buffer.active.cursorX, 'hermes@srv:~$ '.length)
  assert.strictEqual(tailIsHintFromSnapshot(snapOf(a)), true)
})
t_('B. same buffer without endCol (trailing-padding trim path) => TRUE', () => {
  assert.strictEqual(tailIsHintFromSnapshot(snapOf(a, { withEndCol: false })), true)
})

// B. suggestion containing spaces must survive the padding trim
const b = await build({ hint: 'git commit -m "a b"' })
t_('C. suggestion with inner spaces => TRUE', () => {
  assert.strictEqual(tailIsHintFromSnapshot(snapOf(b)), true)
})

// C. un-styled text after the cursor is user text, not a hint
const c = await build({ hint: 'rm -rf /tmp/art', dim: false })
t_('D. normal-intensity text after cursor => FALSE', () => {
  assert.strictEqual(tailIsHintFromSnapshot(snapOf(c)), false)
})

// D. no tail at all
const d = new Terminal({ cols: 80, rows: 4, allowProposedApi: true })
await write(d, 'hermes@srv:~$ ')
t_('E. empty tail => FALSE', () => {
  assert.strictEqual(tailIsHintFromSnapshot(snapOf(d)), false)
  assert.strictEqual(tailIsHintFromSnapshot(snapOf(d, { withEndCol: false })), false)
})

// E. a full row of padding must never be mistaken for a hint
const e = new Terminal({ cols: 80, rows: 4, allowProposedApi: true })
await write(e, 'hermes@srv:~$ ')
await write(e, '\x1b[80G')                                  // jump to the last column
t_('F. cursor at row end, only padding after it => FALSE', () => {
  assert.strictEqual(tailIsHintFromSnapshot(snapOf(e, { withEndCol: false })), false)
})

for (const [s, n] of results) console.log(`${s}  ${n}`)
const fails = results.filter(r => r[0] === 'FAIL').length
console.log(`\n${results.length - fails}/${results.length} passed`)
process.exit(fails ? 1 : 0)
