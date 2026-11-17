import { products as bundledProducts } from '../../src/data/products.js'
import { getProductPrice } from '../../src/utils/pricing.js'

export async function loadCatalog(db) {
  const productsById = new Map(
    bundledProducts.map((product) => [String(product.id), product]),
  )
  const snapshot = await db.collection('storeProducts').get()

  snapshot.forEach((document) => {
    const product = document.data()
    if (product.deleted) {
      productsById.delete(document.id)
      return
    }

    productsById.set(document.id, {
      ...productsById.get(document.id),
      ...product,
      id: document.id,
    })
  })

  return [...productsById.values()].map((product) => {
    const customerPrice = getProductPrice(product)
    return {
      ...product,
      price: customerPrice,
      askKhanPrice: customerPrice,
    }
  })
}

const PUBLIC_SELLER = 'StopShop Marketplace'
const storeLabel = (value) => (typeof value === 'string' && /^StopShop\b/.test(value) ? value : PUBLIC_SELLER)

// What customers may see. Merchant name, link, email and contact stay on the
// server (admin dashboard, fulfillment orders and the encrypted checkout token).
export function publicProduct(product) {
  const {
    externalUrl: _externalUrl,
    sellerEmail: _sellerEmail,
    sellerContact: _sellerContact,
    purchaseUrl: _purchaseUrl,
    merchantName: _merchantName,
    ...rest
  } = product
  return {
    ...rest,
    brand: storeLabel(product.brand),
    sellerName: storeLabel(product.sellerName || product.brand),
    sellerContact: 'Contact through StopShop support',
    sellerEmail: '',
  }
}
