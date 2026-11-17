export function validateCart(cart) {
  if (!Array.isArray(cart) || !cart.length || cart.length > 50) return false
  const ids = new Set()
  return cart.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    if (!['string', 'number'].includes(typeof item.id) || !String(item.id) || String(item.id).length > 100) return false
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) return false
    const id = String(item.id)
    if (ids.has(id)) return false
    ids.add(id)
    return true
  })
}

export function isAvailable(product, quantity) {
  return product.stock === undefined || (Number.isFinite(Number(product.stock)) && Number(product.stock) >= quantity)
}
