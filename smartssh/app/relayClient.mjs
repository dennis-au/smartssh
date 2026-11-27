// contract: v53
// relayClient.mjs — the app-side HTTP client for relay v2 (smartssh/relay/server.mjs).
//
// Until this file existed the exe had no connection to the relay at all: every relay route was
// reachable only from tests. This client is the missing wire. Design rules, deliberately narrow:
//
//  * The token lives in this closure and in the `Authorization` header. It is never placed in a
//    URL, a log line, an error message, or any returned object — `describe()` reports only whether
//    a token is present, never its value.
//  * Pushed context is built by `buildContextPush()` from smartssh/core (which already runs
//    `redact()`), and the built text is redacted a second time here as a fail-closed check. A raw
//    secret cannot leave this process even if a future core change loosens the first pass.
//  * Failures are typed (`RelayError.code`) so the caller can map them onto bar states without
//    re-parsing messages: `relay_token_invalid` -> offline(token), `network`/`timeout` ->
//    offline(network), `expired` -> expired, `stale_approval`/`confirm_mismatch` -> aborted.
//  * No new dependency: `globalThis.fetch` (injectable) plus an AbortController per request, so a
//    dead relay rejects instead of hanging the UI.
import { buildContextPush } from '../core/pushPayload.mjs'
import { redact } from '../core/redact.mjs'

export const DEFAULT_TIMEOUT_MS = 5000

/** Every code a caller may need to branch on. Anything else is a relay `internal_error`. */
export const RELAY_ERROR_CODES = Object.freeze([
  'relay_token_invalid', 'network', 'timeout', 'expired', 'proposal_done',
  'stale_approval', 'confirm_mismatch', 'bad_request', 'not_found',
  'truncation_refused', 'unavailable', 'internal_error', 'redaction_incomplete',
  'context_line_mismatch',
])

export class RelayError extends Error {
  constructor (code, { status = 0, relayCode = '', fields = {} } = {}) {
    super(`relay request failed: ${code}`)
    this.name = 'RelayError'
    this.code = code
    this.status = status
    this.relayCode = relayCode
    this.transient = code === 'network' || code === 'timeout'
    Object.assign(this, fields)
  }
}

const TOKEN_INVALID = 'relay_token_invalid'

function relayErrorFromResponse (status, body) {
  const relayCode = typeof body?.error === 'string' ? body.error : ''
  const fields = {}
  for (const key of ['attempts_left', 'dropped_lines', 'retry_after']) {
    if (body?.[key] !== undefined) fields[key] = body[key]
  }
  if (status === 401 || relayCode === 'token_invalid') {
    return new RelayError(TOKEN_INVALID, { status, relayCode: 'token_invalid' })
  }
  const byRelayCode = {
    proposal_dead: 'expired',
    proposal_done: 'proposal_done',
    stale_approval: 'stale_approval',
    confirm_mismatch: 'confirm_mismatch',
    missing_idempotency_key: 'bad_request',
    bad_request: 'bad_request',
    not_found: 'not_found',
    truncation_refused: 'truncation_refused',
    internal_error: 'internal_error',
  }
  if (byRelayCode[relayCode]) return new RelayError(byRelayCode[relayCode], { status, relayCode, fields })
  const byStatus = {
    400: 'bad_request',
    404: 'not_found',
    413: 'truncation_refused',
    503: 'unavailable',
  }
  return new RelayError(byStatus[status] ?? 'internal_error', { status, relayCode, fields })
}

const nonempty = value => typeof value === 'string' && value.trim().length > 0

