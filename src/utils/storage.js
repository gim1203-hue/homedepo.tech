export function readSaved(key, fallback, validate = () => true) {
  try {
    const value = JSON.parse(localStorage.getItem(key))
    return value !== null && validate(value) ? value : fallback
  } catch { return fallback }
}

export function writeSaved(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Shopping still works when browser storage is unavailable. */ }
}

export function validCart(value) {
  return Array.isArray(value) && value.every((item) => item && typeof item === 'object'
    && ['string', 'number'].includes(typeof item.id) && typeof item.name === 'string'
    && Number.isFinite(item.price) && item.price >= 0
    && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 10)
}

export const validFavorites = (value) => Array.isArray(value) && value.every((id) => ['string', 'number'].includes(typeof id))
