import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { sendMedia, sendText } from '../../api/client'
import { ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }
type Log = { dir: 'in' | 'out' | 'sys'; text: string; at: string }

export function LiveChatPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [phone, setPhone] = useState('')
  const [started, setStarted] = useState(false)
  const [draft, setDraft] = useState('')
  const [mediaUrl, setMediaUrl] = useState('')
  const [log, setLog] = useState<Log[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function push(dir: Log['dir'], text: string) {
    setLog((l) => [...l, { dir, text, at: new Date().toLocaleTimeString() }])
  }

  async function send() {
    if (!phone || !draft.trim()) return
    setBusy(true)
    setError(null)
    try {
      const { id } = await sendText(name, phone, draft.trim())
      push('out', draft.trim())
      push('sys', `id=${id}`)
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    } finally {
      setBusy(false)
    }
  }

  async function sendImage() {
    if (!phone || !mediaUrl) return
    setBusy(true)
    try {
      const { id } = await sendMedia(name, 'image', { to: phone, mediaUrl, caption: draft | undefined })
      push('out', `[image] ${mediaUrl}`)
      push('sys', `id=${id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell
      title="Live Chat"
      subtitle="Mini chat efêmero para testar com um número (sem histórico persistido na UI)."
      instanceName={name}
      onLogout={onLogout}
      actions={
        <Link to={`/instances/${name}`} className="btn ghost">
          ← Hub
        </Link>
      }
    >
      <ErrorBox error={error} />

      {!started ? (
        <section className="panel stack narrow">
          <h2>Iniciar sessão de teste</h2>
          <label>
            Número / JID
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="5511999999999" />
          </label>
          <button
            type="button"
            className="primary"
            disabled={!phone.trim()}
            onClick={() => {
              setStarted(true)
              push('sys', `Sessão com ${phone}`)
            }}
          >
            Abrir live chat
          </button>
        </section>
      ) : (
        <section className="panel stack">
          <div className="panel-head">
            <h2>→ {phone}</h2>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setStarted(false)
                setLog([])
              }}
            >
              Trocar número
            </button>
          </div>
          <div className="live-log">
            {log.map((l) => (
              <div key={`${l.at}-${l.dir}-${l.text.slice(0, 24)}`} className={`log-line ${l.dir}`}>
                <span className="muted tiny">{l.at}</span> {l.text}
              </div>
            ))}
          </div>
          <div className="input-row">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Mensagem de texto"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void send()
              }}
            />
            <button type="button" className="primary" disabled={busy} onClick={() => void send()}>
              Enviar
            </button>
          </div>
          <div className="input-row">
            <input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="URL de imagem (HTTPS)" />
            <button type="button" disabled={busy || !mediaUrl} onClick={() => void sendImage()}>
              Enviar imagem
            </button>
          </div>
        </section>
      )}
    </Shell>
  )
}