function safeDecode (text) {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * @param {object} options
 * @param {string} options.baseUrl  e.g. http://127.0.0.1:8787 (no trailing slash required)
 * @param {string} options.token    relay bearer token; never logged, never returned
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {number} [options.timeoutMs]  per-request timeout; 0 disables it
 * @param {(text: string) => void} [options.logger]  optional, receives no tokens (unused by default)
 */
export function createRelayClient ({ baseUrl, token, fetchImpl, now, timeoutMs } = {}) {
  if (!nonempty(baseUrl)) throw new RelayError('bad_request', { relayCode: 'base_url_missing' })
  const origin = String(baseUrl).replace(/\/+$/, '')
  const bearer = typeof token === 'string' ? token : ''
  const hasToken = nonempty(bearer)
  const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis)
  const clock = typeof now === 'function' ? now : () => Date.now()
  const timeout = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Math.max(0, Number(timeoutMs) || 0)

  function authHeader () {
    // A token with CR/LF would split the header; refuse instead of sending something else.
    if (/[\r\n]/.test(bearer)) throw new RelayError(TOKEN_INVALID, { relayCode: 'token_malformed' })
    return hasToken ? { Authorization: 'Bearer ' + bearer } : null
  }

  async function send (method, path, { body, headers = {} } = {}) {
    if (!hasToken) throw new RelayError(TOKEN_INVALID, { relayCode: 'token_missing' })
    if (typeof doFetch !== 'function') throw new RelayError('network', { relayCode: 'fetch_missing' })
    const auth = authHeader()
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer = null
    if (controller && timeout > 0) {
      timer = setTimeout(() => controller.abort(), timeout)
      if (typeof timer.unref === 'function') timer.unref()
    }
    let response
    let text
    try {
      response = await doFetch(origin + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...auth,
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      })
      text = await response.text()
    } catch (cause) {
      const aborted = cause?.name === 'AbortError' || controller?.signal?.aborted === true
      // Deliberately no cause object and no URL: either could carry caller-supplied secrets.
      throw new RelayError(aborted ? 'timeout' : 'network', { relayCode: cause?.name ?? 'fetch_failed' })
    } finally {
      if (timer) clearTimeout(timer)
    }
    const parsed = safeDecode(text)
    if (!response.ok || response.status === 401) throw relayErrorFromResponse(response.status, parsed)
    return { body: parsed, headers: response.headers }
  }

  /**
   * Push the terminal window. `input` is the buildContextPush() input plus `session_id`:
   * `{ session_id, trigger, tab_id, host, lines, range: {fromLine, toLine, at?}, enabledRules? }`.
   */
  async function pushContext (input = {}) {
    if (!nonempty(input.session_id)) {
      throw new RelayError('bad_request', { relayCode: 'session_id_missing' })
    }
    const range = { at: clock(), ...(input.range ?? {}) }
    // buildContextPush() is the producer contract: trigger/range/truncation + redact().
    let payload
    try {
      payload = buildContextPush({ ...input, range })
    } catch (error) {
      // Core error messages can quote terminal text; replace them before they can reach a log.
      throw new RelayError('bad_request', {
        relayCode: typeof error?.code === 'string' ? error.code : 'context_invalid',
      })
    }
    // Fail-closed second pass: if anything secret-like survived the first redaction, refuse to send.
    let residual
    try {
      residual = redact(payload.text)
    } catch {
      throw new RelayError('redaction_incomplete', { relayCode: 'redaction_check_failed' })
    }
    if (residual.masks.length > 0) {
      throw new RelayError('redaction_incomplete', { relayCode: 'redaction_incomplete' })
    }
    // The relay rejects a push whose line_count disagrees with the text it receives. Multiline
    // redaction (private keys) can change the newline count, so refuse here instead of 400-blind.
    if (payload.line_count !== payload.text.split('\n').length) {
      throw new RelayError('context_line_mismatch', { relayCode: 'context_line_mismatch' })
    }
    const { body } = await send('POST', '/v1/context.push', {
      body: { ...payload, session_id: input.session_id },
    })
    return body
  }

  async function getProposal (proposalId) {
    if (!nonempty(proposalId)) throw new RelayError('bad_request', { relayCode: 'proposal_id_missing' })
    const { body } = await send('GET', `/v1/proposal/${encodeURIComponent(proposalId)}`)
    return body
  }

  async function rejectProposal (proposalId, { reason, ts } = {}) {
    if (!nonempty(proposalId)) throw new RelayError('bad_request', { relayCode: 'proposal_id_missing' })
    if (!nonempty(reason)) throw new RelayError('bad_request', { relayCode: 'reason_missing' })
    const body = { reason }
    if (ts !== undefined) body.ts = ts
    const { body: responseBody } = await send('POST', `/v1/proposal/${encodeURIComponent(proposalId)}/reject`, { body })
    return responseBody
  }

  /**
   * Dispatch an approved proposal. `Idempotency-Key` is always the command id, so a retry of the
   * same approval can never execute twice; a replay returns `{ replay: true, execution: null }`
   * instead of the execution that the first call created.
   */
  async function dispatch ({ commandId, proposalId, tabId, sessionId, confirm } = {}) {
    if (!nonempty(commandId)) throw new RelayError('bad_request', { relayCode: 'command_id_missing' })
    if (!nonempty(proposalId) || !nonempty(tabId) || !nonempty(sessionId)) {
      throw new RelayError('bad_request', { relayCode: 'dispatch_fields_missing' })
    }
    const body = { proposal_id: proposalId, command_id: commandId, tab_id: tabId, session_id: sessionId }
    if (confirm !== undefined) body.confirm = confirm
    const response = await send('POST', '/v1/command.dispatch', {
      body,
      headers: { 'Idempotency-Key': commandId },
    })
    const replay = response.headers?.get?.('Idempotent-Replay') === 'true'
    return replay ? { replay: true, execution: null } : { replay: false, execution: response.body }
  }

  return {
    pushContext,
    getProposal,
    rejectProposal,
    dispatch,
    /** Safe identity for diagnostics: no token, no headers. */
    describe: () => ({ baseUrl: origin, hasToken, timeoutMs: timeout }),
  }
}

/**
 * Build a client from resolved config; returns null when the relay is not configured, so the app
 * can show `offline` instead of throwing on startup.
 * @param {{baseUrl: string, token?: string, configured: boolean}} config
 */
export function createRelayClientFromConfig (config = {}, options = {}) {
  if (!config?.configured || !nonempty(config.baseUrl) || !nonempty(config.token)) return null
  return createRelayClient({ baseUrl: config.baseUrl, token: config.token, ...options })
}
