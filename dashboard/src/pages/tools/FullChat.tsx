import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  type Chat,
  fetchAuthedBlobUrl,
  getStoredKey,
  listChats,
  listMessages,
  type Message,
  markChatRead,
  openEventsSse,
  resolveProfilePictureUrl,
  sendLocation,
  sendMedia,
  sendText,
  setChatstate,
  shortPhone,
  subscribePresence,
} from '../../api/client'
import { ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }
type ComposerMode = 'text' | 'image' | 'audio' | 'document' | 'location'

type PeerState = {
  composing?: boolean
  recording?: boolean
  online?: boolean
  label?: string
}

export function FullChatPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [chats, setChats] = useState<Chat[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState('')
  const [tab, setTab] = useState<'all' | 'contacts' | 'groups'>('all')
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [sending, setSending] = useState(false)
  const [mode, setMode] = useState<ComposerMode>('text')
  const [mediaUrl, setMediaUrl] = useState('')
  const [caption, setCaption] = useState('')
  const [fileName, setFileName] = useState('file.pdf')
  const [lat, setLat] = useState('-23.5505')
  const [lng, setLng] = useState('-46.6333')
  const [peerState, setPeerState] = useState<PeerState>({})
  const [avatars, setAvatars] = useState<Record<string, string>>({})
  const [mediaBlobs, setMediaBlobs] = useState<Record<string, string>>({})

  const bottomRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef(active)
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const peerClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  activeRef.current = active

  const refreshChats = useCallback(async () => {
    try {
      const { chats: rows } = await listChats(name)
      setChats(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro chats')
    }
  }, [name])

  const refreshMessages = useCallback(
    async (chatId: string) => {
      try {
        const { messages: rows } = await listMessages(name, chatId, 120)
        setMessages([...rows].reverse())
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro msgs')
      }
    },
    [name],
  )

  // Load chats
  useEffect(() => {
    void refreshChats()
    const t = setInterval(() => void refreshChats(), 12_000)
    return () => clearInterval(t)
  }, [refreshChats])

  // Load messages + subscribe presence (PN + LID aliases) when chat selected
  useEffect(() => {
    if (!active) return
    void refreshMessages(active)
    setPeerState({})
    void (async () => {
      try {
        // Also subscribe alt LIDs merged into this chat row
        const chat = chats.find((c) => c.id === active)
        const targets = [active, ...((chat as Chat & { altJids?: string[] })?.altJids ?? [])]
        for (const jid of targets) {
          await subscribePresence(name, jid).catch(() => undefined)
        }
      } catch {
        /* presence optional */
      }
    })()
  }, [active, name, refreshMessages, chats])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Lazy avatars for visible chats + active
  useEffect(() => {
    const ids = new Set<string>()
    for (const c of chats.slice(0, 40)) {
      if (!c.isGroup) ids.add(c.id)
    }
    if (active && !active.endsWith('@g.us')) ids.add(active)
    let cancelled = false
    void (async () => {
      for (const jid of ids) {
        if (avatars[jid] || cancelled) continue
        const url = await resolveProfilePictureUrl(name, jid)
        if (url && !cancelled) {
          setAvatars((prev) => (prev[jid] ? prev : { ...prev, [jid]: url }))
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, active, name, avatars])

  // Resolve media blob URLs for messages with API media paths
  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const m of messages) {
        if (
          !m.hasMedia &&
          m.type !== 'image' &&
          m.type !== 'audio' &&
          m.type !== 'document' &&
          m.type !== 'sticker' &&
          m.type !== 'video'
        ) {
          continue
        }
        if (mediaBlobs[m.id]) continue
        const path =
          m.mediaUrl && !m.mediaUrl.includes('mmg.whatsapp.net')
            ? m.mediaUrl
            : `/v1/instances/${encodeURIComponent(name)}/messages/${encodeURIComponent(m.id)}/media`
        if (path.startsWith('http') && !path.includes(window.location.host) && !path.includes('/v1/')) {
          // external URL (S3 public) — use directly
          if (!cancelled) setMediaBlobs((p) => ({ ...p, [m.id]: path }))
          continue
        }
        const blobUrl = await fetchAuthedBlobUrl(path.startsWith('/') ? path : path)
        if (blobUrl && !cancelled) {
          setMediaBlobs((p) => ({ ...p, [m.id]: blobUrl }))
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, name, mediaBlobs])

  // Realtime SSE (server → client)
  useEffect(() => {
    let es: ReturnType<typeof openEventsSse> | null = null
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (closed) return
      try {
        es = openEventsSse(name)
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
              data?: Record<string, unknown>
            }
            const event = payload.event
            const data = payload.data ?? {}

            if (event === 'message' || event === 'message.any' || event === 'message.inbound') {
              void refreshChats()
              const msg = data as Partial<Message> & { id?: string; chatId?: string }
              if (msg?.id && msg.chatId && activeRef.current === msg.chatId) {
                setMessages((prev) => {
                  if (prev.some((m) => m.id === msg.id)) {
                    return prev.map((m) =>
                      m.id === msg.id
                        ? {
                            ...m,
                            ...msg,
                            id: msg.id,
                            chatId: msg.chatId,
                            ack: Math.max(m.ack, msg.ack ?? 0),
                          }
                        : m,
                    )
                  }
                  return [
                    ...prev,
                    {
                      id: msg.id,
                      chatId: msg.chatId,
                      from: (msg.from as string) ?? null,
                      participant: (msg.participant as string) ?? null,
                      fromMe: Boolean(msg.fromMe),
                      timestamp: (msg.timestamp as number) ?? Date.now(),
                      ack: msg.ack ?? 0,
                      type: (msg.type as string) ?? 'text',
                      body: (msg.body as string) ?? null,
                      caption: (msg.caption as string) ?? null,
                      hasMedia: Boolean(msg.hasMedia),
                      mediaUrl: (msg.mediaUrl as string) ?? null,
                      mediaMime: (msg.mediaMime as string) ?? null,
                      mediaFilename: (msg.mediaFilename as string) ?? null,
                      isDeleted: Boolean(msg.isDeleted),
                      isEdited: Boolean(msg.isEdited),
                      pushName: (msg.pushName as string) ?? null,
                      _data: msg._data,
                    },
                  ]
                })
                // mark read for inbound
                if (!msg.fromMe) {
                  void markChatRead(name, msg.chatId, [msg.id]).catch(() => undefined)
                }
              }
            }

            if (event === 'message.ack') {
              const id = data.id as string | undefined
              const ack = data.ack as number | undefined
              if (id && typeof ack === 'number') {
                setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ack: Math.max(m.ack, ack) } : m)))
              }
            }

            if (event === 'chatstate') {
              const chatId = (data.chatId as string) ?? ''
              const raw = (data.chatIdRaw as string) ?? ''
              const aliases = Array.isArray(data.aliases) ? (data.aliases as string[]) : []
              const activeId = activeRef.current
              if (!activeId || !chatMatches(activeId, chatId, raw, aliases)) return
              const composing = Boolean(data.composing)
              const recording = Boolean(data.recording)
              const paused = Boolean(data.paused) || data.state === 'paused'
              if (peerClearTimer.current) clearTimeout(peerClearTimer.current)
              if (paused) {
                setPeerState((s) => ({ ...s, composing: false, recording: false, label: undefined }))
              } else {
                const isRec = recording || (data.state === 'composing' && data.media === 'audio')
                const isType = composing || (data.state === 'composing' && data.media !== 'audio')
                setPeerState((s) => ({
                  ...s,
                  composing: isType && !isRec,
                  recording: isRec,
                  label: isRec ? 'gravando áudio…' : 'digitando…',
                }))
                // auto-clear if no pause arrives
                peerClearTimer.current = setTimeout(() => {
                  setPeerState((s) => ({ ...s, composing: false, recording: false, label: undefined }))
                }, 8000)
              }
            }

            if (event === 'presence.update') {
              const chatId = (data.chatId as string) ?? ''
              const raw = (data.chatIdRaw as string) ?? ''
              const aliases = Array.isArray(data.aliases) ? (data.aliases as string[]) : []
              const activeId = activeRef.current
              if (!activeId || !chatMatches(activeId, chatId, raw, aliases)) return
              const type = data.type as string
              setPeerState((s) => ({
                ...s,
                online: type === 'available',
              }))
            }
          } catch {
            // ignore
          }
        }
      } catch {
        if (!closed) retry = setTimeout(connect, 3000)
      }
    }
    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      if (peerClearTimer.current) clearTimeout(peerClearTimer.current)
      es?.close()
    }
  }, [name, refreshChats])

  const filtered = useMemo(() => {
    let list = chats
    if (tab === 'groups') list = list.filter((c) => c.isGroup)
    if (tab === 'contacts') list = list.filter((c) => !c.isGroup)
    const s = filter.trim().toLowerCase()
    if (s) {
      list = list.filter((c) => c.id.toLowerCase().includes(s) || (c.name ?? '').toLowerCase().includes(s))
    }
    return list
  }, [chats, filter, tab])

  const activeChat = chats.find((c) => c.id === active)

  function onDraftChange(value: string) {
    setDraft(value)
    if (!active) return
    if (typingTimer.current) clearTimeout(typingTimer.current)
    void setChatstate(name, active, 'composing').catch(() => undefined)
    typingTimer.current = setTimeout(() => {
      void setChatstate(name, active, 'paused').catch(() => undefined)
    }, 2000)
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!active) return
    setSending(true)
    setError(null)
    try {
      if (mode === 'text') {
        if (!draft.trim()) return
        await sendText(name, active, draft.trim())
        setDraft('')
      } else if (mode === 'image' || mode === 'audio' || mode === 'document') {
        if (!mediaUrl.trim()) throw new Error('Informe a URL da mídia')
        await sendMedia(name, mode, {
          to: active,
          mediaUrl: mediaUrl.trim(),
          caption: caption | undefined,
          fileName: mode === 'document' ? fileName : undefined,
          ptt: mode === 'audio' ? true : undefined,
        })
        setMediaUrl('')
        setCaption('')
      } else if (mode === 'location') {
        await sendLocation(name, {
          to: active,
          latitude: Number(lat),
          longitude: Number(lng),
          name: caption | undefined,
        })
        setCaption('')
      }
      await setChatstate(name, active, 'paused').catch(() => undefined)
      await refreshMessages(active)
      await refreshChats()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no envio')
    } finally {
      setSending(false)
    }
  }

  const peerLabel =
    peerState.recording || peerState.composing
      ? peerState.recording
        ? 'gravando áudio…'
        : 'digitando…'
      : peerState.online
        ? 'online'
        : ''

  return (
    <Shell
      wide
      title="Chat completo"
      subtitle="Histórico, mídia, ticks e presence"
      instanceName={name}
      onLogout={onLogout}
      actions={
        <>
          <span className={`live-pill ${live ? 'on' : ''}`}>{live ? '● AO VIVO' : '○ offline'}</span>
          <Link to={`/instances/${name}`} className="btn ghost">
            ← Hub
          </Link>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="chat-layout">
        <aside className="chat-sidebar panel">
          <div className="panel-head">
            <h2>Conversas</h2>
          </div>
          <input
            className="search"
            placeholder="Buscar conversa"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="seg">
            {(['all', 'contacts', 'groups'] as const).map((t) => (
              <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t === 'all' ? 'Todas' : t === 'contacts' ? 'Contatos' : 'Grupos'}
              </button>
            ))}
          </div>
          <div className="chat-list">
            {filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`chat-item ${active === c.id ? 'active' : ''}`}
                onClick={() => setActive(c.id)}
              >
                <Avatar src={avatars[c.id]} label={c.name || c.id} />
                <div className="chat-item-body">
                  <div className="chat-item-top">
                    <strong>{c.name || shortPhone(c.id)}</strong>
                    <span className="muted tiny">{fmtTs(c.lastMessage?.timestamp)}</span>
                  </div>
                  <div className="muted tiny ellipsis">
                    {c.isGroup ? '👥 ' : ''}
                    {c.lastMessage?.preview || c.id}
                  </div>
                </div>
                {c.unreadCount > 0 && <span className="unread">{c.unreadCount}</span>}
              </button>
            ))}
            {filtered.length === 0 && <p className="muted pad">Nenhuma conversa.</p>}
          </div>
        </aside>

        <section className="chat-main panel">
          {!active ? (
            <div className="empty">Selecione uma conversa</div>
          ) : (
            <>
              <header className="chat-header">
                <Avatar src={avatars[active]} label={activeChat?.name || active} size={40} />
                <div>
                  <strong>{activeChat?.name || shortPhone(active)}</strong>
                  <div className="muted tiny">
                    {peerLabel ? (
                      <span className="peer-state">{peerLabel}</span>
                    ) : (
                      <span className="mono">{active}</span>
                    )}
                  </div>
                </div>
              </header>

              <div className="chat-messages">
                {messages.map((m) => (
                  <div key={m.id} className={`bubble ${m.fromMe ? 'me' : 'them'}`}>
                    {!m.fromMe && m.pushName && <div className="bubble-name">{m.pushName}</div>}
                    <MessageBody m={m} blobUrl={mediaBlobs[m.id]} />
                    <div className="bubble-meta">
                      <span>{fmtTs(m.timestamp)}</span>
                      {m.fromMe && <AckTicks ack={m.ack} />}
                    </div>
                  </div>
                ))}
                {peerState.composing ||
                  (peerState.recording && (
                    <div className="bubble them typing-bubble">
                      <div className="bubble-body peer-typing">
                        {peerState.recording ? '🎤 gravando áudio…' : 'digitando…'}
                      </div>
                    </div>
                  ))}
                <div ref={bottomRef} />
              </div>

              <form className="chat-composer column" onSubmit={(e) => void handleSend(e)}>
                <div className="composer-modes">
                  {(
                    [
                      ['text', 'Texto'],
                      ['image', 'Imagem'],
                      ['audio', 'Áudio'],
                      ['document', 'Doc'],
                      ['location', 'Local'],
                    ] as const
                  ).map(([k, label]) => (
                    <button key={k} type="button" className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>
                      {label}
                    </button>
                  ))}
                </div>

                {mode === 'text' && (
                  <div className="composer-row">
                    <input
                      value={draft}
                      onChange={(e) => onDraftChange(e.target.value)}
                      placeholder="Escreva uma mensagem"
                      disabled={sending}
                    />
                    <button type="submit" className="primary" disabled={sending || !draft.trim()}>
                      Enviar
                    </button>
                  </div>
                )}

                {(mode === 'image' || mode === 'audio' || mode === 'document') && (
                  <div className="composer-stack">
                    <input
                      value={mediaUrl}
                      onChange={(e) => setMediaUrl(e.target.value)}
                      placeholder="URL da mídia (https://…)"
                      disabled={sending}
                    />
                    {mode !== 'audio' && (
                      <input
                        value={caption}
                        onChange={(e) => setCaption(e.target.value)}
                        placeholder="Legenda (opcional)"
                        disabled={sending}
                      />
                    )}
                    {mode === 'document' && (
                      <input
                        value={fileName}
                        onChange={(e) => setFileName(e.target.value)}
                        placeholder="nome-do-arquivo.pdf"
                        disabled={sending}
                      />
                    )}
                    <button type="submit" className="primary" disabled={sending || !mediaUrl.trim()}>
                      Enviar {mode}
                    </button>
                  </div>
                )}

                {mode === 'location' && (
                  <div className="composer-stack">
                    <div className="composer-row">
                      <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="lat" />
                      <input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="lng" />
                    </div>
                    <input
                      value={caption}
                      onChange={(e) => setCaption(e.target.value)}
                      placeholder="Nome do local (opcional)"
                    />
                    <button type="submit" className="primary" disabled={sending}>
                      Enviar localização
                    </button>
                  </div>
                )}
              </form>
            </>
          )}
        </section>
      </div>
    </Shell>
  )
}

