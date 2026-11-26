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
 * @returns {{gate: string, reason: string}}
 */
export function isAtPrompt (s) {
  const { line = '', cursorX = 0, token = '', tokenTrusted = false,
    altScreen = false, selection = false, viewportY = 0, baseY = 0 } = s

  if (altScreen) return { gate: GATE.ALT, reason: 'alt_screen' }
  if (selection) return { gate: GATE.DIRTY, reason: 'selection' }
  if (viewportY !== baseY) return { gate: GATE.DIRTY, reason: 'scrolled' }
  if (typeof token !== 'string' || token.trimEnd().length === 0) {
    return { gate: GATE.DIRTY, reason: 'token_empty' }        // fail-closed, never fail-open
  }
  if (!tokenTrusted) return { gate: GATE.DIRTY, reason: 'token_untrusted' }

  const prefix = line.slice(0, cursorX)
  const tail = line.slice(cursorX)

  if (!prefix.endsWith(token)) return { gate: GATE.DIRTY, reason: 'prompt_dirty' }

  // continuation: PS2 "> ", heredoc body "> ", zsh ">> ", any prompt whose char
  // before the token repeats the token's own first char ("$ $ " etc.)
  const before = prefix.slice(0, prefix.length - token.length)
  if (before.length > 0 && before[before.length - 1] === token[0]) {
    return { gate: GATE.CONT, reason: 'continuation' }
  }

  // text after the cursor: user moved the caret back / shell hint we cannot classify
  if (tail.trimEnd() !== '') return { gate: GATE.DIRTY, reason: 'text_after_cursor' }

  return { gate: GATE.CLEAN, reason: 'clean' }
}
