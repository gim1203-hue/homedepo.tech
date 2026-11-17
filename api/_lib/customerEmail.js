import { FieldValue } from 'firebase-admin/firestore'
import { emailAddress } from './email.js'

const siteUrl = () => (process.env.SITE_URL || 'https://www.homedepo.tech').replace(/\/$/, '')

export const ORDER_STATUSES = {
  ready_to_purchase: 'Processing',
  ordered_from_merchant: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}

// Sends one email to a customer through Resend. `key` makes retries safe:
// Resend ignores a second send with the same idempotency key.
export async function sendCustomerEmail(db, { uid, to, subject, text, key, source }) {
  const recipient = emailAddress(to)
  if (!recipient || !process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) return false
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ from: process.env.FROM_EMAIL, to: [recipient], subject, text, reply_to: emailAddress(process.env.SUPPORT_REPLY_TO) || undefined }),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`Customer email failed: HTTP ${response.status}`)
  await db.collection('customerMessages').doc(key).set({ uid: uid || '', email: recipient, resendId: result.id || '', subject, text, source, createdAt: FieldValue.serverTimestamp() }, { merge: true })
  return true
}

// "We received your order" email, sent once per paid order.
export async function notifyCustomerOrderPlaced(db, session) {
  const reference = db.collection('fulfillmentOrders').doc(session.id)
  const fulfillment = (await reference.get()).data() || {}
  if (fulfillment.customerConfirmationSentAt) return
  const number = session.id.slice(-10).toUpperCase()
  const items = (session.line_items?.data || []).map((item) => `${item.quantity || 1} x ${item.description || 'Item'} — $${((item.amount_total || 0) / 100).toFixed(2)}`).join('\n')
  const sent = await sendCustomerEmail(db, {
    uid: fulfillment.userId,
    to: session.customer_details?.email || session.customer_email || fulfillment.customerEmail,
    subject: `We received your StopShop order #${number}`,
    text: `Thank you for your order!\n\nOrder #${number}\n${items}\n\nTotal paid: $${((session.amount_total || 0) / 100).toFixed(2)}\n\nWe are preparing your order now and will email you again when it ships, with tracking.\n\nTrack your order any time: ${siteUrl()}/account#orders`,
    key: `order-confirmation-${session.id}`,
    source: 'order_confirmation',
  })
  if (sent) await reference.set({ customerConfirmationSentAt: FieldValue.serverTimestamp() }, { merge: true })
}

export function statusEmail(status, { number, carrier, trackingNumber }) {
  const account = `${siteUrl()}/account#orders`
  if (status === 'shipped') {
    const tracking = trackingNumber ? `\n\nCarrier: ${carrier || 'See tracking number'}\nTracking number: ${trackingNumber}` : ''
    return { subject: `Your StopShop order #${number} has shipped`, text: `Good news — your order is on its way.${tracking}\n\nView your order: ${account}` }
  }
  if (status === 'delivered') return { subject: `Your StopShop order #${number} was delivered`, text: `Your order has been marked as delivered. If anything is wrong, reply to this email or contact support from your account.\n\nView your order: ${account}` }
  if (status === 'cancelled') return { subject: `Your StopShop order #${number} was cancelled`, text: `Your order has been cancelled. If you were charged, your refund will appear on your card within 5–10 business days.\n\nQuestions? Reply to this email.\n\nView your order: ${account}` }
  return null
}
