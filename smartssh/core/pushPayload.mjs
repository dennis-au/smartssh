// contract: v40
import { redact } from './redact.mjs'

export const TRIGGERS = Object.freeze(['manual', 'l', 'ask', 'hermes_request'])
export const MAX_LINES = 200

export function buildContextPush (input) {
  const trigger = input?.trigger
  if (!TRIGGERS.includes(trigger)) {
    throw new Error('context.push requires trigger manual|l|ask|hermes_request')
  }

  const { tab_id, host, range } = input
  if (typeof tab_id !== 'string' || tab_id.length === 0) throw new Error('tab_id must be a non-empty string')
  if (typeof host !== 'string' || host.length === 0) throw new Error('host must be a non-empty string')

  const lines = input.lines.slice(-MAX_LINES)
  const truncated_lines = input.lines.length - lines.length
  if (!range || range.toLine - range.fromLine + 1 !== lines.length) {
    throw new Error('range does not match the number of lines sent')
  }

  const { text, masks } = redact(input.text, { enabled: input.enabledRules })
  for (const m of masks) {
    if (text.slice(m.start, m.end) !== '***') throw new Error('context.push mask does not point at ***')
  }

  return { trigger, tab_id, host, range, lines, truncated_lines, redacted_segments: masks.length, text, masks }
}
