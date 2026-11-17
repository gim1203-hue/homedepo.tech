import Anthropic from '@anthropic-ai/sdk'
import { getFirebaseServices, recordErrorReport } from '../_lib/firebaseAdmin.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import { runShopAssistant, validateChat, SUPPORT_EMAIL, SUPPORT_PHONE } from '../_lib/shopAssistant.js'

const fallbackReply = `Sorry, the assistant is unavailable right now. You can email ${SUPPORT_EMAIL} or call or text ${SUPPORT_PHONE}.`

// Optional sign-in: signed-in customers get their email offered as contact.
async function optionalAccount(request, auth) {
  const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return null
  try {
    const user = await auth.verifyIdToken(token, true)
    return { uid: user.uid, email: user.email || '' }
  } catch {
    return null
  }
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store')
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return response.status(405).json({ error: 'Method not allowed' })
  }
  if (!process.env.ANTHROPIC_API_KEY) return response.status(503).json({ error: 'The assistant is not configured yet.', reply: fallbackReply })

  const messages = request.body?.messages
  if (!validateChat(messages)) return response.status(400).json({ error: 'This conversation is too long or invalid. Please start a new chat.' })

  try {
    await enforceRateLimit(request, response, 'assistant', 15)
    const { db, auth } = getFirebaseServices()
    const account = await optionalAccount(request, auth)
    const result = await runShopAssistant({
      db,
      messages,
      account,
      beforeEscalate: () => enforceRateLimit(request, response, 'assistant-escalation', 3, 60 * 60 * 1000),
    })
    return response.status(200).json(result)
  } catch (error) {
    if (error.statusCode === 429) return response.status(429).json({ error: error.message, reply: 'You are sending messages quickly. Please wait a minute and try again.' })
    await recordErrorReport({ source: 'chat-assistant', message: error.message }).catch(() => {})
    const status = error instanceof Anthropic.RateLimitError ? 429 : 502
    return response.status(status).json({ error: 'Assistant unavailable', reply: fallbackReply })
  }
}