function Avatar({ src, label, size = 36 }: { src?: string; label: string; size?: number }) {
  if (src) {
    return (
      <img
        className="avatar img"
        src={src}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        referrerPolicy="no-referrer"
      />
    )
  }
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.35 }}>
      {initials(label)}
    </div>
  )
}

function AckTicks({ ack }: { ack: number }) {
  // 0 pending · 1 server (1 tick) · 2 delivered (2 gray) · 3+ read (2 blue)
  if (ack >= 3)
    return (
      <span className="acks read" title="Lida">
        ✓✓
      </span>
    )
  if (ack >= 2)
    return (
      <span className="acks delivered" title="Entregue">
        ✓✓
      </span>
    )
  if (ack >= 1)
    return (
      <span className="acks sent" title="Enviada">
        ✓
      </span>
    )
  return (
    <span className="acks pending" title="Pendente">
      ◔
    </span>
  )
}

function MessageBody({ m, blobUrl }: { m: Message; blobUrl?: string }) {
  if (m.isDeleted) return <div className="bubble-body muted">Mensagem apagada</div>

  if (m.type === 'image' || m.type === 'sticker') {
    return (
      <div className="bubble-body media">
        {blobUrl ? (
          <img src={blobUrl} alt={m.caption || 'imagem'} className="bubble-img" />
        ) : m.hasMedia ? (
          <span className="muted">[imagem carregando…]</span>
        ) : (
          <span className="muted">[imagem]</span>
        )}
        {m.caption && <div className="caption">{m.caption}</div>}
      </div>
    )
  }

  if (m.type === 'audio' || m.type === 'ptv') {
    return (
      <div className="bubble-body media">
        {blobUrl ? (
          // biome-ignore lint/a11y/useMediaCaption: chat voice note
          <audio controls src={blobUrl} preload="metadata" />
        ) : (
          <span className="muted">[áudio{m.hasMedia ? ' carregando…' : ''}]</span>
        )}
      </div>
    )
  }

  if (m.type === 'video') {
    return (
      <div className="bubble-body media">
        {blobUrl ? (
          // biome-ignore lint/a11y/useMediaCaption: chat video
          <video controls src={blobUrl} className="bubble-video" preload="metadata" />
        ) : (
          <span className="muted">[vídeo]</span>
        )}
        {m.caption && <div className="caption">{m.caption}</div>}
      </div>
    )
  }

  if (m.type === 'document') {
    const href = blobUrl | m.mediaUrl
    return (
      <div className="bubble-body media doc">
        <span>📄 {m.mediaFilename || m.body || 'documento'}</span>
        {href && getStoredKey() && (
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              if (blobUrl) {
                const a = document.createElement('a')
                a.href = blobUrl
                a.download = m.mediaFilename | 'document'
                a.click()
              } else if (m.mediaUrl) {
                void fetchAuthedBlobUrl(m.mediaUrl).then((u) => {
                  if (!u) return
                  const a = document.createElement('a')
                  a.href = u
                  a.download = m.mediaFilename | 'document'
                  a.click()
                })
              }
            }}
          >
            Baixar
          </button>
        )}
        {m.caption && <div className="caption">{m.caption}</div>}
      </div>
    )
  }

  if (m.type === 'location') {
    const coords = parseLocation(m)
    return (
      <div className="bubble-body media loc">
        <div>📍 {m.body || 'Localização'}</div>
        {coords && (
          <a
            href={`https://www.google.com/maps?q=${coords.lat},${coords.lng}`}
            target="_blank"
            rel="noreferrer"
            className="map-link"
          >
            Abrir no mapa ({coords.lat.toFixed(5)}, {coords.lng.toFixed(5)})
          </a>
        )}
      </div>
    )
  }

  return <div className="bubble-body">{m.body || m.caption || (m.hasMedia ? `[${m.type}]` : `[${m.type}]`)}</div>
}

