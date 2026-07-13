import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getProfile, setProfileName, setProfileStatus } from '../../api/client'
import { ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }

export function ProfilePage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [profile, setProfile] = useState<unknown>(null)
  const [displayName, setDisplayName] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await getProfile(name)
      setProfile(res.profile)
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
      title="Perfil"
      subtitle="Nome, about e snapshot da conta vinculada."
      instanceName={name}
      onLogout={onLogout}
      actions={
        <Link to={`/instances/${name}`} className="btn ghost">
          ← Hub
        </Link>
      }
    >
      <ErrorBox error={error} />
      {ok && <div className="alert ok">{ok}</div>}

      <div className="grid-2">
        <section className="panel stack">
          <h2>Atualizar</h2>
          <label>
            Push name
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={25} />
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy || !displayName}
            onClick={() =>
              void (async () => {
                setBusy(true)
                try {
                  await setProfileName(name, displayName)
                  setOk('Nome atualizado')
                  await refresh()
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Erro')
                } finally {
                  setBusy(false)
                }
              })()
            }
          >
            Salvar nome
          </button>
          <label>
            About / status
            <input value={status} onChange={(e) => setStatus(e.target.value)} maxLength={139} />
          </label>
          <button
            type="button"
            disabled={busy || !status}
            onClick={() =>
              void (async () => {
                setBusy(true)
                try {
                  await setProfileStatus(name, status)
                  setOk('Status atualizado')
                  await refresh()
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Erro')
                } finally {
                  setBusy(false)
                }
              })()
            }
          >
            Salvar about
          </button>
        </section>

        <section className="panel">
          <h2>Snapshot</h2>
          <pre className="code-block">{JSON.stringify(profile, null, 2)}</pre>
        </section>
      </div>
    </Shell>
  )
}
