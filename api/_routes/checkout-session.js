import Stripe from 'stripe'
import { requireSignedInUser, recordErrorReport } from '../_lib/firebaseAdmin.js'
import { notifyFulfillment, retrieveFullSession, savePaidOrder } from '../_lib/paidOrder.js'
import { notifyCustomerOrderPlaced } from '../_lib/customerEmail.js'

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-02-25.clover' })
  : null

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store')
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return response.status(405).json({ error: 'Method not allowed' })
  }

  if (!stripe) return response.status(503).json({ error: 'Stripe is not configured' })

  let account
  try {
    account = await requireSignedInUser(request)
  } catch (error) {
    return response.status(error.statusCode || 401).json({ error: error.message })
  }

  const sessionId = String(request.query?.id || '')
  if (!sessionId.startsWith('cs_')) return response.status(400).json({ error: 'Invalid checkout session' })

  try {
    const session = await retrieveFullSession(stripe, sessionId)
    if (session.metadata?.userId !== account.user.uid) return response.status(403).json({ error: 'This order belongs to another account.' })
    const paid = session.payment_status === 'paid'
    if (paid && await savePaidOrder(account.db, account.user.uid, session)) {
      await notifyFulfillment(account.db, session).catch((error) => recordErrorReport({ source: 'fulfillment-email', message: error.message }).catch(() => {}))
      await notifyCustomerOrderPlaced(account.db, session).catch((error) => recordErrorReport({ source: 'order-confirmation-email', message: error.message }).catch(() => {}))
    }
    return response.status(200).json({ paid, order: session.id.slice(-10).toUpperCase(), email: session.customer_details?.email || account.user.email || null })
  } catch (error) {
    console.error('Checkout confirmation failed:', error.message)
    return response.status(error?.code === 'resource_missing' ? 404 : 500).json({ error: error?.code === 'resource_missing' ? 'Checkout session not found' : 'Unable to save the confirmed order' })
  }
}
