import assert from 'node:assert'
import { isAtPrompt } from './gate.mjs'
const pad = s => s + ' '.repeat(Math.max(0, 90 - s.length))
const base = { token: '$ ', tokenTrusted: true, altScreen: false, selection: false, viewportY: 0, baseY: 0 }
const P = 'hermes@srv:~$ '
const r = []; const t = (n, f) => { try { f(); r.push(['PASS', n]) } catch (e) { r.push(['FAIL', n + ' :: ' + e.message]) } }
const g = (o) => isAtPrompt({ ...base, ...o })

t('A. empty prompt + shell hint after cursor, tailIsHint => clean', () =>
  assert.strictEqual(g({ line: pad(P + 'git status --short'), cursorX: P.length, tailIsHint: true }).gate, 'clean'))
t('B. same input WITHOUT the hint proof => prompt_dirty (fail-closed)', () =>
  assert.strictEqual(g({ line: pad(P + 'git status --short'), cursorX: P.length }).gate, 'prompt_dirty'))
t('C. caret moved back, caller reports the tail honestly (tailIsHint=false) => prompt_dirty', () =>
  assert.strictEqual(g({ line: pad(P + 'rm -rf /tmp/art'), cursorX: P.length, tailIsHint: false }).gate, 'prompt_dirty'))
t('D. plain prompt, empty tail => clean', () => assert.strictEqual(g({ line: pad(P), cursorX: P.length }).gate, 'clean'))
t('E. typed text ending at cursor => prompt_dirty', () =>
  assert.strictEqual(g({ line: pad(P + 'ls'), cursorX: P.length + 2 }).gate, 'prompt_dirty'))
for (const [s, n] of r) console.log(`${s}  ${n}`)
const f = r.filter(x => x[0] === 'FAIL').length
console.log(`\n${r.length - f}/${r.length} passed`)
process.exit(f ? 1 : 0)
