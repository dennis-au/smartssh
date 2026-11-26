// contract: v52
// SmartSSH gate — pure functions, zero xterm dependency (headless-runnable).
// gate values are the frozen five: clean | prompt_dirty | settling | alt_screen | continuation
// reason is free-form (data-gate-reason) so remediation text can differ per cause.

export const GATE = {
  CLEAN: 'clean',
  DIRTY: 'prompt_dirty',
  SETTLING: 'settling',
  ALT: 'alt_screen',
  CONT: 'continuation',
}

/**
 * @param {object} s
 * @param {string} s.line        row text with trailing spaces PRESERVED (translateToString(false))
 * @param {number} s.cursorX
 * @param {string} s.token       learned prompt suffix, e.g. "$ " (may include trailing space)
 * @param {boolean} s.tokenTrusted  token has >= 2 agreeing samples taken right after Enter
 * @param {boolean} s.altScreen
 * @param {boolean} s.selection
 * @param {number} s.viewportY
 * @param {number} s.baseY
 * @param {boolean} s.tailIsHint  true only when the caller proved the cells AFTER the cursor are
 *                                shell-drawn hints (dim/italic/known suggestion colour). Never guessed.
 * @returns {{gate: string, reason: string}}
 */
export function isAtPrompt (s) {
  const { line = '', cursorX = 0, token = '', tokenTrusted = false,
    altScreen = false, selection = false, viewportY = 0, baseY = 0, tailIsHint = false,
    // Column-accurate form (CJK-safe): `cursorX` counts CELLS, while a JS string index counts
    // UTF-16 units, so `line.slice(0, cursorX)` silently drifts when wide characters precede the
    // cursor. When the caller can read cells it passes prefix/tail directly and `line` is unused.
    prefix: givenPrefix, tail: givenTail } = s
  const hasCells = typeof givenPrefix === 'string'

  if (altScreen) return { gate: GATE.ALT, reason: 'alt_screen' }
  if (selection) return { gate: GATE.DIRTY, reason: 'selection' }
  if (viewportY !== baseY) return { gate: GATE.DIRTY, reason: 'scrolled' }
  if (typeof token !== 'string' || token.trimEnd().length === 0) {
    return { gate: GATE.DIRTY, reason: 'token_empty' }        // fail-closed, never fail-open
  }
  if (!tokenTrusted) return { gate: GATE.DIRTY, reason: 'token_untrusted' }

  const prefix = hasCells ? givenPrefix : line.slice(0, cursorX)
  const tail = hasCells ? (typeof givenTail === 'string' ? givenTail : '') : line.slice(cursorX)

  if (!prefix.endsWith(token)) return { gate: GATE.DIRTY, reason: 'prompt_dirty' }

  // continuation: PS2 "> ", heredoc body "> ", zsh ">> ", any prompt whose char
  // before the token repeats the token's own first char ("$ $ " etc.)
  const before = prefix.slice(0, prefix.length - token.length)
  if (before.length > 0 && before[before.length - 1] === token[0]) {
    return { gate: GATE.CONT, reason: 'continuation' }
  }

  // Text after the cursor is ambiguous: it is either the user's own text (caret moved back —
  // must block) or a shell-drawn hint such as zsh-autosuggestions (must not block).
  // The caller decides by inspecting the CELLS (dim/italic/suggestion colour); default is
  // fail-closed, so a guess can only ever cost an auto-run, never cause one.
  if (tail.trimEnd() !== '' && !tailIsHint) return { gate: GATE.DIRTY, reason: 'typed_input' }

  return { gate: GATE.CLEAN, reason: 'clean' }
}
