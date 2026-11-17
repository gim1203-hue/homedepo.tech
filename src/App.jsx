import { Route, Routes, useLocation } from 'react-router-dom'
import { lazy, Suspense, useEffect } from 'react'
import Header from './components/Header'
import Footer from './components/Footer'
const Home = lazy(() => import('./pages/Home'))
const Shop = lazy(() => import('./pages/Shop'))
const ProductDetails = lazy(() => import('./pages/ProductDetails'))
const Favorites = lazy(() => import('./pages/Favorites'))
const Cart = lazy(() => import('./pages/Cart'))
const Checkout = lazy(() => import('./pages/Checkout'))
const OrderSuccess = lazy(() => import('./pages/OrderSuccess'))
const NotFound = lazy(() => import('./pages/NotFound'))
const Login = lazy(() => import('./pages/Login'))
const Signup = lazy(() => import('./pages/Signup'))
const Account = lazy(() => import('./pages/Account'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const Admin = lazy(() => import('./pages/Admin'))
import ProtectedRoute from './components/ProtectedRoute'
import ErrorReporter from './components/ErrorReporter'
const Support = lazy(() => import('./pages/Support'))
const Legal = lazy(() => import('./pages/Legal'))
const SupportChat = lazy(() => import('./components/SupportChat'))

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

function HoverLabels() {
  useEffect(() => {
    const applyLabels = () => {
      document.querySelectorAll('button:not([title]), a:not([title])').forEach((element) => {
        const label = element.getAttribute('aria-label') || element.textContent?.replace(/\s+/g, ' ').trim()
        if (label) element.setAttribute('title', label.slice(0, 140))
      })
    }
    applyLabels()
    const observer = new MutationObserver(applyLabels)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return null
}

export default function App() {
  const { pathname } = useLocation()
  const isAdminRoute = pathname === '/admin'

  return (
    <div className={`app-shell${isAdminRoute ? ' admin-app-shell' : ''}`}>
      <ErrorReporter />
      <ScrollToTop />
      <HoverLabels />
      {!isAdminRoute && <Header />}
      <main className={isAdminRoute ? 'admin-main' : undefined}>
        <Suspense fallback={<section className="container" role="status" aria-live="polite" style={{ paddingBlock: 60 }}>Loading…</section>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/shop" element={<Shop />} />
          <Route path="/products/:productId" element={<ProductDetails />} />
          <Route path="/favorites" element={<Favorites />} />
          <Route path="/cart" element={<Cart />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/order-success" element={<OrderSuccess />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/account" element={<ProtectedRoute><Account /></ProtectedRoute>} />
          <Route path="/support" element={<Support />} />
          <Route path="/legal/:document" element={<Legal />} />
          <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
      </main>
      {!isAdminRoute && <Footer />}
      {!isAdminRoute && <Suspense fallback={null}><SupportChat /></Suspense>}
    </div>
  )
}
