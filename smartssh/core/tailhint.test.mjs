import assert from 'node:assert'
import { tailIsHintFromCells, tailIsHintFromSnapshot } from './tailhint.mjs'
const r = []; const t = (n, f) => { try { f(); r.push(['PASS', n]) } catch (e) { r.push(['FAIL', n + ' :: ' + e.message]) } }
const dim = () => ({ isDim: () => true, isItalic: () => false })
const ita = () => ({ isDim: () => false, isItalic: () => true })
const plain = () => ({ isDim: () => false, isItalic: () => false })

t('1. all dim => true', () => assert.strictEqual(tailIsHintFromCells([dim(), dim(), dim()]), true))
t('2. all italic => true', () => assert.strictEqual(tailIsHintFromCells([ita(), ita()]), true))
t('3. dim+italic mixed => true', () => assert.strictEqual(tailIsHintFromCells([dim(), ita()]), true))
t('4. any normal fg => false (some() would pass this)', () => assert.strictEqual(tailIsHintFromCells([dim(), plain(), dim()]), false))
t('5. a single normal cell => false', () => assert.strictEqual(tailIsHintFromCells([plain()]), false))
t('6. empty tail => false (no tail is not a hint)', () => {
  assert.strictEqual(tailIsHintFromCells([]), false)
  assert.strictEqual(tailIsHintFromCells(null), false)
})
t('7. null/undefined entries => false, never throws', () => {
  assert.strictEqual(tailIsHintFromCells([null]), false)
  assert.strictEqual(tailIsHintFromCells([undefined]), false)
  assert.strictEqual(tailIsHintFromCells(undefined), false)
})
t('8. plain-object cells ({dim}/{italic}) are accepted too', () => {
  assert.strictEqual(tailIsHintFromCells([{ dim: true }, { italic: true }]), true)
  assert.strictEqual(tailIsHintFromCells([{ dim: true }, { dim: false }]), false)
})
t('9. snapshot reads cursorX and cells in ONE pass; empty tail => false', () => {
  const getCell = (col) => (col >= 5 ? dim() : plain())
  assert.strictEqual(tailIsHintFromSnapshot({ cursorX: 5, cols: 8, getCell }), true)
  assert.strictEqual(tailIsHintFromSnapshot({ cursorX: 8, cols: 8, getCell }), false)
})
t('10. snapshot with no getCell => false (never throw)', () => {
  assert.strictEqual(tailIsHintFromSnapshot(null), false)
  assert.strictEqual(tailIsHintFromSnapshot({ cursorX: 0, cols: 4 }), false)
})

// ---- v21: real-row padding (product-tester's 4 snapshot cases) ----
const cell = (chars, dim = false, italic = false) => ({ getChars: () => chars, isDim: () => dim, isItalic: () => italic })
const PAD = () => cell('', false, false)

t('11. snapshot: hint followed by row padding => TRUE (padding is not user text)', () => {
  const getCell = (col) => (col >= 5 && col <= 10 ? cell('x', true) : PAD())
  assert.strictEqual(tailIsHintFromSnapshot({ cursorX: 5, cols: 80, getCell }), true)
})
t('12. snapshot: hint with an internal space => TRUE', () => {
  const text = 'git commit -m "a b"'
  const getCell = (col) => cell(text[col - 5] ?? '', true)
  assert.strictEqual(tailIsHintFromSnapshot({ cursorX: 5, cols: 80, getCell }), true)
})
t('13. snapshot: user text after the hint => FALSE', () => {
  const getCell = (col) => (col >= 5 && col <= 10 ? cell('x', true) : col === 11 ? cell('r') : PAD())
  assert.strictEqual(tailIsHintFromSnapshot({ cursorX: 5, cols: 80, getCell }), false)
})
t('14. a caller-supplied endCol cannot change the answer (CJK fail-open guard)', () => {
  const getCell = (col) => (col >= 5 && col <= 10 ? cell('x', true) : col === 11 ? cell('X') : PAD())
  const truth = tailIsHintFromSnapshot({ cursorX: 5, cols: 80, getCell })
  assert.strictEqual(truth, false)
  for (const bogus of [5, 11, 26, 36]) {
    assert.strictEqual(tailIsHintFromSnapshot({ cursorX: 5, cols: 80, endCol: bogus, getCell }), truth, 'endCol=' + bogus)
  }
})
t('15. cells: all padding => FALSE (no hint at all)', () => {
  assert.strictEqual(tailIsHintFromCells([PAD(), PAD()]), false)
})

for (const [s, n] of r) console.log(`${s}  ${n}`)
const f = r.filter(x => x[0] === 'FAIL').length
console.log(`\n${r.length - f}/${r.length} passed`)
process.exit(f ? 1 : 0)
