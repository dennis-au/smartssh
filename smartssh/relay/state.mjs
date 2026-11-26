import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { badRequest, error, result } from './response.mjs'

const TTL_MS = 120_000
const MAX_LINES = 200
const MAX_BYTES = 262144
const SEVERITIES = new Set(['none', 'suspicious', 'deception'])
const RISKS = new Set(['read', 'write', 'danger'])
const dead = () => error(410, 'proposal_dead', { attempts_left: 0 })
const stale = () => error(409, 'stale_approval')
const nonempty = value => typeof value === 'string' && value.trim().length > 0

export function createStore ({ now = Date.now } = {}) {
  const proposals = new Map()
  const contexts = new Map()
  const executions = new Map()
  // Sample without replacement. Expiring a proposal never releases its code.
  const codes = Array.from({ length: 10_000 }, (_, i) => i)

  function activeProposal (id, at) {
    const proposal = proposals.get(id)
    if (proposal && at <= proposal.expires_at && proposal.attempts_left > 0) return proposal
  }

  return {
    proposals,
    contexts,
    get dispatchCount () { return executions.size },

    pushContext ({ tab_id, session_id, text, line_count, range, truncated_lines,
      redacted_segments, masks, severity }) {
      if (typeof text !== 'string') return badRequest()
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return error(413, 'truncation_refused')
      const { fromLine, toLine, at } = range ?? {}
      if (!nonempty(tab_id) || !nonempty(session_id) || !SEVERITIES.has(severity) ||
          line_count !== text.split('\n').length || !Number.isSafeInteger(fromLine) || fromLine < 1 ||
          !Number.isSafeInteger(toLine) || toLine - fromLine + 1 !== line_count ||
          !Number.isSafeInteger(truncated_lines) || truncated_lines < 0 ||
          !Array.isArray(masks) || redacted_segments !== masks.length) return badRequest()

      const server_dropped_lines = Math.max(0, line_count - MAX_LINES)
      const kept = {
        line_count: line_count - server_dropped_lines,
        truncated_lines: truncated_lines + server_dropped_lines,
        redacted_segments, severity, range: { fromLine: fromLine + server_dropped_lines, toLine },
      }
      if (!Number.isSafeInteger(kept.truncated_lines)) return badRequest()
      assert.equal(kept.range.toLine - kept.range.fromLine + 1, kept.line_count)
      const warnings = []
      if (server_dropped_lines) warnings.push({ code: 'server_truncated', dropped_lines: server_dropped_lines })
      if (severity !== 'none') warnings.push({ code: 'severity_recorded' })
      if (at !== undefined && typeof at !== 'string' && !Number.isSafeInteger(at)) return badRequest()
      contexts.set(tab_id, { tab_id, session_id, ...kept, at: at ?? new Date(now()).toISOString() })
      return result(200, { session_id, received: { ...kept, server_dropped_lines }, warnings })
    },

    getContext (id) {
      return contexts.has(id) ? result(200, contexts.get(id)) : error(404, 'not_found')
    },

    createProposal ({ tab_id, session_id, risk, command }) {
      if (!RISKS.has(risk) || ![tab_id, session_id, command].every(nonempty) || command.length > 4096) return badRequest()
      const confirmation = {}
      if (risk === 'danger') {
        if (!codes.length) return error(503, 'internal_error')
        const index = randomInt(codes.length)
        confirmation.confirm_expected = String(codes[index]).padStart(4, '0')
        codes[index] = codes[codes.length - 1]
        codes.pop()
      }
      const proposal_id = randomUUID()
      const expires_at = now() + TTL_MS
      proposals.set(proposal_id, { proposal_id, tab_id, session_id, command, risk, ...confirmation,
        status: 'proposed', attempts_left: 3, expires_at, rejection_reason: null })
      return result(200, { proposal_id, risk, ...confirmation, expires_at })
    },

    reject (id, { reason, ts }) {
      const at = now()
      const p = activeProposal(id, at)
      if (!p) return dead()
      if (p.status === 'executing' || p.status === 'done') return error(410, 'proposal_done')
      if (p.status !== 'rejected') {
        if (!nonempty(reason) || (ts !== undefined && !Number.isSafeInteger(ts))) return badRequest()
        p.status = 'rejected'
        p.rejection_reason = reason
        p.rejected_at = ts ?? at
      }
      return result(200, { proposal_id: id, status: p.status, reason: p.rejection_reason,
        rejected_at: p.rejected_at, attempts_left: p.attempts_left })
    },

    dispatch ({ proposal_id, command_id, tab_id, session_id, confirm }, key) {
      if (!nonempty(key)) return error(400, 'missing_idempotency_key')
      const at = now()
      const p = activeProposal(proposal_id, at)
      if (!p) return dead()
      // `Idempotency-Key` and `command_id` are independent identifiers: the header is required,
// but the contract never says the two values must be equal.
if (!nonempty(command_id) || p.tab_id !== tab_id || p.session_id !== session_id) return badRequest()
      if (p.status === 'rejected') return stale()
      const previous = executions.get(key)
      if (previous) {
        if (previous.proposal_id !== proposal_id) return stale()
        return { ...result(200, { status: 'executing', command_id, replay: true }), headers: { 'Idempotent-Replay': 'true' } }
      }
      if (p.status !== 'proposed') return stale()
      if (p.risk === 'danger' && (typeof confirm !== 'string' || confirm.replaceAll(' ', '') !== p.confirm_expected)) {
        return error(422, 'confirm_mismatch', { attempts_left: --p.attempts_left })
      }
      const body = { status: 'executing', command_id, proposal_id, started_at: at }
      executions.set(key, body)
      p.status = 'executing'
      return result(200, body)
    },

    getProposal (id) {
      const p = activeProposal(id, now())
      if (!p) return dead()
      const { proposal_id, status, rejection_reason, attempts_left, expires_at } = p
      return result(200, { proposal_id, status, rejection_reason, attempts_left, expires_at,
        ...(status === 'rejected' ? { rejected_at: p.rejected_at } : {}) })
    },
  }
}
