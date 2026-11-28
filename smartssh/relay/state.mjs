import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { badRequest, error, result } from './response.mjs'

const TTL_MS = 120_000
const MAX_LINES = 200
const MAX_BYTES = 262144
const MAX_PENDING_REQUESTS = 8
const PROMPT_SAMPLE = /^[>$#%❯λ»→][ \t]{0,7}$/u
const SEVERITIES = new Set(['none', 'suspicious', 'deception'])
const RISKS = new Set(['read', 'write', 'danger'])
const dead = () => error(410, 'proposal_dead', { attempts_left: 0 })
const stale = () => error(409, 'stale_approval')
const nonempty = value => typeof value === 'string' && value.trim().length > 0

export function createStore ({ now = Date.now } = {}) {
  const proposals = new Map()
  const contexts = new Map()
  const executions = new Map()
  const promptLedger = new Map()
  const requests = new Map()
  const tabs = new Map()
  // Sample without replacement. Expiring a proposal never releases its code.
  const codes = Array.from({ length: 10_000 }, (_, i) => i)

  function activeProposal (id, at) {
    const proposal = proposals.get(id)
    if (proposal && at <= proposal.expires_at && proposal.attempts_left > 0) return proposal
  }

  function promptFor (tab_id) {
    const entry = promptLedger.get(tab_id)
    return entry ? { token: entry.token, trusted: entry.agreements >= 2, samples: entry.agreements } : null
  }

  return {
    proposals,
    contexts,
    promptLedger,
    promptFor,
    tabs,
    get dispatchCount () { return executions.size },

    registerTab ({ tab_id, session_id, host }) {
      if (![tab_id, session_id, host].every(nonempty) || host.length > 200) return badRequest()
      const last_seen = now()
      const first_seen = tabs.get(tab_id)?.first_seen ?? last_seen
      tabs.set(tab_id, { tab_id, session_id, host, first_seen, last_seen })
      return result(200, { tab_id })
    },

    listTabs () {
      const entries = [...tabs.values()].sort((a, b) => b.last_seen - a.last_seen).map(tab => {
        const entry = promptLedger.get(tab.tab_id)
        const prompt = entry ? { trusted: entry.agreements >= 2, samples: entry.agreements } : null
        return { ...tab, prompt }
      })
      return result(200, { tabs: entries })
    },

    createContextRequest ({ tab_id, session_id }) {
      if (!nonempty(tab_id) || !nonempty(session_id)) return badRequest()
      const request_id = randomUUID()
      const created_at = now()
      const pending = []
      for (const request of requests.values()) {
        if (request.tab_id === tab_id && !request.delivered) pending.push(request.request_id)
      }
      if (pending.length >= MAX_PENDING_REQUESTS) requests.delete(pending[0])
      requests.set(request_id, { request_id, tab_id, session_id, created_at, delivered: false })
      return result(200, { request_id, expires_at: created_at + TTL_MS })
    },

    inbox (tab_id) {
      if (!nonempty(tab_id)) return badRequest()
      const items = []
      for (const request of requests.values()) {
        if (request.tab_id !== tab_id || request.delivered) continue
        request.delivered = true
        items.push({ kind: 'context_request', request_id: request.request_id })
      }
      for (const proposal of proposals.values()) {
        if (proposal.tab_id !== tab_id || proposal.status !== 'proposed' || proposal.deliveredToApp) continue
        proposal.deliveredToApp = true
        const { proposal_id, command, risk, why, confirm_expected } = proposal
        items.push({ kind: 'proposal', proposal_id, command, risk, why,
          ...(confirm_expected === undefined ? {} : { confirm_expected }) })
      }
      return result(200, { tab_id, prompt: promptFor(tab_id), items })
    },

    pushContext ({ tab_id, session_id, text, line_count, range, truncated_lines,
      redacted_segments, masks, severity, prompt_sample }) {
      if (prompt_sample !== undefined && (typeof prompt_sample !== 'string' || !PROMPT_SAMPLE.test(prompt_sample))) {
        return badRequest()
      }
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
      if (prompt_sample !== undefined) {
        const entry = promptLedger.get(tab_id)
        const agreements = entry?.token === prompt_sample ? Math.min(3, entry.agreements + 1) : 1
        promptLedger.set(tab_id, { token: prompt_sample, agreements })
      }
      const prompt = promptFor(tab_id)
      return result(200, { session_id, received: { ...kept, server_dropped_lines }, warnings,
        ...(prompt ? { prompt } : {}) })
    },

    getContext (id) {
      return contexts.has(id) ? result(200, contexts.get(id)) : error(404, 'not_found')
    },

    createProposal ({ tab_id, session_id, risk, command, why = '' }) {
      if (!RISKS.has(risk) || ![tab_id, session_id, command].every(nonempty) || command.length > 4096) return badRequest()
      if (typeof why !== 'string') return badRequest()
      const trimmedWhy = why.trim()
      if (trimmedWhy.length > 280) return badRequest()
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
      proposals.set(proposal_id, { proposal_id, tab_id, session_id, command, risk, why: trimmedWhy, ...confirmation,
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
