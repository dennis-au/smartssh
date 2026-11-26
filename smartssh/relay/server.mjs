import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { badRequest, error } from './response.mjs'
import { createStore } from './state.mjs'

let createDevFault
if (process.env.RELAY_DEV === '1') {
  ({ createDevFault } = await import('./devFault.mjs'))
}

function send (res, { status, body, headers }) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
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
      const proposal = /^\/v1\/proposal\/([^/]+)$/.exec(path)
      const reject = /^\/v1\/proposal\/([^/]+)\/reject$/.exec(path)
      if (req.method === 'GET' && tab) return send(res, store.getContext(tab[1]))
      if (req.method === 'GET' && proposal) return send(res, store.getProposal(proposal[1]))

      if (req.method === 'POST') {
        let handle
        if (path === '/v1/context.push') handle = store.pushContext
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
