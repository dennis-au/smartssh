// contract: v56
import { RELAY_ERROR_CODES, RelayError } from './relayClient.mjs'

export function applyPromptEcho (target, prompt) {
  let token = ''
  let tokenTrusted = false
  try {
    if (prompt !== null && typeof prompt === 'object' && !Array.isArray(prompt)) {
      const candidate = prompt.token
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        tokenTrusted = prompt.trusted === true
        token = candidate
      }
    }
  } catch { /* unreadable echoes are treated as missing */ }
  try {
    if (typeof target === 'function') target(token, tokenTrusted)
    else target.setToken({ token, tokenTrusted })
    return tokenTrusted
  } catch {
    return false
  }
}

const read = value => typeof value === 'function' ? value() : value

function sampleCount (prompt) {
  const count = prompt?.samples
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

function validWindow (win) {
  const { lines, fromLine, toLine } = win ?? {}
  if (!Array.isArray(lines) || !lines.length || !Number.isSafeInteger(fromLine) || fromLine < 1 ||
      !Number.isSafeInteger(toLine) || toLine - fromLine + 1 !== lines.length) return false
  for (const line of lines) {
    if (typeof line !== 'string') return false
  }
  return true
}

export function createRelayWork ({
  client, service, apply, tabId, sessionId, host, capture, sample, onProposal, pollMs = 1000, clock = Date.now, onEvent,
} = {}) {
  if (typeof client?.inbox !== 'function' || typeof client?.pushContext !== 'function' || !service) {
    throw new Error('createRelayWork requires an inbox/pushContext client and a proposal service')
  }

  const promptTarget = typeof apply === 'function' ? apply : service
  let pollsSinceRegister = 0
  let inFlight = false
  let started = false
  let stopped = false
  let timer
  let lastTrusted
  let lastSamples

  function emit (event) {
    try { onEvent?.(event) } catch { /* observers must not break the work loop */ }
  }

  function routeFailure (where, error) {
    const code = error instanceof RelayError && RELAY_ERROR_CODES.includes(error.code)
      ? error.code : 'internal_error'
    emit({ type: 'error', where, code })
    try {
      if (code === 'relay_token_invalid') service.noteOffline('token')
      else if (code === 'network' || code === 'timeout') service.noteOffline('network')
    } catch { /* the service may refuse the state change */ }
  }

  async function register () {
    if (stopped) return
    try {
      if (typeof client.registerTab !== 'function') return
      await client.registerTab({ tabId: read(tabId), sessionId: read(sessionId), host: read(host) })
    } catch (error) {
      if (!stopped) routeFailure('register', error)
    }
  }

  async function poll () {
    if (inFlight || stopped) return { skipped: true }
    inFlight = true
    try {
      const tab = read(tabId)
      const box = await client.inbox(tab)
      if (stopped) return

      const trusted = applyPromptEcho(promptTarget, box?.prompt)
      const samples = sampleCount(box?.prompt)
      if (trusted !== lastTrusted || samples !== lastSamples) {
        lastTrusted = trusted
        lastSamples = samples
        emit({ type: 'prompt', trusted, samples })
      }

      for (const item of Array.isArray(box?.items) ? box.items : []) {
        if (stopped) return
        let where = 'inbox'
        try {
          const kind = item?.kind
          if (kind === 'context_request') {
            where = 'push'
            const win = capture()
            if (win === null || !validWindow(win)) {
              emit({ type: 'skipped', reason: win === null ? 'no_window' : 'bad_window' })
              continue
            }
            const s = typeof sample === 'function' ? sample() : null
            const input = {
              session_id: read(sessionId), trigger: 'hermes_request', tab_id: tab, host: read(host),
              lines: win.lines, range: { fromLine: win.fromLine, toLine: win.toLine, at: clock() },
              ...(typeof s === 'string' && s.length ? { prompt_sample: s } : {}),
            }
            if (stopped) return
            const res = await client.pushContext(input)
            if (stopped) return
            const trusted = applyPromptEcho(promptTarget, res?.prompt ?? null)
            emit({ type: 'push', requestId: item.request_id, lines: win.lines.length, trusted,
              samples: sampleCount(res?.prompt) })
          } else if (kind === 'proposal') {
            where = 'proposal'
            if (typeof onProposal === 'function') await onProposal(item)
            else await service.propose({ command: item.command, risk: item.risk, why: item.why ?? '' })
            if (!stopped) emit({ type: 'proposal', proposalId: item.proposal_id, risk: item.risk })
          } else {
            emit({ type: 'ignored', kind })
          }
        } catch (error) {
          if (!stopped) routeFailure(where, error)
        }
      }
    } catch (error) {
      if (!stopped) routeFailure('inbox', error)
    } finally {
      inFlight = false
      if (started && !stopped && ++pollsSinceRegister === 60) {
        pollsSinceRegister = 0
        void register()
      }
    }
  }

  function start () {
    if (started || stopped) return
    started = true
    emit({ type: 'started' })
    void register()
    void poll()
    if (stopped) return
    timer = setInterval(poll, pollMs)
    timer.unref?.()
  }

  function stop () {
    stopped = true
    clearInterval(timer)
  }

  return { poll, start, stop, armed: () => service.armed(), client }
}
