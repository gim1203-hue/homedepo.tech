// Customers pay the merchant's original price. StopShop earns a fixed amount
// per order through a single service fee added at checkout.
export const SHIPPING_CENTS = 900
export const SERVICE_FEE_NET_CENTS = 500 // what StopShop keeps after Stripe's fee

// Stripe card pricing (U.S.): 2.9% + 30¢ on the full charge, which includes
// sales tax. TAX_BUFFER assumes up to 10% sales tax so the net never drops
// below SERVICE_FEE_NET_CENTS.
const STRIPE_PERCENT = 0.029
const STRIPE_FIXED_CENTS = 30
const TAX_BUFFER = 0.1

const roundMoney = (value) => Number(value.toFixed(2))

export function getStopShopPrice(sourcePrice) {
  const price = Number(sourcePrice)
  if (!Number.isFinite(price) || price < 0) return 0
  return roundMoney(price)
}

export function getProductPrice(product = {}) {
  const sourcePrice = Number(product.sourcePrice)
  if (Number.isFinite(sourcePrice) && sourcePrice >= 0) return getStopShopPrice(sourcePrice)

  const explicitCustomerPrice = Number(product.askKhanPrice)
  if (Number.isFinite(explicitCustomerPrice) && explicitCustomerPrice >= 0) return explicitCustomerPrice

  const listedPrice = Number(product.price)
  return Number.isFinite(listedPrice) && listedPrice >= 0 ? listedPrice : 0
}

// Service fee (in cents) for an order whose merchandise + shipping total is
// `chargeableCents`, sized so StopShop keeps SERVICE_FEE_NET_CENTS after Stripe.
export function serviceFeeCents(chargeableCents) {
  const amount = Math.max(0, Number(chargeableCents) || 0)
  const rate = STRIPE_PERCENT * (1 + TAX_BUFFER)
  return Math.ceil((rate * amount + STRIPE_FIXED_CENTS + SERVICE_FEE_NET_CENTS) / (1 - rate))
}

export function orderServiceFee(subtotalDollars) {
  return serviceFeeCents(Math.round(Number(subtotalDollars || 0) * 100) + SHIPPING_CENTS) / 100
}

// Vehicles are listed for inquiries only: no cart or card checkout. Title,
// VIN, inspection, registration and transport have to be arranged directly.
export const INQUIRY_ONLY_CATEGORIES = ['Cars & Trucks', 'Motorcycles & Powersports']

export function isInquiryOnly(product = {}) {
  return INQUIRY_ONLY_CATEGORIES.includes(product.category)
}

export function inquiryLink(product = {}) {
  return `/support?type=${encodeURIComponent('Vehicle inquiry')}&product=${encodeURIComponent(product.name || '')}`
}
