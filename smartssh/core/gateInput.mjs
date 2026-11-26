// gateInput.mjs — the ONE place that reads a live xterm buffer into gate input.
// Column-accurate: text is rebuilt from cells (getChars), never sliced by string index,
// because a JS string index is a UTF-16 unit while cursorX counts terminal columns (CJK = 2).
import { isAtPrompt } from './gate.mjs'
import { tailIsHintFromSnapshot } from './tailhint.mjs'

export function gateInput (term, opts = {}) {
  const b = term.buffer.active
  const line = b.getLine(b.baseY + b.cursorY)
  const cols = term.cols
  const cursorX = b.cursorX
  const getCell = col => (line ? line.getCell(col) : null)

  let prefix = ''
  let tail = ''
  for (let col = 0; col < cols; col++) {
    const cell = getCell(col)
    const ch = cell && typeof cell.getChars === 'function' ? cell.getChars() : ''
    if (col < cursorX) prefix += ch
    else tail += ch
  }

  return isAtPrompt({
    prefix,
    tail,
    cursorX,
    token: opts.token,
    tokenTrusted: !!opts.tokenTrusted,
    altScreen: b.type === 'alternate',
    selection: !!opts.selection,
    viewportY: b.viewportY,
    baseY: b.baseY,
    tailIsHint: tailIsHintFromSnapshot({ cursorX, cols, getCell }),
  })
}
