import Anthropic from '@anthropic-ai/sdk'
import { FieldValue } from 'firebase-admin/firestore'
import { requireAdmin, sendApiError, recordErrorReport } from '../_lib/firebaseAdmin.js'
import { draftSupportReply } from '../_lib/supportAgent.js'

// Admin-only: asks the support agent for a draft reply to one ticket. Nothing
// is sent to the customer here; the admin reviews the draft and uses the
// normal "Send reply" button.
export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return response.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { db, user } = await requireAdmin(request)
    if (!process.env.ANTHROPIC_API_KEY) return response.status(503).json({ error: 'The AI assistant is not configured. Add ANTHROPIC_API_KEY to the server environment.' })

    const ticketId = String(request.body?.ticketId || '').trim().slice(0, 100)
    if (!ticketId) return response.status(400).json({ error: 'Choose a support conversation.' })
    const reference = db.collection('supportRequests').doc(ticketId)
    const document = await reference.get()
    if (!document.exists) return response.status(404).json({ error: 'Support request not found.' })

    try {
      const { draft, model, usage } = await draftSupportReply(db, document.data())
      await reference.set({
        aiDraft: { text: draft, model, createdAt: FieldValue.serverTimestamp(), requestedBy: user.uid, inputTokens: usage?.input_tokens || 0, outputTokens: usage?.output_tokens || 0 },
      }, { merge: true })
      return response.status(200).json({ draft })
    } catch (error) {
      await recordErrorReport({ source: 'support-draft', message: error.message, user: user.uid }).catch(() => {})
      if (error instanceof Anthropic.RateLimitError) return response.status(429).json({ error: 'The AI assistant is busy. Try again in a minute.' })
      if (error instanceof Anthropic.AuthenticationError) return response.status(503).json({ error: 'The AI assistant key is invalid. Check ANTHROPIC_API_KEY.' })
      if (error instanceof Anthropic.APIError) return response.status(502).json({ error: 'The AI assistant is temporarily unavailable.' })
      return response.status(502).json({ error: error.message || 'Could not create a draft.' })
    }
  } catch (error) {
    return sendApiError(response, error)
  }
}
