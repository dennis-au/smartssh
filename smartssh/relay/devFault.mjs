import { setTimeout } from 'node:timers/promises'
import { badRequest, error, result } from './response.mjs'

export function createDevFault () {
  const faults = new Map()
  return {
    arm ({ route, mode, status = mode === 'status' ? 500 : 200, body, delay_ms = 0 }) {
      if (typeof route !== 'string' || !route.startsWith('/v1/') || !['status', 'timeout', 'body'].includes(mode) ||
          !Number.isInteger(status) || status < 200 || status > 599 || !Number.isInteger(delay_ms) ||
          delay_ms < 0 || delay_ms > 2_147_483_647 || (mode === 'body' && body === undefined)) return badRequest()
      faults.set(route, { mode, status, body, delay_ms })
      return result(200, { armed: true })
    },
    async intercept (route, res, send) {
      const fault = faults.get(route)
      if (!fault) return false
      faults.delete(route)
      if (fault.mode === 'timeout') return true // Leave the socket open until the client aborts.
      if (fault.delay_ms) await setTimeout(fault.delay_ms)
      if (!res.destroyed) send(res, fault.body === undefined ? error(fault.status, 'internal_error') : result(fault.status, fault.body))
      return true
    },
  }
}
