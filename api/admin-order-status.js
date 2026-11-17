import { FieldValue } from 'firebase-admin/firestore'
import { requireAdmin, sendApiError, recordErrorReport } from './_lib/firebaseAdmin.js'
import { ORDER_STATUSES, sendCustomerEmail, statusEmail } from './_lib/customerEmail.js'

const clean = (value, max) => String(value || '').trim().slice(0, max)

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return response.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { db, user } = await requireAdmin(request)
    const sessionId = clean(request.body?.sessionId, 200)
    const status = clean(request.body?.status, 40)
    const carrier = clean(request.body?.carrier, 60)
    const trackingNumber = clean(request.body?.trackingNumber, 80)
    const notifyCustomer = request.body?.notifyCustomer !== false

    if (!sessionId.startsWith('cs_')) return response.status(400).json({ error: 'Invalid order' })
    if (!ORDER_STATUSES[status]) return response.status(400).json({ error: 'Choose a valid order status' })

    const fulfillmentRef = db.collection('fulfillmentOrders').doc(sessionId)
    const fulfillment = (await fulfillmentRef.get()).data()
    if (!fulfillment?.userId) return response.status(404).json({ error: 'Order not found' })

    const customerStatus = ORDER_STATUSES[status]
    await fulfillmentRef.set({
      fulfillmentStatus: status,
      carrier,
      trackingNumber,
      statusUpdatedAt: FieldValue.serverTimestamp(),
      statusUpdatedBy: user.uid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    await db.collection('customers').doc(fulfillment.userId).collection('orders').doc(sessionId).set({
      status: customerStatus,
      carrier,
      trackingNumber,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })

    let emailed = false
    const message = notifyCustomer ? statusEmail(status, { number: sessionId.slice(-10).toUpperCase(), carrier, trackingNumber }) : null
    if (message) {
      try {
        emailed = await sendCustomerEmail(db, {
          uid: fulfillment.userId,
          to: fulfillment.customerEmail,
          ...message,
          key: `order-status-${sessionId}-${status}-${trackingNumber || 'none'}`,
          source: `order_${status}`,
        })
      } catch (emailError) {
        await recordErrorReport({ source: 'order-status-email', message: emailError.message, user: fulfillment.userId }).catch(() => {})
      }
    }

    return response.status(200).json({ status, customerStatus, emailed })
  } catch (error) {
    return sendApiError(response, error)
  }
}
