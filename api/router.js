// Single Vercel function for every /api/* endpoint. The Hobby plan allows at
// most 12 functions per deployment, so the endpoints live in api/_routes/
// (folders starting with "_" are not deployed as separate functions) and
// vercel.json rewrites /api/<name> to /api/router?route=<name>.
//
// Body parsing is turned off here so webhook signatures can be checked against
// the exact bytes received. The router reads the body once, keeps the raw bytes
// on request.rawBody and puts parsed JSON on request.body for every other route.

export const config = { api: { bodyParser: false } }

const MAX_BODY_BYTES = 4 * 1024 * 1024

// Literal import() strings so Vercel bundles every route into this function.
export const routes = {
  'admin-access': () => import('./_routes/admin-access.js'),
  'admin-data': () => import('./_routes/admin-data.js'),
  'admin-email-record': () => import('./_routes/admin-email-record.js'),
  'admin-error': () => import('./_routes/admin-error.js'),
  'admin-inbound-email': () => import('./_routes/admin-inbound-email.js'),
  'admin-message': () => import('./_routes/admin-message.js'),
  'admin-order-costs': () => import('./_routes/admin-order-costs.js'),
  'admin-order-status': () => import('./_routes/admin-order-status.js'),
  'admin-password-reset': () => import('./_routes/admin-password-reset.js'),
  'admin-product': () => import('./_routes/admin-product.js'),
  'admin-refund': () => import('./_routes/admin-refund.js'),
  'admin-support-draft': () => import('./_routes/admin-support-draft.js'),
  'admin-support': () => import('./_routes/admin-support.js'),
  'assistant': () => import('./_routes/assistant.js'),
  'catalog': () => import('./_routes/catalog.js'),
  'checkout-session': () => import('./_routes/checkout-session.js'),
  'create-checkout-session': () => import('./_routes/create-checkout-session.js'),
  'customer-account': () => import('./_routes/customer-account.js'),
  'customer-cart': () => import('./_routes/customer-cart.js'),
  'customer-support': () => import('./_routes/customer-support.js'),
  'error-report': () => import('./_routes/error-report.js'),
  'newsletter': () => import('./_routes/newsletter.js'),
  'password-reset-request': () => import('./_routes/password-reset-request.js'),
  'products': () => import('./_routes/products.js'),
  'resend-webhook': () => import('./_routes/resend-webhook.js'),
  'sitemap': () => import('./_routes/sitemap.js'),
  'stripe-webhook': () => import('./_routes/stripe-webhook.js'),
}

export async function readRawBody(request) {
  if (Buffer.isBuffer(request.rawBody)) return request.rawBody
  if (request.method === 'GET' || request.method === 'HEAD') return Buffer.alloc(0)
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export function parseBody(raw, contentType = '') {
  if (!raw.length) return undefined
  const text = raw.toString('utf8')
  if (contentType.includes('application/json')) return JSON.parse(text)
  if (contentType.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text))
  return text
}

function routeName(request) {
  const fromQuery = Array.isArray(request.query?.route) ? request.query.route[0] : request.query?.route
  if (fromQuery) return String(fromQuery)
  const path = String(request.url || '').split('?')[0]
  return path.replace(/^\/api\//, '').replace(/\/$/, '')
}

export default async function router(request, response) {
  const name = routeName(request)
  const load = Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : null
  if (!load) return response.status(404).json({ error: 'Not found' })

  try {
    const raw = await readRawBody(request)
    request.rawBody = raw
    request.body = parseBody(raw, String(request.headers['content-type'] || '').toLowerCase())
  } catch (error) {
    return response.status(error.statusCode || 400).json({ error: error.statusCode === 413 ? error.message : 'Request body could not be read' })
  }

  if (request.query && 'route' in request.query) {
    const { route: _route, ...query } = request.query
    request.query = query
  }

  const { default: handler } = await load()
  return handler(request, response)
}
