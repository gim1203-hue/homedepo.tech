import Stripe from 'stripe'
import { FieldValue } from 'firebase-admin/firestore'
import { recordErrorReport, requireSignedInUser, sendApiError } from './_lib/firebaseAdmin.js'
import { invoiceNumber } from './_lib/order.js'
import { retrieveFullSession, savePaidOrder } from './_lib/paidOrder.js'

const clean = (value, limit = 120) => String(value || '').trim().slice(0, limit)
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-02-25.clover' })
  : null

async function savePaidSession(db, userId, session) {
  if (session.payment_status !== 'paid' || String(session.metadata?.userId || session.client_reference_id || '') !== userId) return false
  const complete = await retrieveFullSession(stripe, session.id)
  return savePaidOrder(db, userId, complete)
}

async function reconcilePaidOrders(db, userId, existingOrderIds) {
  if (!stripe) return false
  const fulfillment = await db.collection('fulfillmentOrders').where('userId', '==', userId).limit(50).get()
  const missingIds = fulfillment.docs.map((document) => document.id).filter((id) => id.startsWith('cs_') && !existingOrderIds.has(id))
  let sessions = await Promise.all(missingIds.map((id) => stripe.checkout.sessions.retrieve(id, { expand: ['line_items'] })))

  if (!sessions.length && existingOrderIds.size === 0) {
    const recent = await stripe.checkout.sessions.list({ limit: 100, expand: ['data.line_items'] })
    sessions = recent.data.filter((session) => String(session.metadata?.userId || session.client_reference_id || '') === userId)
  }

  const saved = await Promise.all(sessions.map((session) => savePaidSession(db, userId, session)))
  return saved.some(Boolean)
}

export default async function handler(request, response) {
  try {
    const { user, db } = await requireSignedInUser(request)
    const customer = db.collection('customers').doc(user.uid)

    if (request.method === 'GET') {
      let [ordersSnapshot, addressesSnapshot] = await Promise.all([
        customer.collection('orders').orderBy('createdAt', 'desc').limit(50).get(),
        customer.collection('addresses').orderBy('createdAt', 'desc').limit(20).get(),
      ])
      try {
        const restored = await reconcilePaidOrders(db, user.uid, new Set(ordersSnapshot.docs.map((document) => document.id)))
        if (restored) ordersSnapshot = await customer.collection('orders').orderBy('createdAt', 'desc').limit(50).get()
      } catch (error) {
        await recordErrorReport({ source: 'order-reconciliation', message: error.message, user: user.uid }).catch(() => {})
      }
      const serialize = (document) => {
        const data = document.data()
        return {
          id: document.id,
          ...data,
          invoiceNumber: data.invoiceNumber || invoiceNumber(document.id, data.createdAt?.toMillis?.() || data.createdAt || Date.now()),
          createdAt: data.createdAt?.toDate?.().toISOString() || data.createdAt || null,
          estimatedShipDate: data.estimatedShipDate?.toDate?.().toISOString() || data.estimatedShipDate || null,
          estimatedDeliveryDate: data.estimatedDeliveryDate?.toDate?.().toISOString() || data.estimatedDeliveryDate || null,
        }
      }
      return response.status(200).json({
        orders: ordersSnapshot.docs.map(serialize),
        addresses: addressesSnapshot.docs.map(serialize),
      })
    }

    if (request.method === 'POST') {
      const address = {
        name: clean(request.body?.name),
        line1: clean(request.body?.line1),
        line2: clean(request.body?.line2),
        city: clean(request.body?.city),
        state: clean(request.body?.state),
        postalCode: clean(request.body?.postalCode, 30),
        country: clean(request.body?.country, 2).toUpperCase(),
      }
      if (!address.name || !address.line1 || !address.city || !address.state || !address.postalCode || !address.country) {
        return response.status(400).json({ error: 'Complete all required address fields.' })
      }
      const document = await customer.collection('addresses').add({ ...address, createdAt: FieldValue.serverTimestamp() })
      return response.status(201).json({ id: document.id, ...address, createdAt: new Date().toISOString() })
    }

    if (request.method === 'DELETE') {
      const id = clean(request.query?.id, 100)
      if (!id) return response.status(400).json({ error: 'Address id is required.' })
      await customer.collection('addresses').doc(id).delete()
      return response.status(200).json({ removed: true })
    }

    response.setHeader('Allow', 'GET, POST, DELETE')
    return response.status(405).json({ error: 'Method not allowed' })
  } catch (error) {
    return sendApiError(response, error)
  }
}
