import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { sendContact, sendLocation, sendMedia, sendPoll, sendReact, sendText } from '../../api/client'
import { ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }
type Kind = 'text' | 'image' | 'video' | 'audio' | 'document' | 'location' | 'poll' | 'contact' | 'react'

export function SendTesterPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [kind, setKind] = useState<Kind>('text')
  const [to, setTo] = useState('')
  const [text, setText] = useState('')
  const [mediaUrl, setMediaUrl] = useState('')
  const [caption, setCaption] = useState('')
  const [fileName, setFileName] = useState('file.pdf')
  const [lat, setLat] = useState('-23.55')
  const [lng, setLng] = useState('-46.63')
  const [pollName, setPollName] = useState('Opções?')
  const [pollOpts, setPollOpts] = useState('A,B,C')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [msgId, setMsgId] = useState('')
  const [emoji, setEmoji] = useState('👍')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      let id = ''
      if (kind === 'text') {
        ;({ id } = await sendText(name, to, text))
      } else if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'document') {
        ;({ id } = await sendMedia(name, kind, {
          to,
          mediaUrl,
          caption: caption | undefined,
          fileName: kind === 'document' ? fileName : undefined,
          ptt: kind === 'audio' ? true : undefined,
        }))
      } else if (kind === 'location') {
        ;({ id } = await sendLocation(name, {
          to,
          latitude: Number(lat),
          longitude: Number(lng),
          name: caption | undefined,
        }))
      } else if (kind === 'poll') {
        ;({ id } = await sendPoll(name, {
          to,
          name: pollName,
          options: pollOpts
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        }))
      } else if (kind === 'contact') {
        ;({ id } = await sendContact(name, {
          to,
          contacts: [{ fullName: contactName, phoneNumber: contactPhone }],
        }))
      } else if (kind === 'react') {
        ;({ id } = await sendReact(name, { to, messageId: msgId, emoji }))
      }
      setResult(`OK · message id: ${id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell
      title="Envio de mensagens"
      subtitle="Teste todos os tipos de envio da API."
      instanceName={name}
      onLogout={onLogout}
      actions={
        <Link to={`/instances/${name}`} className="btn ghost">
          ← Hub
        </Link>
      }
    >
      <ErrorBox error={error} />
      {result && <div className="alert ok">{result}</div>}

      <form className="panel stack" onSubmit={(e) => void submit(e)}>
        <div className="seg wrap">
          {(['text', 'image', 'video', 'audio', 'document', 'location', 'poll', 'contact', 'react'] as Kind[]).map(
            (k) => (
              <button key={k} type="button" className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                {k}
              </button>
            ),
          )}
        </div>

        <label>
          Destino (telefone ou JID)
          <input value={to} onChange={(e) => setTo(e.target.value)} required placeholder="5511…" />
        </label>

        {(kind === 'text' || kind === 'image' || kind === 'video' || kind === 'document') && (
          <label>
            {kind === 'text' ? 'Texto' : 'Caption (opcional)'}
            <textarea
              value={kind === 'text' ? text : caption}
              onChange={(e) => (kind === 'text' ? setText(e.target.value) : setCaption(e.target.value))}
              rows={3}
              required={kind === 'text'}
            />
          </label>
        )}

        {['image', 'video', 'audio', 'document'].includes(kind) && (
          <label>
            mediaUrl (HTTPS)
            <input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} required />
          </label>
        )}

        {kind === 'document' && (
          <label>
            fileName
            <input value={fileName} onChange={(e) => setFileName(e.target.value)} />
          </label>
        )}

        {kind === 'location' && (
          <div className="grid-2">
            <label>
              latitude
              <input value={lat} onChange={(e) => setLat(e.target.value)} />
            </label>
            <label>
              longitude
              <input value={lng} onChange={(e) => setLng(e.target.value)} />
            </label>
          </div>
        )}

        {kind === 'poll' && (
          <>
            <label>
              Pergunta
              <input value={pollName} onChange={(e) => setPollName(e.target.value)} />
            </label>
            <label>
              Opções (vírgula)
              <input value={pollOpts} onChange={(e) => setPollOpts(e.target.value)} />
            </label>
          </>
        )}

        {kind === 'contact' && (
          <>
            <label>
              Nome
              <input value={contactName} onChange={(e) => setContactName(e.target.value)} required />
            </label>
            <label>
              Telefone
              <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} required />
            </label>
          </>
        )}

        {kind === 'react' && (
          <>
            <label>
              messageId
              <input value={msgId} onChange={(e) => setMsgId(e.target.value)} required />
            </label>
            <label>
              emoji
              <input value={emoji} onChange={(e) => setEmoji(e.target.value)} />
            </label>
          </>
        )}

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Enviando…' : `Enviar ${kind}`}
        </button>
      </form>
    </Shell>
  )
}
