// contract: v53
// relayBridge.mjs — wires proposalService model events to the relay v2 client.
//
// The bar already had a producer (proposalService.mjs) but no transport: a proposal could be shown
// and approved without the relay ever hearing about it. This bridge is driven only by the service's
// published model, so the app keeps one state machine:
//
//   model state 'proposed'   -> relay.getProposal(proposalId)   (confirm the relay still has it)
//   model state 'executing'  -> relay.dispatch({ commandId, ... })   (only on the approve edge)
//   model state 'rejected'   -> relay.rejectProposal(id, { reason })
//   401                      -> service.noteOffline('token')
//   network/timeout          -> service.noteOffline('network')
//   expired/stale/confirm    -> service.dispatchFailed() (aborted)
//
// The token is resolved from the relay URL + relay token environment variables (or explicit
// overrides), handed straight to the client, and never stored in a log line, a model, or an
// error message. With no configuration the bridge reports `offline` and publishes that state only
// when the bar is already showing something, so a fresh app start does not grow an offline bar on
// every tab.
import { randomUUID } from 'node:crypto'

import { createRelayClientFromConfig, RelayError } from './relayClient.mjs'

export const DEFAULT_REJECT_REASON = 'user_rejected'

const nonempty = value => typeof value === 'string' && value.trim().length > 0

/**
 * Resolve relay configuration. `token` is defined as a NON-ENUMERABLE property so an accidental
 * JSON.stringify(config) / structured log can never include it.
 * @param {Record<string, string|undefined>} env
 * @param {{baseUrl?: string, token?: string}} [overrides]
 */
export function resolveRelayConfig (env = {}, overrides = {}) {
  const baseUrl = String(overrides.baseUrl ?? env.SMARTSSH_RELAY_URL ?? '').trim()
  const rawToken = overrides.token ?? env.RELAY_TOKEN ?? ''
  const token = typeof rawToken === 'string' ? rawToken : ''
  const configured = nonempty(baseUrl) && nonempty(token)
  // No token is a token problem (reset_token); a URL without a token is still a token problem.
  const cause = configured ? '' : (nonempty(token) ? 'network' : 'token')
  const config = { baseUrl, configured, cause }
  Object.defineProperty(config, 'token', { value: configured ? token : '', enumerable: false, writable: false })
  return config
}

/**
 * @param {object} options
 * @param {object} options.service       proposalService instance (subscribe/noteOffline/...)
 * @param {object|null} options.client   relay client, or null when unconfigured
 * @param {object} [options.config]      result of resolveRelayConfig()
 * @param {string|(() => string)} [options.proposalId]  current relay proposal id
 * @param {string|(() => string)} [options.tabId]
 * @param {string|(() => string)} [options.sessionId]
 * @param {() => string} [options.confirmCode]  danger confirmation code the user typed
 * @param {() => string} [options.commandId]    per-proposal command id generator
 * @param {() => string} [options.rejectReason]
 * @param {(event: object) => void} [options.onEvent]  observability hook; never receives the token
 */
