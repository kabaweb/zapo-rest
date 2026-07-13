import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { createLabel, deleteLabel, listLabels } from '../../api/client'
import { Empty, ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }

export function LabelsPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [labels, setLabels] = useState<{ id: string; name: string; color: number; isActive: boolean }[]>([])
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const { labels: rows } = await listLabels(name)
      setLabels(rows)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    }
  }, [name])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <Shell
      title="Labels"
      subtitle="Etiquetas de chat (WhatsApp Business)."
      instanceName={name}
      onLogout={onLogout}
      actions={
        <Link to={`/instances/${name}`} className="btn ghost">
          ← Hub
        </Link>
      }
    >
      <ErrorBox error={error} />
      <form
        className="panel stack"
        onSubmit={(e) =>
          void (async () => {
            e.preventDefault()
            setBusy(true)
            try {
              await createLabel(name, { name: newName })
              setNewName('')
              await refresh()
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Erro')
            } finally {
              setBusy(false)
            }
          })()
        }
      >
        <label>
          Nova label
          <div className="input-row">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} required />
            <button type="submit" className="primary" disabled={busy}>
              Criar
            </button>
          </div>
        </label>
      </form>

      <section className="panel">
        {labels.length === 0 ? (
          <Empty>Nenhuma label.</Empty>
        ) : (
          <div className="cards-list">
            {labels.map((l) => (
              <div key={l.id} className="list-card">
                <div>
                  <strong>{l.name}</strong>
                  <div className="muted tiny mono">{l.id}</div>
                  <div className="muted tiny">color {l.color}</div>
                </div>
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    void (async () => {
                      await deleteLabel(name, l.id)
                      await refresh()
                    })()
                  }
                >
                  Excluir
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </Shell>
  )
}
