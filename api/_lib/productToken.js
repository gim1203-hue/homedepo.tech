import crypto from 'node:crypto'

// Checkout tokens carry private merchant details (store, link, contact) from
// the search API to checkout. The payload is encrypted (AES-256-GCM) so
// customers cannot read the merchant from the browser, and HMAC-signed so it
// cannot be altered.

const encryptionKey = (secret) => crypto.createHash('sha256').update(`product-token-encryption:${secret}`).digest()

function encrypt(value, secret) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

function decrypt(payload, secret) {
  const data = Buffer.from(payload, 'base64url')
  if (data.length < 29) return null
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), data.subarray(0, 12))
  decipher.setAuthTag(data.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'))
}

export function signProduct(product) {
  const secret = process.env.CHECKOUT_SIGNING_SECRET
  if (!secret) return null

  const payload = encrypt({
    id: product.id,
    name: product.name,
    sourcePrice: product.sourcePrice,
    image: product.image,
    source: product.brand,
    externalUrl: product.externalUrl,
    sellerName: product.sellerName,
    sellerEmail: product.sellerEmail,
    sellerContact: product.sellerContact,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  }, secret)
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export function verifyProductToken(token) {
  const secret = process.env.CHECKOUT_SIGNING_SECRET
  if (!secret || typeof token !== 'string' || token.length > 16000) return null

  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra !== undefined) return null

  const expected = crypto.createHmac('sha256', secret).update(payload).digest()
  const received = Buffer.from(signature, 'base64url')
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null

  try {
    const product = decrypt(payload, secret)
    if (!product || !Number.isFinite(product.expiresAt) || product.expiresAt <= Date.now()) return null
    return product
  } catch {
    return null
  }
}
