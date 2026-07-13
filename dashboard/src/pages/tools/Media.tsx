import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getBase64FromMedia, getMessageMediaUrl, getStoredKey } from '../../api/client'
import { ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }

export function MediaPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [messageId, setMessageId] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [meta, setMeta] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function streamUrl() {
    const path = getMessageMediaUrl(name, messageId)
    // browser <img> can't set X-Api-Key easily — open authenticated fetch as blob
    return path
  }

  async function loadStream() {
    setBusy(true)
    setError(null)
    setMeta(null)
    try {
      const key = getStoredKey
      if (!key) throw new Error('Not authenticated')
      const res = await fetch(streamUrl, { headers: { 'X-Api-Key': key } })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const blob = await res.blob
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(URL.createObjectURL(blob))
      setMeta(
        JSON.stringify(
          {
            contentType: res.headers.get('content-type'),
            size: blob.size,
            endpoint: streamUrl,
          },
          null,
          2,
        ),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }

  async function loadBase64() {
    setBusy(true)
    setError(null)
    try {
      const r = await getBase64FromMedia(name, messageId)
      setMeta(JSON.stringify({ ...r, base64: `[${r.base64.length} chars]` }, null, 2))
      if (r.mimetype?.startsWith('image/') || r.mimetype?.startsWith('video/') || r.mimetype?.startsWith('audio/')) {
        const url = `data:${r.mimetype};base64,${r.base64}`
        if (previewUrl) URL.revokeObjectURL(previewUrl)
        setPreviewUrl(url)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell
      title="Mídia"
      subtitle="Download por messageId (storage → live decrypt) e getBase64 (paridaMessaging notes)."
      instanceName={name}
      onLogout={onLogout}
      actions={
        <Link to={`/instances/${encodeURIComponent(name)}`} className="btn ghost">
          ← Hub
        </Link>
      }
    >
      <ErrorBox error={error} />
      <div className="panel stack-form">
        <label>
          Message ID
          <input value={messageId} onChange={(e) => setMessageId(e.target.value)} placeholder="3EB0…" required />
        </label>
        <div className="row-actions">
          <button type="button" className="btn primary" disabled={busy || !messageId} onClick={() => void loadStream}>
            Stream GET …/messages/:id/media
          </button>
          <button type="button" className="btn ghost" disabled={busy || !messageId} onClick={() => void loadBase64}>
            getBase64FromMediaMessage
          </button>
        </div>
        <p className="muted">
          Ordem: <code>media_storage_key</code> (local/S3) → download live via cliente WhatsApp → 404. Webhooks trazem{' '}
          <code>mediaUrl</code> (storage ou path API) e <code>mediaDirectUrl</code> (CDN WA).
        </p>
      </div>

      {meta && <pre className="code-block">{meta}</pre>}
      {previewUrl && (
        <div className="panel">
          <h3>Preview</h3>
          {previewUrl.startsWith('data:video') || previewUrl.includes('video') ? (
            // biome-ignore lint/a11y/useMediaCaption: admin preview
            <video src={previewUrl} controls style={{ maxWidth: '100%', maxHeight: 420 }} />
          ) : previewUrl.startsWith('data:audio') ? (
            // biome-ignore lint/a11y/useMediaCaption: admin preview
            <audio src={previewUrl} controls />
          ) : (
            <img src={previewUrl} alt="media" style={{ maxWidth: '100%', maxHeight: 420, borderRadius: 8 }} />
          )}
        </div>
      )}
    </Shell>
  )
}
