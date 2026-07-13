import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getBlocklist, getBusinessProfile, getPrivacy, updatePrivacy } from '../../api/client'
import { ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }

export function PrivacyPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [privacy, setPrivacy] = useState<unknown>(null)
  const [blocklist, setBlocklist] = useState<string[]>([])
  const [biz, setBiz] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [field, setField] = useState('last')
  const [value, setValue] = useState('all')
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [p, b] = await Promise.all([getPrivacy(name), getBlocklist(name).catch(() => ({ blocklist: [] }))])
      setPrivacy(p.settings ?? p.privacy ?? p)
      setBlocklist(b.blocklist ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    }
  }, [name])

  useEffect(() => {
    void load
  }, [load])

  async function save(e: React.FormEvent) {
    e.preventDefault
    setMsg(null)
    try {
      await updatePrivacy(name, { setting: field, value })
      setMsg('Privacidade atualizada')
      await load
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    }
  }

  async function loadBiz() {
    try {
      const r = await getBusinessProfile(name)
      setBiz(r.profile ?? r)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha business profile')
    }
  }

  return (
    <Shell
      title="Privacidade & Business"
      subtitle="Settings de privacidade, blocklist e perfil comercial (API parity)."
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
          <h3>Privacidade atual</h3>
          <pre className="code-block">{JSON.stringify(privacy, null, 2)}</pre>
          <form className="stack-form" onSubmit={(e) => void save(e)}>
            <label>
              Campo
              <select value={field} onChange={(e) => setField(e.target.value)}>
                <option value="last">last (visto por último)</option>
                <option value="online">online</option>
                <option value="profile">profile</option>
                <option value="status">status</option>
                <option value="readreceipts">readreceipts</option>
                <option value="groupadd">groupadd</option>
              </select>
            </label>
            <label>
              Valor
              <select value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="all">all</option>
                <option value="contacts">contacts</option>
                <option value="contact_blacklist">contact_blacklist</option>
                <option value="none">none</option>
                <option value="match_last_seen">match_last_seen</option>
              </select>
            </label>
            <button type="submit" className="btn primary">
              Atualizar
            </button>
          </form>
        </section>

        <section className="panel">
          <h3>Blocklist ({blocklist.length})</h3>
          <ul className="plain-list">
            {blocklist.length === 0 && <li className="muted">Vazia</li>}
            {blocklist.map((j) => (
              <li key={j}>
                <code>{j}</code>
              </li>
            ))}
          </ul>
          <button type="button" className="btn ghost" onClick={() => void loadBiz}>
            Carregar business profile
          </button>
          {biz != null && <pre className="code-block">{JSON.stringify(biz, null, 2)}</pre>}
        </section>
      </div>
    </Shell>
  )
}
