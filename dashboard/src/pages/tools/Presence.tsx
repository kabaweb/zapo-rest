import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { setChatstate, setPresence } from '../../api/client'
import { ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }

export function PresencePage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [jid, setJid] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function global(type: 'available' | 'unavailable') {
    setBusy(true)
    setError(null)
    try {
      await setPresence(name, type)
      setMsg(`Presence → ${type}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }

  async function chatstate(state: 'composing' | 'paused' | 'recording') {
    setBusy(true)
    setError(null)
    try {
      await setChatstate(name, jid, state)
      setMsg(`Chatstate ${jid} → ${state}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell
      title="Presence"
      subtitle="Online/offline global e composing/recording por chat (presence)."
      instanceName={name}
      onLogout={onLogout}
      actions={
        <Link to={`/instances/${encodeURIComponent(name)}`} className="btn ghost">
          ← Hub
        </Link>
      }
    >
      <ErrorBox error={error} />
      {msg && <p className="ok-box">{msg}</p>}

      <div className="panel-grid">
        <section className="panel">
          <h3>Presença global</h3>
          <div className="row-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void global('available')}>
              Available
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void global('unavailable')}>
              Unavailable
            </button>
          </div>
        </section>

        <section className="panel stack-form">
          <h3>Chat state</h3>
          <label>
            JID / telefone
            <input value={jid} onChange={(e) => setJid(e.target.value)} placeholder="5511…@s.whatsapp.net" />
          </label>
          <div className="row-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={busy || !jid}
              onClick={() => void chatstate('composing')}
            >
              Composing
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy || !jid}
              onClick={() => void chatstate('recording')}
            >
              Recording
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy || !jid}
              onClick={() => void chatstate('paused')}
            >
              Paused
            </button>
          </div>
        </section>
      </div>
    </Shell>
  )
}
