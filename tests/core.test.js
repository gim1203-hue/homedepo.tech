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

test('vehicles are inquiry-only and status emails mention tracking', async () => {
  const { isInquiryOnly, inquiryLink } = await import('../src/utils/pricing.js')
  assert.equal(isInquiryOnly({ category: 'Cars & Trucks' }), true)
  assert.equal(isInquiryOnly({ category: 'Motorcycles & Powersports' }), true)
  assert.equal(isInquiryOnly({ category: 'Tools & Hardware' }), false)
  assert.match(inquiryLink({ name: 'Sedan' }), /type=Vehicle%20inquiry&product=Sedan/)
  const { statusEmail, ORDER_STATUSES } = await import('../api/_lib/customerEmail.js')
  assert.match(statusEmail('shipped', { number: 'ABC', carrier: 'UPS', trackingNumber: '1Z9' }).text, /UPS[\s\S]*1Z9/)
  assert.equal(statusEmail('ordered_from_merchant', { number: 'ABC' }), null)
  assert.equal(ORDER_STATUSES.delivered, 'Delivered')
})

test('support agent tools only see the ticket owner and public product data', async () => {
  const { createSupportTools, buildTicketPrompt, draftSupportReply } = await import('../api/_lib/supportAgent.js')
  const orderDocs = {
    alice: [{ id: 'cs_test_aaaaaaaaaaAAAA111111', data: () => ({ number: 'AAAA111111', status: 'Shipped', carrier: 'UPS', trackingNumber: '1Z1', amountTotal: 9740, items: [{ name: 'Drill', quantity: 1 }] }) }],
    bob: [{ id: 'cs_test_bbbbbbbbbbBBBB222222', data: () => ({ number: 'BBBB222222', status: 'Processing', amountTotal: 500 }) }],
  }
  const db = {
    collection: (name) => name === 'storeProducts'
      ? { get: async () => ({ forEach: (fn) => [{ id: 'x1', data: () => ({ name: 'Secret Drill', category: 'Tools & Hardware', sourcePrice: 50, sellerName: 'Walmart', externalUrl: 'https://walmart.com/x', sellerEmail: 'w@w.com' }) }].forEach(fn) }) }
      : { doc: (uid) => ({ collection: () => ({ orderBy: () => ({ limit: () => ({ get: async () => ({ docs: orderDocs[uid] || [] }) }) }) }) }) },
  }
  const [listOrders, getOrder, searchProducts] = createSupportTools(db, 'alice')
  assert.match(await listOrders.run({}), /AAAA111111/)
  assert.doesNotMatch(await listOrders.run({}), /BBBB222222/)
  assert.match(await getOrder.run({ order_number: 'BBBB222222' }), /No order matching/)
  assert.match(await getOrder.run({ order_number: '#aaaa111111' }), /1Z1/)
  const found = await searchProducts.run({ query: 'secret drill' })
  assert.match(found, /Secret Drill/)
  assert.doesNotMatch(found.toLowerCase(), /walmart/)

  assert.match(buildTicketPrompt({ type: 'Order help', conversation: [{ sender: 'customer', text: 'Where is it?' }] }), /<ticket_conversation>[\s\S]*Customer: Where is it\?/)

  let params
  const client = { beta: { messages: { toolRunner: async (body) => { params = body; return { stop_reason: 'end_turn', model: body.model, usage: {}, content: [{ type: 'text', text: 'Hi! Your order shipped.\n\nStopShop Support' }] } } } } }
  const result = await draftSupportReply(db, { uid: 'alice', type: 'Order help', message: 'Where is it?' }, { client })
  assert.equal(result.draft, 'Hi! Your order shipped.\n\nStopShop Support')
  assert.equal(params.model, 'claude-opus-5-5')
  assert.equal(params.fallbacks, 'default')
  const refusing = { beta: { messages: { toolRunner: async () => ({ stop_reason: 'refusal', content: [] }) } } }
  await assert.rejects(draftSupportReply(db, { uid: 'alice', message: 'x' }, { client: refusing }), /declined/)
})

