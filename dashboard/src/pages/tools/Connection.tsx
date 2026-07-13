import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  connectInstance,
  disconnectInstance,
  getInstance,
  getQr,
  type Instance,
  requestPairing,
  restartInstance,
  rotateKey,
} from '../../api/client'
import { ErrorBox, Shell, StatusBadge } from '../../components/Shell'

type Props = { onLogout: () => void }

export function ConnectionPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [instance, setInstance] = useState<Instance | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pairPhone, setPairPhone] = useState('')
  const [pairCode, setPairCode] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const { instance: row } = await getInstance(name)
      setInstance(row)
      const q = await getQr(name)
      setQr(q.qr)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    }
  }, [name])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 2500)
    return () => clearInterval(t)
  }, [refresh])

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell
      title="Conexão"
      subtitle="QR, pairing, restart e credenciais da instância."
      instanceName={name}
      instanceStatus={instance?.status}
      onLogout={onLogout}
      actions={
        <Link to={`/instances/${name}`} className="btn ghost">
          ← Hub
        </Link>
      }
    >
      <ErrorBox error={error} />

      <div className="grid-2">
        <section className="panel stack">
          <h2>Ações</h2>
          {instance && <StatusBadge status={instance.status} />}
          <div className="btn-row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void run(() => connectInstance(name))}
            >
              Conectar
            </button>
            <button type="button" disabled={busy} onClick={() => void run(() => disconnectInstance(name))}>
              Desconectar
            </button>
            <button type="button" disabled={busy} onClick={() => void run(() => restartInstance(name))}>
              Restart
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                if (!confirm('Rotacionar API key? A key antiga para de funcionar.')) return
                void run(() => rotateKey(name))
              }}
            >
              Rotacionar key
            </button>
          </div>

          <h3>Pairing code</h3>
          <div className="input-row">
            <input value={pairPhone} onChange={(e) => setPairPhone(e.target.value)} placeholder="5511999999999" />
            <button
              type="button"
              className="primary"
              disabled={busy || !pairPhone}
              onClick={() =>
                void run(async () => {
                  await connectInstance(name).catch(() => undefined)
                  const res = await requestPairing(name, pairPhone)
                  setPairCode(res.code)
                })
              }
            >
              Gerar
            </button>
          </div>
          {pairCode && (
            <div className="pair-code">
              Código: <strong className="mono">{pairCode}</strong>
            </div>
          )}

          <h3>Credenciais</h3>
          <dl className="kv">
            <div>
              <dt>API Key</dt>
              <dd className="mono">{instance?.apiKey ?? '—'}</dd>
            </div>
            <div>
              <dt>meJid</dt>
              <dd className="mono">{instance?.meJid ?? '—'}</dd>
            </div>
            <div>
              <dt>Webhook legado</dt>
              <dd className="mono">{instance?.webhookUrl ?? '—'}</dd>
            </div>
          </dl>
        </section>

        <section className="panel stack center">
          <h2>QR Code</h2>
          {qr ? (
            <div className="qr-box">
              <QRCodeSVG value={qr} size={240} level="M" includeMargin />
            </div>
          ) : (
            <p className="muted">
              {instance?.status === 'open'
                ? 'Instância já conectada — QR não necessário.'
                : 'Clique em Conectar e aguarde o QR…'}
            </p>
          )}
          <p className="muted tiny">WhatsApp → Aparelhos conectados → Conectar um aparelho</p>
        </section>
      </div>
    </Shell>
  )
}
