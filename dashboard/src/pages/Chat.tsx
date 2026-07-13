import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Chat, listChats, listMessages, type Message, openEventsSse, sendText } from '../api/client'

type Props = {
  instanceName: string
}

export function ChatPanel({ instanceName }: Props) {
  const [chats, setChats] = useState<Chat[]>([])
  const [activeChat, setActiveChat] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef(activeChat)
  activeRef.current = activeChat

  const refreshChats = useCallback(async () => {
    try {
      const { chats: rows } = await listChats(instanceName)
      setChats(rows)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chats')
    }
  }, [instanceName])

  const refreshMessages = useCallback(
    async (chatId: string) => {
      try {
        const { messages: rows } = await listMessages(instanceName, chatId, 80)
        setMessages([...rows].reverse())
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load messages')
      }
    },
    [instanceName],
  )

  useEffect(() => {
    void refreshChats()
    const t = setInterval(() => void refreshChats(), 15_000)
    return () => clearInterval(t)
  }, [refreshChats])

  useEffect(() => {
    if (activeChat) void refreshMessages(activeChat)
  }, [activeChat, refreshMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Realtime SSE (server → client)
  useEffect(() => {
    let es: ReturnType<typeof openEventsSse> | null = null
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (closed) return
      try {
        es = openEventsSse(instanceName)
        es.onopen = () => setLive(true)
        es.onerror = () => {
          setLive(false)
          es?.close()
          if (!closed) retry = setTimeout(connect, 2000)
        }
        es.onmessage = (ev) => {
          try {
            const payload = JSON.parse(String(ev.data)) as {
              event?: string
              data?: Message & { chatId?: string; id?: string }
            }
            if (!payload.event) return
            if (payload.event === 'message' || payload.event === 'message.any' || payload.event === 'message.inbound') {
              const msg = payload.data
              if (!msg?.id || !msg.chatId) return
              void refreshChats()
              if (activeRef.current === msg.chatId) {
                setMessages((prev) => {
                  if (prev.some((m) => m.id === msg.id)) return prev
                  return [
                    ...prev,
                    {
                      id: msg.id,
                      chatId: msg.chatId,
                      from: msg.from ?? null,
                      participant: msg.participant ?? null,
                      fromMe: Boolean(msg.fromMe),
                      timestamp: msg.timestamp ?? Date.now(),
                      ack: msg.ack ?? 0,
                      type: msg.type ?? 'text',
                      body: msg.body ?? null,
                      caption: msg.caption ?? null,
                      hasMedia: Boolean(msg.hasMedia),
                      mediaUrl: msg.mediaUrl ?? null,
                      isDeleted: Boolean(msg.isDeleted),
                      isEdited: Boolean(msg.isEdited),
                      pushName: msg.pushName ?? null,
                    },
                  ]
                })
              }
            }
            if (payload.event === 'message.ack' && payload.data?.id) {
              setMessages((prev) =>
                prev.map((m) => (m.id === payload.data?.id ? { ...m, ack: payload.data?.ack ?? m.ack } : m)),
              )
            }
          } catch {
            // ignore non-json
          }
        }
      } catch {
        setLive(false)
        if (!closed) retry = setTimeout(connect, 3000)
      }
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      es?.close()
    }
  }, [instanceName, refreshChats])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return chats
    return chats.filter((c) => c.id.toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q))
  }, [chats, filter])

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!activeChat || !draft.trim()) return
    setSending(true)
    try {
      await sendText(instanceName, activeChat, draft.trim())
      setDraft('')
      await refreshMessages(activeChat)
      await refreshChats()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Chats</h2>
          <span className={`live-dot ${live ? 'on' : ''}`} title={live ? 'Live' : 'Disconnected'}>
            {live ? '● live' : '○ offline'}
          </span>
        </div>
        <input
          placeholder="Filter chats…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ marginTop: '0.5rem' }}
        />
        <div className="chat-list">
          {filtered.length === 0 && <p className="muted">No chats yet — pair and wait for history sync.</p>}
          {filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chat-item ${activeChat === c.id ? 'active' : ''}`}
              onClick={() => setActiveChat(c.id)}
            >
              <div className="chat-item-title">
                {c.isGroup ? '👥 ' : ''}
                {c.name || shortJid(c.id)}
                {c.unreadCount > 0 && <span className="badge open">{c.unreadCount}</span>}
              </div>
              <div className="chat-item-preview muted">{c.lastMessage?.preview || c.id}</div>
            </button>
          ))}
        </div>
      </aside>

      <section className="chat-main card">
        {!activeChat ? (
          <div className="chat-empty muted">Select a conversation</div>
        ) : (
          <>
            <header className="chat-header">
              <strong>{chats.find((c) => c.id === activeChat)?.name || shortJid(activeChat)}</strong>
              <span className="muted" style={{ fontSize: '0.85rem' }}>
                {activeChat}
              </span>
            </header>
            {error && <p className="error">{error}</p>}
            <div className="chat-messages">
              {messages.map((m) => (
                <div key={m.id} className={`bubble ${m.fromMe ? 'me' : 'them'}`}>
                  {!m.fromMe && m.pushName && <div className="bubble-name">{m.pushName}</div>}
                  <div className="bubble-body">
                    {m.isDeleted ? (
                      <em className="muted">Message deleted</em>
                    ) : (
                      m.body || m.caption || (m.hasMedia ? `[${m.type}]` : `[${m.type}]`)
                    )}
                    {m.isEdited && !m.isDeleted && <span className="muted"> (edited)</span>}
                  </div>
                  <div className="bubble-meta muted">
                    {formatTs(m.timestamp)}
                    {m.fromMe && ` · ${ackLabel(m.ack)}`}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
            <form className="chat-composer" onSubmit={(e) => void handleSend(e)}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type a message…"
                disabled={sending}
              />
              <button type="submit" className="primary" disabled={sending || !draft.trim()}>
                Send
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  )
}

function shortJid(jid: string): string {
  return jid.split('@')[0] ?? jid
}

function formatTs(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts > 1e12 ? ts : ts * 1000)
  return d.toLocaleString()
}

function ackLabel(ack: number): string {
  if (ack >= 4) return 'played'
  if (ack >= 3) return 'read'
  if (ack >= 2) return 'delivered'
  if (ack >= 1) return 'sent'
  return 'pending'
}