export function createRelayBridge (options = {}) {
  const { service } = options
  if (!service || typeof service.subscribe !== 'function') {
    throw new Error('createRelayBridge requires a proposal service with subscribe()')
  }
  const client = options.client ?? null
  const config = options.config ?? { configured: !!client, cause: client ? '' : 'token' }
  const rejectReason = options.rejectReason ?? (() => DEFAULT_REJECT_REASON)
  const newCommandId = options.commandId ?? (() => randomUUID())
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}

  const read = (value) => (typeof value === 'function' ? value() : value)

  let proposalId = typeof options.proposalId === 'string' ? options.proposalId : ''
  let proposalIdPinned = false
  let lastState
  let fetchedFor = ''
  let dispatchedFor = ''
  let rejectedFor = ''
  let causedOffline = false
  let unsubscribe = null
  const commandIds = new Map()

  const status = () => (client ? 'online' : 'offline')
  const currentProposal = () => {
    // setProposalId() pins the value; otherwise a function option stays live.
    if (proposalIdPinned) return proposalId
    const fromOption = read(options.proposalId)
    return nonempty(fromOption) ? fromOption : proposalId
  }
  const currentTab = () => read(options.tabId) ?? ''
  const currentSession = () => read(options.sessionId) ?? ''

  function emit (event) {
    try { onEvent({ ...event, status: status() }) } catch { /* observers must not break the bridge */ }
  }

  function commandIdFor (id) {
    if (!commandIds.has(id)) commandIds.set(id, newCommandId())
    return commandIds.get(id)
  }

  function routeFailure (where, error) {
    const code = error instanceof RelayError ? error.code : 'internal_error'
    emit({ type: 'error', where, code })
    if (!client) return
    try {
      if (code === 'relay_token_invalid') service.noteOffline('token')
      else if (code === 'network' || code === 'timeout') service.noteOffline('network')
      else if (where === 'dispatch') service.dispatchFailed()
    } catch { /* a state the bar refuses to enter must not become an unhandled rejection */ }
  }

  async function fetchProposal (id) {
    try {
      const proposal = await client.getProposal(id)
      emit({ type: 'proposal', proposalId: id, state: proposal?.status ?? null })
    } catch (error) {
      routeFailure('getProposal', error)
    }
  }

  async function dispatch (id) {
    try {
      const result = await client.dispatch({
        commandId: commandIdFor(id),
        proposalId: id,
        tabId: currentTab(),
        sessionId: currentSession(),
        confirm: read(options.confirmCode),
      })
      emit({ type: 'dispatch', proposalId: id, replay: result.replay })
    } catch (error) {
      routeFailure('dispatch', error)
    }
  }

  async function reject (id) {
    try {
      const reason = read(rejectReason) || DEFAULT_REJECT_REASON
      await client.rejectProposal(id, { reason })
      emit({ type: 'reject', proposalId: id })
    } catch (error) {
      routeFailure('reject', error)
    }
  }

  function handleModel (model) {
    const prev = lastState
    const next = model?.state ?? null
    lastState = next
    if (!model) return

    if (!client) {
      // The relay is not configured: surface one offline state on an already-mounted bar, never throw.
      if (!causedOffline && next !== 'offline') {
        causedOffline = true
        try { service.noteOffline(config.cause ?? 'token') } catch { /* ignore */ }
      }
      return
    }

    if (next === 'proposed' && prev !== 'proposed') {
      const id = currentProposal()
      if (nonempty(id) && fetchedFor !== id) {
        fetchedFor = id
        void fetchProposal(id)
      }
      return
    }
    // The approve edge is the only path from proposed/counting into executing.
    if (next === 'executing' && (prev === 'proposed' || prev === 'counting')) {
      const id = currentProposal()
      if (nonempty(id) && dispatchedFor !== id) {
        dispatchedFor = id
        void dispatch(id)
      }
      return
    }
    if (next === 'rejected' && prev !== 'rejected') {
      const id = currentProposal()
      if (nonempty(id) && rejectedFor !== id) {
        rejectedFor = id
        void reject(id)
      }
    }
  }

  const counter = () => ({ fetched: fetchedFor, dispatched: dispatchedFor, rejected: rejectedFor })

  function start () {
    if (unsubscribe) return unsubscribe
    unsubscribe = service.subscribe(handleModel)
    emit({ type: 'started', configured: !!client })
    return () => { stop() }
  }

  function stop () {
    if (unsubscribe) { unsubscribe(); unsubscribe = null }
  }

  return {
    start,
    stop,
    status,
    summary: () => ({ status: status(), cause: client ? '' : (config.cause ?? 'token'), ...counter() }),
    setProposalId: (id) => {
      proposalId = typeof id === 'string' ? id : ''
      proposalIdPinned = true
    },
    noteConfirmCode: (code) => { options.confirmCode = () => code },
    client,
  }
}

/**
 * Build a bridge straight from an environment map. Unset configuration yields an offline bridge
 * with `client === null`; it never throws.
 */
export function createRelayBridgeFromEnv ({ service, env, ...options } = {}) {
  const config = resolveRelayConfig(env ?? {}, options.override ?? {})
  const client = createRelayClientFromConfig(config, options.clientOptions ?? {})
  return createRelayBridge({ ...options, service, client, config })
}
