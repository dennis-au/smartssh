// contract: v45
import { redact } from './redact.mjs'

export const TRIGGERS = Object.freeze(['manual', 'l', 'ask', 'hermes_request'])
export const MAX_LINES = 200

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

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
  if (!Number.isInteger(range?.fromLine) || range.fromLine < 1) {
    throw new Error('range.fromLine is 1-based')
  }
  if (!Number.isInteger(range.toLine) || range.toLine < range.fromLine) {
    throw new Error('range.toLine must be an integer >= range.fromLine')
  }
  if (range.at == null) throw new Error('range.at is required')
  if (!Number.isInteger(range.at) && !(typeof range.at === 'string' &&
    ISO_TIMESTAMP.test(range.at) && Number.isFinite(Date.parse(range.at)))) {
    throw new Error('range.at must be an integer epoch-ms or an ISO-8601 string')
  }
  if (range.toLine - range.fromLine + 1 !== lines.length) {
    throw new Error('range does not match the number of lines sent')
  }

  const windowText = lines.join('\n')
  const { text, masks: redactions } = redact(windowText, { enabled: input.enabledRules })
  const sourceWindow = { windowText, lines, range }
  const masks = redactions.map(({ rule, start, end, srcSpan }) => {
    if (text.slice(start, end) !== '***') throw new Error('context.push mask does not point at ***')
    const bufferLine = maskBufferLine(sourceWindow, { srcSpan })
    // “Do not store derived numbers” applies only to values derivable from what
    // is already returned. Compute values that need the raw source at build
    // time: dropping the raw text wins over purity.
    const srcLines = windowText.slice(srcSpan.start, srcSpan.end).split('\n').length
    return { rule, start, end, srcSpan, bufferLine, srcLines }
  })
  masks.sort((a, b) => a.start - b.start)

  return { trigger, tab_id, host, range, lines, truncated_lines, redacted_segments: masks.length, text, masks }
}

export function maskBufferLine (push, mask) {
  const span = mask?.srcSpan
  if (!span) throw new Error('mask has no srcSpan')
  if (!push?.windowText) {
    // Returned pushes carry the coordinate, not the source text used to compute it.
    if (Number.isInteger(mask.bufferLine)) return mask.bufferLine
    throw new Error('push has no windowText')
  }
  const lineInWindow = push.windowText.slice(0, span.start).split('\n').length
  if (lineInWindow < 1 || lineInWindow > push.lines.length) throw new Error('mask starts outside the sent window')
  return push.range.fromLine + lineInWindow - 1
}
