import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { createGroup, type Group, getGroup, groupInviteCode, joinGroup, leaveGroup, listGroups } from '../../api/client'
import { Empty, ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }

export function GroupsPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [groups, setGroups] = useState<Group[]>([])
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<Group | null>(null)
  const [invite, setInvite] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [subject, setSubject] = useState('')
  const [participants, setParticipants] = useState('')
  const [joinCode, setJoinCode] = useState('')

  const refresh = useCallback(async () => {
    try {
      const { groups: rows } = await listGroups(name)
      setGroups(rows)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    }
  }, [name])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filtered = groups.filter((g) => {
    const id = String(g.id ?? g.jid ?? '')
    const sub = String(g.subject ?? '')
    const s = q.toLowerCase()
    return id.toLowerCase().includes(s) || sub.toLowerCase().includes(s)
  })

  function gid(g: Group): string {
    return String(g.id ?? g.jid ?? '')
  }

  return (
    <Shell
      title="Gerenciador de Grupos"
      subtitle="Crie, liste e gerencie grupos WhatsApp."
      instanceName={name}
      onLogout={onLogout}
      actions={
        <>
          <button type="button" className="ghost" onClick={() => void refresh()}>
            Atualizar
          </button>
          <button type="button" className="primary" onClick={() => setShowCreate(true)}>
            + Criar Grupo
          </button>
          <Link to={`/instances/${name}`} className="btn ghost">
            ← Hub
          </Link>
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="panel stack">
        <div className="input-row">
          <input className="search" placeholder="Buscar grupos…" value={q} onChange={(e) => setQ(e.target.value)} />
          <input placeholder="Código/link invite" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} />
          <button
            type="button"
            disabled={busy || !joinCode}
            onClick={() =>
              void (async () => {
                setBusy(true)
                try {
                  await joinGroup(name, joinCode)
                  setJoinCode('')
                  await refresh()
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Erro join')
                } finally {
                  setBusy(false)
                }
              })()
            }
          >
            Entrar via link
          </button>
        </div>

        {filtered.length === 0 ? (
          <Empty>Nenhum grupo encontrado.</Empty>
        ) : (
          <div className="cards-list">
            {filtered.map((g) => (
              <div key={gid(g)} className="list-card">
                <div>
                  <strong>{String(g.subject ?? gid(g))}</strong>
                  <div className="muted tiny mono">{gid(g)}</div>
                  <div className="muted tiny">
                    {Array.isArray(g.participants) ? `${g.participants.length} participantes` : ''}
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="primary-soft"
                    onClick={() =>
                      void (async () => {
                        try {
                          const { group } = await getGroup(name, gid(g))
                          setSelected(group)
                          setInvite(null)
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Erro')
                        }
                      })()
                    }
                  >
                    Ver
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void (async () => {
                        try {
                          const res = await groupInviteCode(name, gid(g))
                          setInvite(res.inviteLink)
                          setSelected(g)
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Erro invite')
                        }
                      })()
                    }
                  >
                    Invite
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() =>
                      void (async () => {
                        if (!confirm('Sair do grupo?')) return
                        try {
                          await leaveGroup(name, gid(g))
                          await refresh()
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Erro')
                        }
                      })()
                    }
                  >
                    Sair
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="modal-backdrop">
          <button type="button" className="modal-scrim" aria-label="Fechar" onClick={() => setSelected(null)} />
          <div className="modal wide" role="dialog" aria-modal="true">
            <h2>{String(selected.subject ?? gid(selected))}</h2>
            <pre className="code-block">{JSON.stringify(selected, null, 2)}</pre>
            {invite && (
              <p>
                Invite: <a href={invite}>{invite}</a>
              </p>
            )}
            <button type="button" className="ghost" onClick={() => setSelected(null)}>
              Fechar
            </button>
          </div>
        </div>
      )}

      {showCreate && (
        <div className="modal-backdrop">
          <button type="button" className="modal-scrim" aria-label="Fechar" onClick={() => setShowCreate(false)} />
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            onSubmit={(e) =>
              void (async () => {
                e.preventDefault()
                setBusy(true)
                try {
                  await createGroup(name, {
                    subject,
                    participants: participants
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                  setShowCreate(false)
                  setSubject('')
                  setParticipants('')
                  await refresh()
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Erro create')
                } finally {
                  setBusy(false)
                }
              })()
            }
          >
            <h2>Criar grupo</h2>
            <label>
              Nome
              <input value={subject} onChange={(e) => setSubject(e.target.value)} required />
            </label>
            <label>
              Participantes (vírgula)
              <input
                value={participants}
                onChange={(e) => setParticipants(e.target.value)}
                placeholder="5511…,5512…"
                required
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setShowCreate(false)}>
                Cancelar
              </button>
              <button type="submit" className="primary" disabled={busy}>
                Criar
              </button>
            </div>
          </form>
        </div>
      )}
    </Shell>
  )
}
