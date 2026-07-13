import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { type Contact, listContacts, shortPhone } from '../../api/client'
import { Empty, ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }

export function ContactsPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const { contacts: rows } = await listContacts(name, 500)
      setContacts(rows)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    }
  }, [name])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filtered = contacts.filter((c) => {
    const s = q.toLowerCase()
    return (
      c.id.toLowerCase().includes(s) ||
      (c.name ?? '').toLowerCase().includes(s) ||
      (c.pushName ?? '').toLowerCase().includes(s) ||
      (c.phoneNumber ?? '').includes(s)
    )
  })

  return (
    <Shell
      title="Contatos"
      subtitle="Contatos sincronizados / projetados nesta instância."
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
      <div className="panel">
        <input className="search" placeholder="Buscar contatos…" value={q} onChange={(e) => setQ(e.target.value)} />
        {filtered.length === 0 ? (
          <Empty>Nenhum contato. Pare a conta e aguarde history sync.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>JID</th>
                  <th>Telefone</th>
                  <th>LID</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name || c.pushName || '—'}</td>
                    <td className="mono tiny">{c.id}</td>
                    <td className="mono">{c.phoneNumber || shortPhone(c.id)}</td>
                    <td className="mono tiny">{c.lid ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Shell>
  )
}
