import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { createWebhook, deleteWebhook, listWebhooks, updateWebhook, type WebhookConfig } from '../../api/client'
import { Empty, ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }

export function WebhooksPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([])
  const [events, setEvents] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [ev, setEv] = useState('message,instance.connection,message.ack')
  const [hmac, setHmac] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await listWebhooks(name)
      setWebhooks(res.webhooks)
      setEvents(res.availableEvents)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    }
  }, [name])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await createWebhook(name, {
        url,
        events: ev
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        hmac: hmac ? { key: hmac } : undefined,
        enabled: true,
      })
      setUrl('')
      setHmac('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell
      title="Gerenciador de Webhooks"
      subtitle="Configure URLs para receber eventos em tempo real."
      instanceName={name}
      onLogout={onLogout}
      actions={
        <>
          <button type="button" className="ghost" onClick={() => void refresh()}>
            Atualizar
          </button>
          <Link to={`/instances/${name}`} className="btn ghost">
            ← Hub
          </Link>
        </>
      }
    >
      <ErrorBox error={error} />

      <form className="panel stack" onSubmit={(e) => void add(e)}>
        <h2>Adicionar webhook</h2>
        <label>
          URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" required />
        </label>
        <label>
          Eventos (vírgula; vazio = todos)
          <input value={ev} onChange={(e) => setEv(e.target.value)} />
        </label>
        <p className="muted tiny">Disponíveis: {events.join(', ') || '…'}</p>
        <label>
          HMAC key (opcional)
          <input value={hmac} onChange={(e) => setHmac(e.target.value)} />
        </label>
        <button type="submit" className="primary" disabled={busy}>
          + Adicionar
        </button>
      </form>

      <section className="panel">
        <h2>Configurados ({webhooks.length})</h2>
        {webhooks.length === 0 ? (
          <Empty>Nenhum webhook ainda.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Events</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <div className="mono">{w.url}</div>
                      <div className="muted tiny">ID: {w.id}</div>
                    </td>
                    <td className="tiny">{w.events.length ? w.events.join(', ') : '*'}</td>
                    <td>
                      <span className={`status-pill ${w.enabled ? 'status-open' : 'status-close'}`}>
                        {w.enabled ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() =>
                            void (async () => {
                              setBusy(true)
                              try {
                                await updateWebhook(name, w.id, { enabled: !w.enabled })
                                await refresh()
                              } catch (err) {
                                setError(err instanceof Error ? err.message : 'Erro')
                              } finally {
                                setBusy(false)
                              }
                            })()
                          }
                        >
                          {w.enabled ? 'Desativar' : 'Ativar'}
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={busy}
                          onClick={() =>
                            void (async () => {
                              if (!confirm('Excluir webhook?')) return
                              setBusy(true)
                              try {
                                await deleteWebhook(name, w.id)
                                await refresh()
                              } catch (err) {
                                setError(err instanceof Error ? err.message : 'Erro')
                              } finally {
                                setBusy(false)
                              }
                            })()
                          }
                        >
                          Excluir
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  )
}
