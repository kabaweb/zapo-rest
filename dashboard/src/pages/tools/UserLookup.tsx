import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { checkNumbers, createJidLocal, getAbout, getProfilePicture, resolveNumbers } from '../../api/client'
import { ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }

export function UserLookupPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [phones, setPhones] = useState('')
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const list = () =>
    phones
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      setResult(await fn())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell
      title="Dados do usuário"
      subtitle="Resolver JID (nono dígito), exists, foto e about — batch ou single."
      instanceName={name}
      onLogout={onLogout}
      actions={
        <Link to={`/instances/${name}`} className="btn ghost">
          ← Hub
        </Link>
      }
    >
      <ErrorBox error={error} />
      <section className="panel stack">
        <label>
          Números (um por linha ou vírgula)
          <textarea
            value={phones}
            onChange={(e) => setPhones(e.target.value)}
            rows={4}
            placeholder={'5568981159096\n5511999999999'}
          />
        </label>
        <div className="btn-row">
          <button
            type="button"
            className="primary"
            disabled={busy || !list().length}
            onClick={() => void run(() => resolveNumbers(name, list()))}
          >
            Resolver JID (WA)
          </button>
          <button
            type="button"
            disabled={busy || !list().length}
            onClick={() => void run(() => checkNumbers(name, list()))}
          >
            Check exists
          </button>
          <button
            type="button"
            disabled={busy || !list().length}
            onClick={() => void run(() => createJidLocal(name, list()))}
          >
            createJid local
          </button>
          <button
            type="button"
            disabled={busy || list().length !== 1}
            onClick={() => {
              const phone = list()[0]
              if (phone) void run(() => getProfilePicture(name, phone))
            }}
          >
            Foto
          </button>
          <button
            type="button"
            disabled={busy || list().length !== 1}
            onClick={() => {
              const phone = list()[0]
              if (phone) void run(() => getAbout(name, phone))
            }}
          >
            About
          </button>
        </div>
      </section>

      {result != null && (
        <section className="panel">
          <h2>Resultado</h2>
          <pre className="code-block">{JSON.stringify(result, null, 2)}</pre>
        </section>
      )}
    </Shell>
  )
}
