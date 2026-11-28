import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { badRequest, error } from './response.mjs'
import { createStore } from './state.mjs'

let createDevFault
if (process.env.RELAY_DEV === '1') {
  ({ createDevFault } = await import('./devFault.mjs'))
}

// The app calls this relay from an Electron renderer (a page origin, not curl), so every response
// needs CORS metadata or the browser throws the body away. The bearer token is the actual control —
// CORS only decides whether the *page* may read the answer — so any origin may read it, and a
// preflight is answered before auth because a preflight never carries the Authorization header.
export const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key',
  'Access-Control-Max-Age': '600',
})

function send (res, { status, body, headers }) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS, ...headers })
  res.end(JSON.stringify(body))
}

async function readBody (req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body
  } catch {
    // Invalid JSON and non-object bodies share the same error.
  }
}

export function createRelay ({ store = createStore() } = {}) {
  const token = process.env.RELAY_TOKEN
  const expected = token ? Buffer.from(`Bearer ${token}`) : undefined
  const faults = createDevFault?.()

  return createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        req.resume()
        res.writeHead(204, CORS_HEADERS)
        return res.end()
      }
      const auth = Buffer.from(req.headers.authorization ?? '')
      if (!expected || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        req.resume()
        return send(res, error(401, 'token_invalid'))
      }

      const path = req.url.split('?', 1)[0]
      if (faults && await faults.intercept(path, res, send)) {
        req.resume()
        return
      }
      const tab = /^\/v1\/tabs\/([^/]+)\/context$/.exec(path)
      const inbox = /^\/v1\/inbox\/([^/]+)$/.exec(path)
      const proposal = /^\/v1\/proposal\/([^/]+)$/.exec(path)
      const reject = /^\/v1\/proposal\/([^/]+)\/reject$/.exec(path)
      if (req.method === 'GET' && path === '/v1/tabs') return send(res, store.listTabs())
      if (req.method === 'GET' && tab) return send(res, store.getContext(tab[1]))
      if (req.method === 'GET' && inbox) return send(res, store.inbox(inbox[1]))
      if (req.method === 'GET' && proposal) return send(res, store.getProposal(proposal[1]))

      if (req.method === 'POST') {
        let handle
        if (path === '/v1/tabs') handle = store.registerTab
        else if (path === '/v1/context.push') handle = store.pushContext
        else if (path === '/v1/context.request') handle = store.createContextRequest
        else if (path === '/v1/proposal') handle = store.createProposal
        else if (reject) handle = body => store.reject(reject[1], body)
        else if (path === '/v1/command.dispatch') handle = body => store.dispatch(body, req.headers['idempotency-key'])
        else if (path === '/__fault' && faults) handle = faults.arm
        if (handle) {
          const body = await readBody(req)
          return send(res, body ? handle(body) : badRequest())
        }
      }
      req.resume()
      send(res, error(404, 'not_found'))
    } catch {
      if (!res.destroyed && !res.headersSent) send(res, error(500, 'internal_error'))
      else if (!res.destroyed) res.destroy()
    }
  })
}
