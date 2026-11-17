import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { invoiceNumber } from './order.js'
import { emailAddress } from './email.js'

export async function retrieveFullSession(stripe, id) {
  const session = await stripe.checkout.sessions.retrieve(id, { expand: ['line_items', 'payment_intent.latest_charge'] })
  if (session.line_items?.has_more) {
    session.line_items = { data: await stripe.checkout.sessions.listLineItems(id, { limit: 100 }).autoPagingToArray({ limit: 1000 }), has_more: false }
  }
  return session
}

export async function savePaidOrder(db, userId, session) {
  if (session.payment_status !== 'paid' || session.metadata?.type === 'supplemental_invoice') return false
  if (String(session.metadata?.userId || session.client_reference_id || '') !== userId) throw new Error('Checkout session ownership mismatch')
  const orderRef = db.collection('customers').doc(userId).collection('orders').doc(session.id)
  const fulfillmentRef = db.collection('fulfillmentOrders').doc(session.id)
  await db.runTransaction(async (transaction) => {
    const [orderDocument, fulfillmentDocument] = await Promise.all([transaction.get(orderRef), transaction.get(fulfillmentRef)])
    const previousOrder = orderDocument.data() || {}
    const previous = fulfillmentDocument.data() || {}
    const shipping = session.collected_information?.shipping_details || session.shipping_details || null
    const order = {
      stripeSessionId: session.id,
      number: session.id.slice(-10).toUpperCase(),
      invoiceNumber: invoiceNumber(session.id, session.created),
      status: previousOrder.status || 'processing',
      paymentStatus: session.payment_status,
      email: session.customer_details?.email || session.customer_email || null,
      amountSubtotal: session.amount_subtotal || 0,
      amountShipping: session.total_details?.amount_shipping || 0,
      amountTax: session.total_details?.amount_tax || 0,
      amountDiscount: session.total_details?.amount_discount || 0,
      amountTotal: session.amount_total || 0,
      currency: session.currency || 'usd',
      items: (session.line_items?.data || []).map((item) => ({
        name: item.description || 'Purchased item',
        quantity: item.quantity || 1,
        amountTotal: item.amount_total || 0,
      })),
      shippingAddress: shipping ? { name: shipping.name || '', ...shipping.address } : null,
      shipsFrom: 'StopShop fulfillment network, United States',
      createdAt: Timestamp.fromMillis((session.created || Math.floor(Date.now() / 1000)) * 1000),
      updatedAt: FieldValue.serverTimestamp(),
    }

    transaction.set(orderRef, { ...order, createdAt: previousOrder.createdAt || order.createdAt }, { merge: true })
    transaction.set(fulfillmentRef, {
      userId,
      customerName: session.customer_details?.name || shipping?.name || '',
      customerEmail: order.email || '',
      customerPhone: session.customer_details?.phone || '',
      shippingAddress: previous.shippingAddress || order.shippingAddress,
      paymentStatus: session.payment_status,
      invoiceNumber: order.invoiceNumber,
      fulfillmentStatus: !previous.fulfillmentStatus || previous.fulfillmentStatus === 'awaiting_payment' ? 'ready_to_purchase' : previous.fulfillmentStatus,
      amountTotal: session.amount_total || 0,
      amountSubtotal: session.amount_subtotal || 0,
      amountShipping: session.total_details?.amount_shipping || 0,
      amountTax: session.total_details?.amount_tax || 0,
      currency: session.currency || 'usd',
      paidAt: previous.paidAt || order.createdAt,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
  })
  return true
}

export async function notifyFulfillment(db, session) {
  const fulfillmentEmail = emailAddress(process.env.FULFILLMENT_EMAIL || process.env.SUPPORT_REPLY_TO)
  if (!fulfillmentEmail || !process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) return
  const fulfillmentReference = db.collection('fulfillmentOrders').doc(session.id)
  const payload = await db.runTransaction(async (transaction) => {
    const document = await transaction.get(fulfillmentReference)
    const fulfillment = document.data() || {}
    if (fulfillment.notificationSentAt) return null
    if (fulfillment.notificationLeaseUntil?.toMillis?.() > Date.now()) throw new Error('Notification is processing; retry later')
    const address = fulfillment.shippingAddress
      ? Object.values(fulfillment.shippingAddress).filter(Boolean).join(', ') : 'Not supplied'
    const itemDetails = (fulfillment.items || []).map((item) => `${item.quantity} x ${item.name}\nMerchant: ${item.merchantName || 'Not supplied'}\nSupplier price: $${Number(item.sourcePrice || 0).toFixed(2)} each\nMerchant email: ${item.merchantEmail || 'Not supplied'}\nMerchant contact: ${item.merchantContact || 'Not supplied'}\nPurchase link: ${item.purchaseUrl || 'Not supplied'}`).join('\n\n')
    const message = fulfillment.notificationPayload || {
      from: process.env.FROM_EMAIL, to: [fulfillmentEmail],
      ...(emailAddress(fulfillment.customerEmail) ? { reply_to: emailAddress(fulfillment.customerEmail) } : {}),
      subject: `Paid order ${session.id.slice(-10).toUpperCase()} is ready to fulfill`,
      text: `Customer: ${fulfillment.customerName || 'Not supplied'}\nEmail: ${fulfillment.customerEmail || 'Not supplied'}\nPhone: ${fulfillment.customerPhone || 'Not supplied'}\nShip to: ${address}\nPaid total: $${((session.amount_total || 0) / 100).toFixed(2)}\n\nPRODUCTS TO PURCHASE\n\n${itemDetails || 'Product details unavailable. Open the admin order for more information.'}`,
    }
    transaction.set(fulfillmentReference, { notificationPayload: message, notificationLeaseUntil: Timestamp.fromMillis(Date.now() + 60000) }, { merge: true })
    return message
  })
  if (!payload) return
  try {
    const result = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `fulfillment-${session.id}` },
      body: JSON.stringify(payload),
    })
    if (!result.ok) throw new Error(`Fulfillment email failed: HTTP ${result.status}`)
    await fulfillmentReference.set({ notificationSentAt: FieldValue.serverTimestamp(), notificationLeaseUntil: FieldValue.delete() }, { merge: true })
  } catch (error) {
    await fulfillmentReference.set({ notificationLeaseUntil: FieldValue.delete() }, { merge: true })
    throw error
  }
}
