// SmartSSH prompt-clean gate — unit tests against a REAL xterm headless buffer.
// Tabby ships @xterm/xterm ^6.0.0; this runs @xterm/headless 6.0.0 — same buffer code.
// Run: node gate.test.mjs
import pkg from '@xterm/headless'
const { Terminal } = pkg
import assert from 'node:assert'

// ---------- the gate (candidate implementation) ----------
function rowOf (term) {
  const b = term.buffer.active
  const line = b.getLine(b.baseY + b.cursorY)
  if (!line) return { text: '', prefix: '', tail: '', cursorX: b.cursorX }
  const text = line.translateToString(false)            // keeps trailing spaces, pads to row width
  return { text, prefix: text.slice(0, b.cursorX), tail: text.slice(b.cursorX), cursorX: b.cursorX }
}

function isClean (term, token) {
  if (!token || token.trimEnd().length === 0) return false   // fail-closed on empty token
  const b = term.buffer.active
  if (b.type === 'alternate') return false
  if (b.viewportY !== b.baseY) return false
  const { prefix, tail } = rowOf(term)
  // cursor must sit right after the prompt token AND nothing may follow the cursor
  return prefix.endsWith(token) && tail.trim() === ''
}

async function make (cols, rows, data) {
  const t = new Terminal({ cols, rows, allowProposedApi: true })
  await new Promise(res => t.write(data, res))
  return t
}

const results = []
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]) } catch (e) { results.push(['FAIL', name + ' :: ' + e.message]) }
}

const P = '\x1b[32muser@srv\x1b[0m:~$ '
const TOK = '$ '

// --- 0. facts about the buffer API (these decide the whole gate design) ---
const t0 = await make(80, 10, P)
check('FACT: translateToString(true) does NOT trim a written space', () => {
  const l = t0.buffer.active.getLine(0)
  assert.strictEqual(l.translateToString(true), 'user@srv:~$ ')   // <- not trimmed
})
check('FACT: translateToString(false) pads to full row width', () => {
  const l = t0.buffer.active.getLine(0)
  assert.strictEqual(l.translateToString(false).length, 80)
  assert.strictEqual(l.translateToString(false).endsWith('$ '), false) // naive endsWith fails
})
check('FACT: cursorX sits after the prompt token', () => {
  assert.strictEqual(t0.buffer.active.cursorX, 'user@srv:~$ '.length)
})

// --- 1. clean states ---
check('prompt only => clean', () => assert.strictEqual(isClean(t0, TOK), true))
const tRoot = await make(80, 10, '[root@srv ~]# ')
check('root prompt => clean on "# "', () => assert.strictEqual(isClean(tRoot, '# '), true))
const tPwsh = await make(80, 10, 'PS C:\\Users\\hermes> ')
check('pwsh prompt => clean on learned "> ", dirty on "$ "', () => {
  assert.strictEqual(isClean(tPwsh, '> '), true)
  assert.strictEqual(isClean(tPwsh, TOK), false)
})

// --- 2. user typed -> dirty ---
const t1 = await make(80, 10, P + 'rm -rf /tmp/art')
check('typed command => dirty', () => assert.strictEqual(isClean(t1, TOK), false))

// 2b. typed text whose last char IS the token tail -> still dirty (no trimming)
const t2 = await make(80, 10, P + 'echo $')
check('typed "echo $" => dirty (would be clean under a trim/endsWith("$") rule)', () => {
  assert.ok(rowOf(t2).prefix.endsWith('$'))
  assert.strictEqual(isClean(t2, TOK), false)
})

// 2c. cursor moved back to just after the prompt while text still on the line
const t2c = await make(80, 10, P + 'rm -rf /tmp/art\x1b[13G')
check('cursor parked after prompt with text after it => dirty (tail guard)', () => {
  assert.strictEqual(t2c.buffer.active.cursorX, 12)
  assert.strictEqual(rowOf(t2c).prefix.endsWith(TOK), true)   // prefix alone would say clean
  assert.strictEqual(isClean(t2c, TOK), false)                // tail guard saves it
})

// 2d. same line, cursor at end of the typed text
check('cursor at end of typed text => dirty', () => assert.strictEqual(isClean(t1, TOK), false))

// --- 3. shell not at a primary prompt ---
const tPS2 = await make(80, 10, P + 'echo hi \\\r\n> ')
check('bash PS2 "> " continuation => dirty against canon "$ "', () => assert.strictEqual(isClean(tPS2, TOK), false))
check('HOLE: PS2 line is "clean" if the token were "> " (pwsh token)', () => {
  assert.strictEqual(isClean(tPS2, '> '), true)     // <- suffix test alone is not enough
})

const tRead = await make(80, 10, '# read -p "slot # " x\r\nslot # ')
check('HOLE: read -p "slot # " is "clean" to a "# " token', () => {
  assert.strictEqual(isClean(tRead, '# '), true)    // <- same hole, root shells
})

const tHeredoc = await make(80, 10, P + 'cat <<EOF\r\n> ')
check('heredoc body line "> " => dirty against canon "$ "', () => assert.strictEqual(isClean(tHeredoc, TOK), false))

// --- 4. fail-closed cases ---
check('empty / whitespace token => fail-closed', () => {
  for (const bad of ['', ' ', '  ', '\t']) assert.strictEqual(isClean(t0, bad), false)
})
const tAlt = await make(80, 10, P)
await new Promise(r => tAlt.write('\x1b[?1049h', r))
check('alternate screen (vim/less) => dirty', () => assert.strictEqual(isClean(tAlt, TOK), false))
const tScroll = await make(80, 3, Array.from({ length: 20 }, (_, i) => `line ${i}\r\n`).join('') + P)
tScroll.scrollLines(-5)
check('scrolled back => dirty', () => {
  assert.notStrictEqual(tScroll.buffer.active.viewportY, tScroll.buffer.active.baseY)
  assert.strictEqual(isClean(tScroll, TOK), false)
})
const tEmpty = await make(80, 10, '')
check('blank buffer (learning failed) => dirty', () => assert.strictEqual(isClean(tEmpty, TOK), false))

for (const [s, n] of results) console.log(`${s}  ${n}`)
const fails = results.filter(r => r[0] === 'FAIL').length
console.log(`\n${results.length - fails}/${results.length} passed, ${results.filter(r => r[0] === 'PASS' && r[1].startsWith('HOLE')).length} confirmed holes`)
process.exit(fails ? 1 : 0)