function parseLocation(m: Message): { lat: number; lng: number } | null {
  // Prefer proto in _data
  // biome-ignore lint/suspicious/noExplicitAny: raw message bag
  const raw = m._data as any
  const loc =
    raw?.message?.locationMessage ??
    raw?.message?.liveLocationMessage ??
    raw?.locationMessage ??
    raw?.liveLocationMessage
  if (loc?.degreesLatitude != null && loc?.degreesLongitude != null) {
    return { lat: Number(loc.degreesLatitude), lng: Number(loc.degreesLongitude) }
  }
  // body "lat,lng" or "Name (lat,lng)"
  if (m.body) {
    const match = m.body.match(/(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/)
    if (match) return { lat: Number(match[1]), lng: Number(match[2]) }
  }
  return null
}

/**
 * Match active chat against chatstate/presence payloads.
 * WA often emits `@lid` while we store chats as `@s.whatsapp.net` (and vice-versa).
 */
function chatMatches(activeId: string, chatId: string, raw: string, aliases: string[]): boolean {
  const candidates = [chatId, raw, ...aliases].filter(Boolean)
  if (candidates.includes(activeId)) return true
  const bare = (j: string) => j.split('@')[0]?.split(':')[0] ?? j
  const activeBare = bare(activeId)
  return candidates.some((c) => bare(c) === activeBare && activeBare.length > 0)
}

function initials(s: string): string {
  const p = s.replace(/@.*/, '').trim()
  return (p.slice(0, 2) || '?').toUpperCase()
}

function fmtTs(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts > 1e12 ? ts : ts * 1000)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
