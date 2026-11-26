// contract: v50
// SmartSSH settler — pure, clock-injected. No xterm, no timers.
// Two gates after a feed: (a) output must have come back, (b) a token-terminated line
// must have been rendered. Only then does the quiet window decide.
import { GATE } from './gate.mjs'

export function createSettler ({ quietMs = 150 } = {}) {
  let feedAt = null
  let lastOutputAt = -Infinity
  let sawOutputAfterFeed = false
  let sawPromptAfterFeed = false

  function onFeed (ts) {
    feedAt = ts
    sawOutputAfterFeed = false
    sawPromptAfterFeed = false
  }

  function onOutput (ts, { promptLine = false } = {}) {
    lastOutputAt = ts
    if (feedAt === null) {
      if (promptLine) sawPromptAfterFeed = true
      return
    }
    if (ts >= feedAt) {
      sawOutputAfterFeed = true
      if (promptLine) sawPromptAfterFeed = true
    }
  }

  const onPromptLine = ts => onOutput(ts, { promptLine: true })

  function evaluate (ts, gate) {
    if (gate.gate !== GATE.CLEAN) return gate
    if (feedAt !== null) {
      if (!sawOutputAfterFeed) return { gate: GATE.SETTLING, reason: 'awaiting_echo' }
      if (!sawPromptAfterFeed) return { gate: GATE.SETTLING, reason: 'no_prompt_line' }
    }
    if (ts - lastOutputAt < quietMs) return { gate: GATE.SETTLING, reason: 'output_active' }
    return { gate: GATE.CLEAN, reason: 'clean' }
  }

  const reset = () => { feedAt = null; lastOutputAt = -Infinity; sawOutputAfterFeed = false; sawPromptAfterFeed = false }
  const state = () => ({ feedAt, lastOutputAt, sawOutputAfterFeed, sawPromptAfterFeed })

  return { onFeed, onOutput, onPromptLine, evaluate, reset, state }
}
