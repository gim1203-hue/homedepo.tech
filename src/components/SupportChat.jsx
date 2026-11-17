import { MessageCircle, Send, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { formatCurrency } from '../utils/format'
import '../chat.css'

const STORAGE_KEY = 'stopshop-chat'
const MAX_MESSAGES = 20
const GREETING = 'Hi! I can help you find StopShop products or sort out a problem with a purchase. What do you need?'
const FALLBACK = 'Sorry, the assistant is unavailable right now. You can email support@homedepo.tech or call or text (347) 751-1551.'

function readChat() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY))
    return Array.isArray(saved) ? saved.filter((entry) => entry && ['user', 'assistant'].includes(entry.role) && typeof entry.content === 'string') : []
  } catch { return [] }
}

function saveChat(chat) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(chat)) } catch { /* chat still works without storage */ }
}

export default function SupportChat() {
  const { session } = useAuth()
  const [open, setOpen] = useState(false)
  const [chat, setChat] = useState(readChat)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef(null)

  useEffect(() => { saveChat(chat) }, [chat])
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }) }, [chat, open, sending])

  const full = chat.length >= MAX_MESSAGES - 1

  async function send(event) {
    event.preventDefault()
    const text = input.trim().slice(0, 1000)
    if (!text || sending || full) return
    const next = [...chat, { role: 'user', content: text }]
    setChat(next)
    setInput('')
    setSending(true)
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (session) headers.Authorization = `Bearer ${await session.getIdToken()}`
      const response = await fetch('/api/assistant', {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }),
      })
      const data = await response.json().catch(() => ({}))
      setChat([...next, { role: 'assistant', content: data.reply || FALLBACK, products: Array.isArray(data.products) ? data.products : [] }])
    } catch {
      setChat([...next, { role: 'assistant', content: FALLBACK }])
    } finally {
      setSending(false)
    }
  }

  function reset() {
    setChat([])
    setInput('')
  }

  if (!open) {
    return <button type="button" className="chat-launcher" onClick={() => setOpen(true)} aria-label="Open StopShop Helper chat"><MessageCircle size={22} /><span>Need help?</span></button>
  }

  return <section className="chat-panel" aria-label="StopShop Helper chat">
    <header>
      <div><strong>StopShop Helper</strong><small>Products and order help</small></div>
      <div>
        {chat.length > 0 && <button type="button" className="chat-reset" onClick={reset}>New chat</button>}
        <button type="button" className="chat-close" onClick={() => setOpen(false)} aria-label="Close chat"><X size={18} /></button>
      </div>
    </header>
    <div className="chat-messages" ref={listRef} aria-live="polite">
      <p className="chat-bubble assistant">{GREETING}</p>
      {chat.map((entry, index) => <div key={index} className={`chat-entry ${entry.role}`}>
        <p className={`chat-bubble ${entry.role}`}>{entry.content}</p>
        {entry.products?.length > 0 && <div className="chat-products">{entry.products.map((product) => <Link key={product.id} to={product.url} className="chat-product">
          {product.image && <img src={product.image} alt="" loading="lazy" />}
          <span><strong>{product.name}</strong><small>{product.category}</small><b>{formatCurrency(product.price)}</b></span>
        </Link>)}</div>}
      </div>)}
      {sending && <p className="chat-bubble assistant chat-typing">Typing…</p>}
      {full && <p className="chat-note">This chat is full. Start a new chat, or email support@homedepo.tech.</p>}
    </div>
    <form className="chat-input" onSubmit={send}>
      <input value={input} maxLength={1000} onChange={(event) => setInput(event.target.value)} placeholder={full ? 'Start a new chat to continue' : 'Ask about a product or problem…'} aria-label="Message" disabled={full} />
      <button type="submit" disabled={sending || !input.trim() || full} aria-label="Send message"><Send size={17} /></button>
    </form>
    <p className="chat-disclaimer">AI assistant. It can make mistakes — our team confirms anything about orders or refunds.</p>
  </section>
}
