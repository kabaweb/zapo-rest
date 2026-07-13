import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiProbe } from '../../api/client'
import { ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }

type Preset = { label: string; method: string; path: string; body?: string }

export function ApiExplorerPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const base = `/v1/instances/${encodeURIComponent(name)}`

  const presets: Preset[] = useMemo(
    () => [
      { label: 'GET instance', method: 'GET', path: base },
      { label: 'GET chats', method: 'GET', path: `${base}/chats?limit=20` },
      { label: 'GET contacts', method: 'GET', path: `${base}/contacts?limit=20` },
      { label: 'GET groups', method: 'GET', path: `${base}/groups` },
      { label: 'GET webhooks', method: 'GET', path: `${base}/webhooks` },
      { label: 'GET labels', method: 'GET', path: `${base}/labels` },
      { label: 'GET lids', method: 'GET', path: `${base}/lids?limit=50` },
      { label: 'GET privacy', method: 'GET', path: `${base}/privacy` },
      { label: 'GET profile', method: 'GET', path: `${base}/profile` },
      { label: 'GET blocklist', method: 'GET', path: `${base}/blocklist` },
      { label: 'GET calls', method: 'GET', path: `${base}/calls` },
      {
        label: 'POST text',
        method: 'POST',
        path: `${base}/messages/text`,
        body: JSON.stringify({ to: '5511999999999', text: 'hello from explorer' }, null, 2),
      },
      {
        label: 'POST check numbers',
        method: 'POST',
        path: `${base}/contacts/check`,
        body: JSON.stringify({ phones: ['5511981159096'] }, null, 2),
      },
      {
        label: 'POST getBase64 media',
        method: 'POST',
        path: `${base}/media/getBase64FromMediaMessage`,
        body: JSON.stringify({ messageId: 'MESSAGE_ID' }, null, 2),
      },
      {
        label: 'POST reconcile lids',
        method: 'POST',
        path: `${base}/chats/reconcile-lids`,
        body: '{}',
      },
      { label: 'GET health', method: 'GET', path: '/health' },
      { label: 'GET openapi', method: 'GET', path: '/openapi.json' },
    ],
    [base],
  )

  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState(base)
  const [body, setBody] = useState('')
  const [out, setOut] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function apply(p: Preset) {
    setMethod(p.method)
    setPath(p.path)
    setBody(p.body ?? '')
  }

  async function run(e: React.FormEvent) {
    e.preventDefault
    setBusy(true)
    setError(null)
    try {
      let parsed: unknown
      if (body.trim() && method !== 'GET' && method !== 'HEAD') {
        parsed = JSON.parse(body)
      }
      const r = await apiProbe(method, path, parsed)
      setOut(JSON.stringify({ status: r.status, data: r.data }, null, 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell
      title="API Explorer"
      subtitle="Teste qualquer endpoint com a API key da sessão (estilo Swagger / tools)."
      instanceName={name}
      onLogout={onLogout}
      actions={
        <Link to={`/instances/${encodeURIComponent(name)}`} className="btn ghost">
          ← Hub
        </Link>
      }
    >
      <ErrorBox error={error} />

      <div className="preset-chips">
        {presets.map((p) => (
          <button key={p.label} type="button" className="chip" onClick={() => apply(p)}>
            {p.label}
          </button>
        ))}
      </div>

      <form className="panel stack-form" onSubmit={(e) => void run(e)}>
        <div className="row-actions">
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input style={{ flex: 1 }} value={path} onChange={(e) => setPath(e.target.value)} />
          <button className="btn primary" type="submit" disabled={busy}>
            Enviar
          </button>
        </div>
        {(method === 'POST' || method === 'PUT' || method === 'PATCH') && (
          <label>
            Body JSON
            <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
          </label>
        )}
      </form>

      {out && <pre className="code-block">{out}</pre>}
    </Shell>
  )
}