test('chat assistant validates chats, searches products only, and escalates once', async () => {
  const { validateChat, searchCatalog, runShopAssistant } = await import('../api/_lib/shopAssistant.js')
  assert.equal(validateChat([{ role: 'user', content: 'hi' }]), true)
  assert.equal(validateChat([{ role: 'assistant', content: 'hi' }]), false)
  assert.equal(validateChat([{ role: 'user', content: 'x'.repeat(1001) }]), false)
  assert.equal(validateChat(Array.from({ length: 21 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }))), false)
  assert.equal(searchCatalog([{ id: 1, name: 'Cordless Drill', category: 'Tools', price: 79.99 }, { id: 2, name: 'Sofa', category: 'Home', price: 500 }], 'cordless drill')[0].name, 'Cordless Drill')

  const added = []
  const db = {
    collection: (name) => name === 'storeProducts'
      ? { get: async () => ({ forEach: (fn) => [{ id: 'd1', data: () => ({ name: 'Hammer Drill', category: 'Tools & Hardware', sourcePrice: 120, sellerName: 'Walmart', externalUrl: 'https://walmart.com/d1' }) }].forEach(fn) }) }
      : { add: async (doc) => { added.push(doc); return { id: 'ticket1' } } },
  }
  let seen
  const client = { beta: { messages: { toolRunner: async (params) => {
    seen = params
    const [search, notify] = params.tools
    const found = await search.run({ query: 'hammer drill' })
    assert.doesNotMatch(found.toLowerCase(), /walmart/)
    assert.match(await notify.run({ customer_name: 'Sam', contact: 'not-valid', summary: 'Broken drill' }), /not a valid/)
    assert.match(await notify.run({ customer_name: 'Sam', contact: 'sam@example.com', summary: 'Broken drill, order 123' }), /saved|notified/)
    assert.match(await notify.run({ customer_name: 'Sam', contact: 'sam@example.com', summary: 'again' }), /already been notified/)
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The team has been notified.' }] }
  } } } }
  const result = await runShopAssistant({ db, messages: [{ role: 'user', content: 'My drill broke' }], client })
  assert.equal(result.escalated, true)
  assert.ok(result.products.some((product) => product.name === 'Hammer Drill'))
  assert.equal(added.length, 1)
  assert.equal(added[0].email, 'sam@example.com')
  assert.equal(seen.tools.length, 2)
  assert.equal(seen.model, 'claude-opus-5-5')

  const refusing = { beta: { messages: { toolRunner: async () => ({ stop_reason: 'refusal', content: [] }) } } }
  assert.match((await runShopAssistant({ db, messages: [{ role: 'user', content: 'x' }], client: refusing })).reply, /support@homedepo\.tech/)
})

test('preview deployments send buyers back to the preview, production to SITE_URL', async () => {
  const { siteUrl } = await import('../api/_lib/siteUrl.js')
  assert.equal(siteUrl({ VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'shop-git-feature.vercel.app', VERCEL_URL: 'shop-abc.vercel.app', SITE_URL: 'https://www.homedepo.tech' }), 'https://shop-git-feature.vercel.app')
  assert.equal(siteUrl({ VERCEL_ENV: 'preview', VERCEL_URL: 'shop-abc.vercel.app' }), 'https://shop-abc.vercel.app')
  assert.equal(siteUrl({ VERCEL_ENV: 'production', VERCEL_URL: 'shop-abc.vercel.app', SITE_URL: 'https://www.homedepo.tech/' }), 'https://www.homedepo.tech')
  assert.equal(siteUrl({}), 'https://www.homedepo.tech')
})

test('single API router dispatches routes, parses JSON and keeps raw webhook bodies', async () => {
  const { Readable } = await import('node:stream')
  const { default: router, routes, parseBody } = await import('../api/router.js')
  const { readdirSync } = await import('node:fs')
  const files = readdirSync(new URL('../api/_routes/', import.meta.url)).filter((file) => file.endsWith('.js')).map((file) => file.replace(/\.js$/, ''))
  assert.deepEqual(Object.keys(routes).sort(), files.sort())

  const makeRequest = ({ method = 'POST', route, url = '/api/router', body = '', headers = {} }) => Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url, headers, query: route ? { route, q: 'kept' } : {} })
  const makeResponse = () => {
    const response = { statusCode: 200, headers: {}, payload: undefined }
    response.status = (code) => { response.statusCode = code; return response }
    response.json = (value) => { response.payload = value; return response }
    response.setHeader = (key, value) => { response.headers[key] = value }
    return response
  }

  const missing = makeResponse()
  await router(makeRequest({ route: 'does-not-exist' }), missing)
  assert.equal(missing.statusCode, 404)

  const viaPath = makeResponse()
  await router(makeRequest({ url: '/api/nope?x=1' }), viaPath)
  assert.equal(viaPath.statusCode, 404)

  assert.deepEqual(parseBody(Buffer.from('{"a":1}'), 'application/json'), { a: 1 })
  assert.equal(parseBody(Buffer.alloc(0), 'application/json'), undefined)

  const badJson = makeResponse()
  await router(makeRequest({ route: 'assistant', body: '{bad', headers: { 'content-type': 'application/json' } }), badJson)
  assert.equal(badJson.statusCode, 400)

  const previous = { stripe: process.env.STRIPE_SECRET_KEY, anthropic: process.env.ANTHROPIC_API_KEY }
  delete process.env.STRIPE_SECRET_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    const request = makeRequest({ route: 'stripe-webhook', body: '{"id":"evt_1"}', headers: { 'content-type': 'application/json' } })
    const webhook = makeResponse()
    await router(request, webhook)
    assert.equal(webhook.statusCode, 503)
    assert.equal(request.rawBody.toString(), '{"id":"evt_1"}')
    assert.equal(request.query.route, undefined)
    assert.equal(request.query.q, 'kept')

    const assistantRequest = makeRequest({ route: 'assistant', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), headers: { 'content-type': 'application/json' } })
    const assistant = makeResponse()
    await router(assistantRequest, assistant)
    assert.equal(assistant.statusCode, 503)
    assert.deepEqual(assistantRequest.body.messages[0], { role: 'user', content: 'hi' })
  } finally {
    if (previous.stripe !== undefined) process.env.STRIPE_SECRET_KEY = previous.stripe
    if (previous.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = previous.anthropic
  }
})
