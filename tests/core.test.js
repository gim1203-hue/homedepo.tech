import test from 'node:test'
import assert from 'node:assert/strict'
import { validateCart, isAvailable } from '../api/_lib/checkoutCart.js'
import { signProduct, verifyProductToken } from '../api/_lib/productToken.js'
import { savePaidOrder, notifyFulfillment, retrieveFullSession } from '../api/_lib/paidOrder.js'
import { validCart, validFavorites, readSaved, writeSaved } from '../src/utils/storage.js'

function memoryDb(initial = {}) {
  const records = new Map(Object.entries(initial))
  const ref = (path) => ({ path, collection: (name) => ref(`${path}/${name}`), doc: (id) => ref(`${path}/${id}`),
    set: async (data) => records.set(path, { ...records.get(path), ...data }),
  })
  let queue = Promise.resolve()
  return { records, collection: ref,
    runTransaction: (callback) => {
      const run = queue.then(() => callback({
        get: async (reference) => ({ data: () => records.get(reference.path) }),
        set: (reference, data) => records.set(reference.path, { ...records.get(reference.path), ...data }),
      }))
      queue = run.catch(() => {})
      return run
    },
  }
}
const session = { id: 'cs_test_order', payment_status: 'paid', metadata: { userId: 'customer' }, created: 1700000000,
  amount_total: 2900, line_items: { data: [{ description: 'Original product', quantity: 2, amount_total: 2000 }] },
}

test('checkout rejects malformed entries, duplicate IDs, fractional and excessive quantities', () => {
  for (const cart of [null, [], [null], [{ id: 'x', quantity: 1.5 }], [{ id: 'x', quantity: 11 }], [{ id: 'x', quantity: 1 }, { id: 'x', quantity: 2 }], [{ id: {}, quantity: 1 }]]) {
    assert.equal(validateCart(cart), false)
  }
  assert.equal(validateCart([{ id: 'x', quantity: 2 }]), true)
  assert.equal(isAvailable({ stock: 0 }, 1), false)
  assert.equal(isAvailable({ stock: 2 }, 3), false)
  assert.equal(isAvailable({}, 10), true)
})

test('marketplace token rejects tampering, missing expiry, and expired prices', () => {
  process.env.CHECKOUT_SIGNING_SECRET = 'test-only-signing-secret'
  const token = signProduct({ id: 'x', sourcePrice: 25 })
  assert.equal(verifyProductToken(token).sourcePrice, 25)
  assert.equal(verifyProductToken(`${token}.extra`), null)
  assert.equal(verifyProductToken(`x${token}`), null)
  const originalNow = Date.now
  try {
    Date.now = () => originalNow() + 25 * 3600000
    assert.equal(verifyProductToken(token), null)
  } finally { Date.now = originalNow }
  delete process.env.CHECKOUT_SIGNING_SECRET
})

test('payment retries preserve fulfillment, order status, operational fields and supplier items', async () => {
  const db = memoryDb({
    'customers/customer/orders/cs_test_order': { status: 'shipped', trackingNumber: 'keep-me' },
    'fulfillmentOrders/cs_test_order': { fulfillmentStatus: 'shipped', items: [{ productId: 'x' }], manualShippingCostCents: 500 },
  })
  await Promise.all([savePaidOrder(db, 'customer', session), savePaidOrder(db, 'customer', session)])
  assert.equal(db.records.get('customers/customer/orders/cs_test_order').status, 'shipped')
  assert.equal(db.records.get('customers/customer/orders/cs_test_order').trackingNumber, 'keep-me')
  const fulfillment = db.records.get('fulfillmentOrders/cs_test_order')
  assert.equal(fulfillment.fulfillmentStatus, 'shipped')
  assert.equal(fulfillment.manualShippingCostCents, 500)
  assert.deepEqual(fulfillment.items, [{ productId: 'x' }])
})

test('unpaid, supplemental and foreign-account payments cannot create ordinary orders', async () => {
  const db = memoryDb()
  assert.equal(await savePaidOrder(db, 'customer', { ...session, payment_status: 'unpaid' }), false)
  assert.equal(await savePaidOrder(db, 'customer', { ...session, metadata: { userId: 'customer', type: 'supplemental_invoice' } }), false)
  await assert.rejects(savePaidOrder(db, 'other', session), /ownership/)
  assert.equal(db.records.size, 0)
})

test('full checkout session loads paginated line items', async () => {
  const stripe = { checkout: { sessions: {
    retrieve: async () => ({ line_items: { data: [], has_more: true } }),
    listLineItems: () => ({ autoPagingToArray: async () => ['all-items'] }),
  } } }
  assert.deepEqual((await retrieveFullSession(stripe, 'cs_test')).line_items.data, ['all-items'])
})

test('concurrent fulfillment notifications send once and later retries skip', async () => {
  const previous = { fetch: globalThis.fetch, env: { ...process.env } }
  process.env.FULFILLMENT_EMAIL = 'fulfillment@example.com'
  process.env.RESEND_API_KEY = 'test-only'
  process.env.FROM_EMAIL = 'store@example.com'
  const db = memoryDb({ 'fulfillmentOrders/cs_test_order': { items: [], customerEmail: 'customer@example.com' } })
  let sends = 0
  globalThis.fetch = async (_url, options) => {
    sends++
    assert.equal(options.headers['Idempotency-Key'], 'fulfillment-cs_test_order')
    return { ok: true }
  }
  try {
    await Promise.allSettled([notifyFulfillment(db, session), notifyFulfillment(db, session)])
    await notifyFulfillment(db, session)
    assert.equal(sends, 1)
  } finally {
    globalThis.fetch = previous.fetch
    for (const name of ['FULFILLMENT_EMAIL', 'RESEND_API_KEY', 'FROM_EMAIL']) {
      if (previous.env[name] === undefined) delete process.env[name]
      else process.env[name] = previous.env[name]
    }
  }
})

test('invalid stored state and unavailable browser storage are safe', () => {
  assert.equal(validCart({}), false)
  assert.equal(validCart([null]), false)
  assert.equal(validFavorites({}), false)
  assert.deepEqual(readSaved('missing', []), [])
  assert.doesNotThrow(() => writeSaved('cart', []))
})

test('service fee always nets StopShop $5 after Stripe fees', async () => {
  const { serviceFeeCents, getProductPrice, SERVICE_FEE_NET_CENTS } = await import('../src/utils/pricing.js')
  for (const chargeable of [900, 2900, 88899, 1628900]) {
    const fee = serviceFeeCents(chargeable)
    const total = (chargeable + fee) * 1.1 // worst-case 10% sales tax
    const stripeFee = Math.round(total * 0.029 + 30)
    assert.ok(fee - stripeFee >= SERVICE_FEE_NET_CENTS, `net too low for ${chargeable}`)
  }
  assert.equal(getProductPrice({ sourcePrice: 87.99, askKhanPrice: 96.79 }), 87.99)
})

test('public products never expose merchant details', async () => {
  const { publicProduct } = await import('../api/_lib/catalog.js')
  const product = publicProduct({ id: '1', name: 'Drill', brand: 'Walmart', sellerName: 'Walmart', sellerEmail: 'a@b.com', sellerContact: 'x', externalUrl: 'https://walmart.com/1' })
  assert.equal(product.externalUrl, undefined)
  assert.equal(product.sellerEmail, '')
  assert.ok(!JSON.stringify(product).toLowerCase().includes('walmart'))
})
