import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useAuth } from './AuthContext'
import { useCatalog } from './CatalogContext'
import { readSaved, writeSaved, validCart, validFavorites } from '../utils/storage'
import { getProductPrice } from '../utils/pricing'

const StoreContext = createContext(null)

export function StoreProvider({ children }) {
  const { session } = useAuth()
  return <CustomerStore key={session?.uid || 'guest'} owner={session?.uid || 'guest'}>{children}</CustomerStore>
}

function CustomerStore({ children, owner }) {
  const { session } = useAuth()
  const { products } = useCatalog()
  const cartKey = owner === 'guest' ? 'shopsphere-cart' : `shopsphere-cart:${owner}`
  const favoritesKey = owner === 'guest' ? 'shopsphere-favorites' : `shopsphere-favorites:${owner}`
  const [cart, setCart] = useState(() => readSaved(cartKey, readSaved('shopsphere-cart', [], validCart), validCart))
  const [favorites, setFavorites] = useState(() => readSaved(favoritesKey, readSaved('shopsphere-favorites', [], validFavorites), validFavorites))
  const [notice, setNotice] = useState('')

  useEffect(() => {
    writeSaved(cartKey, cart)
  }, [cart, cartKey])
  useEffect(() => {
    writeSaved(favoritesKey, favorites)
  }, [favorites, favoritesKey])
  useEffect(() => {
    if (!session) return undefined
    session.getIdToken()
      .then((token) => fetch('/api/customer-cart', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          items: cart.map(({ id, name, quantity, image }) => ({ id, name, quantity, image })),
        }),
      }))
      .catch(() => {})
  }, [cart, session])
  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(''), 2400)
    return () => clearTimeout(timer)
  }, [notice])

const addToCart = (product, quantity = 1) => {
  const stock =
    product.externalUrl
      ? 10
      : product.stock === undefined
      ? 10
      : Math.min(10, Math.max(0, Number(product.stock)))

  if (!Number.isFinite(stock) || stock <= 0 || !Number.isInteger(quantity) || quantity < 1) return

  setCart((current) => {
    const existing = current.find(
      (item) => String(item.id) === String(product.id)
    )

    if (!existing) {
      return [
        ...current,
        {
          ...product,
          quantity: Math.min(quantity, stock),
        },
      ]
    }

    return current.map((item) =>
      String(item.id) === String(product.id)
        ? {
            ...item,
            ...product,
            checkoutToken:
              product.checkoutToken ??
              item.checkoutToken,
            quantity: Math.min(
              item.quantity + quantity,
              stock
            ),
          }
        : item
    )
  })

  setNotice(`${product.name} added to your bag`)
}

  const updateQuantity = (id, quantity) => setCart((current) => current.map((item) => {
    if (String(item.id) !== String(id)) return item
    const stock = item.externalUrl ? 10 : Math.min(10, Math.max(1, Number(item.stock) || 10))
    return { ...item, quantity: Math.max(1, Math.min(Math.floor(Number(quantity) || 1), stock)) }
  }))
  const removeFromCart = (id) => setCart((current) => current.filter((item) => item.id !== id))
  const clearCart = useCallback(() => setCart([]), [])
  const toggleFavorite = (id) => {
    const product = products.find((item) => item.id === id)
    setFavorites((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
    setNotice(favorites.includes(id) ? `${product?.name || 'Product'} removed from favorites` : `${product?.name || 'Product'} saved to favorites`)
  }

  const cartCount = cart.reduce((total, item) => total + item.quantity, 0)
  const subtotal = cart.reduce((total, item) => total + getProductPrice(item) * item.quantity, 0)
  const favoriteProducts = products.filter((product) => favorites.includes(product.id))
  const value = { cart, favorites, favoriteProducts, notice, cartCount, subtotal, addToCart, updateQuantity, removeFromCart, clearCart, toggleFavorite }

  return <StoreContext.Provider value={value}>{children}{notice && <div className="toast" role="status">{notice}</div>}</StoreContext.Provider>
}

// The hook intentionally lives beside its provider so the store API stays in one place.
// eslint-disable-next-line react-refresh/only-export-components
export const useStore = () => useContext(StoreContext)
