import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { revokeStatus, sendStatusMedia, sendStatusText } from '../../api/client'
import { ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }

export function StatusStoriesPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [text, setText] = useState('Olá do zapo-rest')
  const [recipients, setRecipients] = useState('')
  const [mediaUrl, setMediaUrl] = useState('')
  const [caption, setCaption] = useState('')
  const [revokeId, setRevokeId] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function parseRecipients() {
    return recipients
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  async function sendText(e: React.FormEvent) {
    e.preventDefault
    setBusy(true)
    setError(null)
    try {
      const r = await sendStatusText(name, { text, recipients: parseRecipients })
      setResult(JSON.stringify(r, null, 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }

  async function sendMedia(e: React.FormEvent) {
    e.preventDefault
    setBusy(true)
    setError(null)
    try {
      const r = await sendStatusMedia(name, {
        mediaUrl,
        caption: caption | undefined,
        recipients: parseRecipients,
      })
      setResult(JSON.stringify(r, null, 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }

  async function doRevoke(e: React.FormEvent) {
    e.preventDefault
    setBusy(true)
    setError(null)
    try {
      const r = await revokeStatus(name, revokeId)
      setResult(JSON.stringify(r, null, 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell
      title="Status / Stories"
      subtitle="Publicar e revogar status (stories) — paridaMessaging notes sendStatus / status."
      instanceName={name}
      onLogout={onLogout}
      actions={
        <Link to={`/instances/${encodeURIComponent(name)}`} className="btn ghost">
          ← Hub
        </Link>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">
        Recipients = fan-out de contatos (E.164 ou JIDs). O WhatsApp exige lista de destinatários no multi-device.
      </p>

      <div className="panel-grid">
        <form className="panel stack-form" onSubmit={(e) => void sendText(e)}>
          <h3>Status texto</h3>
          <label>
            Texto
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
          </label>
          <label>
            Destinatários (vírgula)
            <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="5511…, 5521…" />
          </label>
          <button className="btn primary" type="submit" disabled={busy}>
            Publicar texto
          </button>
        </form>

        <form className="panel stack-form" onSubmit={(e) => void sendMedia(e)}>
          <h3>Status mídia</h3>
          <label>
            Media URL
            <input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://…" />
          </label>
          <label>
            Caption
            <input value={caption} onChange={(e) => setCaption(e.target.value)} />
          </label>
          <label>
            Destinatários
            <input value={recipients} onChange={(e) => setRecipients(e.target.value)} />
          </label>
          <button className="btn primary" type="submit" disabled={busy}>
            Publicar mídia
          </button>
        </form>

        <form className="panel stack-form" onSubmit={(e) => void doRevoke(e)}>
          <h3>Revogar status</h3>
          <label>
            Message ID
            <input value={revokeId} onChange={(e) => setRevokeId(e.target.value)} />
          </label>
          <button className="btn danger" type="submit" disabled={busy}>
            Revogar
          </button>
        </form>
      </div>

      {result && <pre className="code-block">{result}</pre>}
    </Shell>
  )
}
