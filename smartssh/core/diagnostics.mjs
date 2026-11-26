// "Copy diagnostics" — designer v16 SPEC OF RECORD. Ten codes, or null. No third state.
export const TRUST = Object.freeze(['off', 'watch', 'propose', 'readonly_auto'])
export const GATE = Object.freeze(['clean', 'prompt_dirty', 'settling', 'alt_screen', 'continuation'])
export const ERROR_CODES = Object.freeze([
  'token_invalid', 'stale_approval', 'proposal_dead', 'truncation_refused', 'rate_limited',
  'server_error', 'dispatch_failed', 'dispatch_timeout', 'session_replaced', 'transport_unknown',
])
export const DIAG_KEYS = ['version', 'sha256', 'trust', 'gate', 'errors']
export const MAX_BYTES = 2048
export const TRANSPORT_TIMEOUT_EVENT = 'transport_timeout'
const VERSION_RE = /^\d+\.\d+\.\d+ · sms\.\d+ · [0-9a-f]{7,40}$/
const STATUS_MAP = {
  401: 'token_invalid', 403: 'token_invalid', 409: 'stale_approval', 410: 'proposal_dead',
  413: 'truncation_refused', 429: 'rate_limited',
}

// producer -> code, exactly as the spec's two right-hand columns
export function toErrorCode (event) {
  if (typeof event === 'string') return ERROR_CODES.includes(event) ? event : null
  if (!event || typeof event !== 'object') return null
  const { type, reason, status } = event

  if (status === 200) return null                       // includes replay:true — correct behaviour
  if (typeof status === 'number') {
    if (STATUS_MAP[status]) return STATUS_MAP[status]
    if (status >= 500) return 'server_error'
    return null                                          // 4xx not in the table => not an error code
  }
  if (type === 'aborted') return (reason === 'dispatch_timeout' || reason === 'session_replaced') ? reason : null
  if (type === 'dispatch_failed') return 'dispatch_failed'
  if (type === TRANSPORT_TIMEOUT_EVENT) return 'transport_unknown'
  if (type === 'exit' || type === 'command.exit') return null   // exit_code null or non-zero: not an app error
  return null
}

export function buildDiagnostics (input = {}) {
  const src = input && typeof input === 'object' ? input : {}
  const version = VERSION_RE.test(String(src.version ?? '')) ? String(src.version) : 'dev'
  const sha256 = /^[0-9a-f]{64}$/i.test(String(src.sha256 ?? '')) ? String(src.sha256).toUpperCase() : 'unpacked/dev build'
  const trust = TRUST.includes(src.trust) ? src.trust : 'off'
  const gate = GATE.includes(src.gate) ? src.gate : 'prompt_dirty'
  // v16: ring buffer of the last 3 DISTINCT codes — dedupe keeps the LAST position,
  // output oldest -> newest, so the final element is always the most recent one.
  const errors = []
  for (const raw of Array.isArray(src.errors) ? src.errors : []) {
    const code = toErrorCode(raw)
    if (!code) continue
    const at = errors.indexOf(code)
    if (at !== -1) errors.splice(at, 1)
    errors.push(code)
    if (errors.length > 3) errors.shift()
  }
  return JSON.stringify({ version, sha256, trust, gate, errors })
}
