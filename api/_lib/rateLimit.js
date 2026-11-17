import { createHash } from 'node:crypto'
import { getFirebaseServices } from './firebaseAdmin.js'

export async function enforceRateLimit(request, response, scope, limit, windowMs = 60000) {
  const { db } = getFirebaseServices()
  const ip = String(request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown').split(',')[0].trim()
  const id = createHash('sha256').update(`${scope}:${ip}`).digest('hex')
  const reference = db.collection('apiRateLimits').doc(id)
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs
  const allowed = await db.runTransaction(async (transaction) => {
    const document = await transaction.get(reference)
    const previous = document.data()
    if (previous?.windowStart === windowStart && previous.count >= limit) return false
    transaction.set(reference, {
      windowStart, count: previous?.windowStart === windowStart ? previous.count + 1 : 1,
      expiresAt: new Date(windowStart + windowMs * 2),
    })
    return true
  })
  if (!allowed) {
    response.setHeader('Retry-After', String(Math.ceil((windowStart + windowMs - Date.now()) / 1000)))
    const error = new Error('Too many requests. Please try again shortly.')
    error.statusCode = 429
    throw error
  }
}
