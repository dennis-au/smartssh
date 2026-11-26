// tailhint.mjs — decide whether the cells AFTER the cursor are shell-drawn hints.
// Contract (designer v18 §tailIsHint):
//   1. only an adapter may produce `true` (all cells styled dim/italic/suggestion colour)
//   2. the pure gate never validates the caller; the guard lives here, the only producer
//   3. tests must not hand-build `true` outside this adapter's own contract tests
//
// A cell is any object exposing `isDim()`/`isItalic()`, or the plain form `{ dim, italic }`.
// Empty / null tail => false (a missing tail is not a hint).

function cellFlags (cell) {
  if (!cell) return { dim: false, italic: false }
  const dim = typeof cell.isDim === 'function' ? !!cell.isDim() : !!cell.dim
  const italic = typeof cell.isItalic === 'function' ? !!cell.isItalic() : !!cell.italic
  return { dim, italic }
}

/**
 * @param {Array|null|undefined} cells cells strictly AFTER cursorX
 * @returns {boolean} true only when every cell is dim or italic
 */
export function tailIsHintFromCells (cells) {
  if (!Array.isArray(cells) || cells.length === 0) return false
  return cells.every(c => {
    const { dim, italic } = cellFlags(c)
    return dim || italic
  })
}

/**
 * Same-render snapshot: reads cursorX and the tail cells in one pass so a cursor move
 * between frames cannot pair a new cursor with stale cell styles (designer v19).
 * @param {object} snap
 * @param {number} snap.cursorX
 * @param {number} snap.cols
 * @param {(col:number)=>object} snap.getCell
 */
export function tailIsHintFromSnapshot (snap) {
  if (!snap || typeof snap.getCell !== 'function') return false
  const cursorX = Number.isFinite(snap.cursorX) ? snap.cursorX : 0
  const cols = Number.isFinite(snap.cols) ? snap.cols : 0
  if (cols <= cursorX) return false          // nothing after the cursor
  const cells = []
  for (let col = cursorX; col < cols; col++) cells.push(snap.getCell(col))
  return tailIsHintFromCells(cells)
}
