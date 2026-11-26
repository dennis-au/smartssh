// tailhint.mjs — decide whether the cells AFTER the cursor are shell-drawn hints.
// Contract (designer v18/v19 §tailIsHint):
//   1. only an adapter may produce `true` (all cells styled dim/italic/suggestion colour)
//   2. the pure gate never validates the caller; the guard lives here, the only producer
//   3. tests must not hand-build `true` outside this adapter's own contract tests
//
// A cell is any object exposing `isDim()`/`isItalic()`/`getChars()`, or the plain form
// `{ dim, italic, chars }`. Empty / null tail => false (a missing tail is not a hint).
//
// v21 fix: an xterm row is padded to `cols` with blank cells whose isDim() is false, so a
// naive "every cell after the cursor" check is always false in a real terminal. Trailing blank
// cells are excluded — never by stopping at the first space (a hint may contain spaces), only
// by trimming the *trailing* run of blank, un-styled cells.

function cellFlags (cell) {
  if (!cell) return { dim: false, italic: false }
  const dim = typeof cell.isDim === 'function' ? !!cell.isDim() : !!cell.dim
  const italic = typeof cell.isItalic === 'function' ? !!cell.isItalic() : !!cell.italic
  return { dim, italic }
}

function cellChars (cell) {
  if (!cell) return ''
  if (typeof cell.getChars === 'function') return cell.getChars()
  if (typeof cell.chars === 'string') return cell.chars
  return null                                // unknown: treat as content (fail-closed)
}

function isBlankPadding (cell) {
  const { dim, italic } = cellFlags(cell)
  if (dim || italic) return false            // a styled blank belongs to the hint
  const chars = cellChars(cell)
  if (chars === null) return false            // no char info => assume written text
  return chars.trim() === ''                  // xterm padding cell / trailing space
}

/**
 * @param {Array|null|undefined} cells cells strictly AFTER cursorX
 * @returns {boolean} true only when every remaining cell is dim or italic
 */
export function tailIsHintFromCells (cells) {
  if (!Array.isArray(cells) || cells.length === 0) return false
  let end = cells.length
  while (end > 0 && isBlankPadding(cells[end - 1])) end--
  if (end === 0) return false                // nothing but padding => no hint
  return cells.slice(0, end).every(c => {
    const { dim, italic } = cellFlags(c)
    return dim || italic
  })
}

/**
 * Same-render snapshot: reads cursorX, endCol and the tail cells in ONE pass, so a cursor
 * move between frames cannot pair a new cursor with stale cell styles (designer v19).
 * Production supplies `endCol` (e.g. `line.getTrimmedLength()`); without it we fall back to
 * trimming trailing padding by cell content, which is correct but costlier.
 * @param {object} snap
 * @param {number} snap.cursorX
 * @param {number} snap.cols
 * @param {number} [snap.endCol]
 * @param {(col:number)=>object} snap.getCell
 */
export function tailIsHintFromSnapshot (snap) {
  if (!snap || typeof snap.getCell !== 'function') return false
  const cursorX = Number.isFinite(snap.cursorX) ? snap.cursorX : 0
  const cols = Number.isFinite(snap.cols) ? snap.cols : 0
  const last = Number.isFinite(snap.endCol) ? Math.min(snap.endCol, cols) : cols
  if (last <= cursorX) return false          // nothing after the cursor

  const cells = []
  for (let col = cursorX; col < last; col++) cells.push(snap.getCell(col))
  return tailIsHintFromCells(cells)
}
