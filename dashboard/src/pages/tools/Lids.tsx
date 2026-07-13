import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { countLids, getLid, getLidByPn, listLids, reconcileLids } from '../../api/client'
import { ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }

export function LidsPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [rows, setRows] = useState<{ lid: string; pn: string }[]>([])
  const [count, setCount] = useState<number | null>(null)
  const [lookup, setLookup] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [list, c] = await Promise.all([listLids(name, 200), countLids(name)])
      setRows(list.lids ?? [])
      setCount(c.count ?? list.total ?? list.lids?.length ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    }
  }, [name])

  useEffect(() => {
    void load
  }, [load])

  async function doReconcile() {
    setBusy(true)
    setError(null)
    try {
      const r = await reconcileLids(name)
      setResult(JSON.stringify(r, null, 2))
      await load
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }

  async function doLookup(kind: 'lid' | 'pn') {
    setBusy(true)
    setError(null)
    try {
      const r = kind === 'lid' ? await getLid(name, lookup) : await getLidByPn(name, lookup)
      setResult(JSON.stringify(r, null, 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell
      title="LID ↔ PN map"
      subtitle="Mapa de identidade WhatsApp (lids). Reconcile merge chats fantasmas @lid."
      instanceName={name}
      onLogout={onLogout}
      actions={
        <Link to={`/instances/${encodeURIComponent(name)}`} className="btn ghost">
          ← Hub
        </Link>
      }
    >
      <ErrorBox error={error} />
      <div className="row-actions" style={{ marginBottom: 16 }}>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void doReconcile}>
          Reconcile LID chats
        </button>
        <span className="muted">Total mappings: {count ?? '—'}</span>
      </div>

      <div className="panel stack-form">
        <label>
          Lookup LID ou telefone
          <input value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="123@lid ou 5511…" />
        </label>
        <div className="row-actions">
          <button type="button" className="btn ghost" disabled={busy || !lookup} onClick={() => void doLookup('lid')}>
            Por LID
          </button>
          <button type="button" className="btn ghost" disabled={busy || !lookup} onClick={() => void doLookup('pn')}>
            Por PN
          </button>
        </div>
      </div>

      {result && <pre className="code-block">{result}</pre>}

      <div className="panel">
        <h3>Mapa (até 200)</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>LID</th>
              <th>PN</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.lid}>
                <td>
                  <code>{r.lid}</code>
                </td>
                <td>
                  <code>{r.pn}</code>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={2} className="muted">
                  Nenhum mapping
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Shell>
  )
}
