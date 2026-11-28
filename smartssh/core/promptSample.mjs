// contract: v56
export const PROMPT_TERMINATORS = Object.freeze(['>', '$', '#', '%', '❯', 'λ', '»', '→'])
export const MAX_TOKEN_CHARS = 8

/**
 * The only thing the app is allowed to learn from a live cursor: the prompt terminator plus the
 * whitespace that follows it. Never the whole prompt line (that would carry host name and cwd).
 * @param {{prefix?: string, tail?: string, altScreen?: boolean, selection?: boolean, scrolled?: boolean}} reading
 * @returns {{token: string|null, reason: string}}
 */
export function promptSample (reading = {}) {
  if (reading.altScreen === true) return { token: null, reason: 'alt_screen' }
  if (reading.selection === true) return { token: null, reason: 'selection' }
  if (reading.scrolled === true) return { token: null, reason: 'scrolled' }
  const { prefix, tail } = reading
  if (typeof prefix !== 'string' || prefix.length === 0) return { token: null, reason: 'empty_prefix' }
  if (typeof tail === 'string' && tail.trimEnd() !== '') return { token: null, reason: 'typed_input' }

  let index = prefix.length - 1
  while (index >= 0 && /\s/u.test(prefix[index])) index--
  if (index < 0 || !PROMPT_TERMINATORS.includes(prefix[index])) return { token: null, reason: 'no_terminator' }

  const token = prefix.slice(index)
  if (token.length > MAX_TOKEN_CHARS) return { token: null, reason: 'token_too_long' }
  return { token, reason: 'ok' }
}
