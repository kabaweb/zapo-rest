import { useState } from 'react'

type Props = {
  onLogin: (apiKey: string) => Promise<void>
}

export function LoginPage({ onLogin }: Props) {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [show, setShow] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onLogin(key.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no login')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <div className="brand brand-lg">
          <span className="brand-mark">z</span>
          <span>
            zapo<span className="brand-accent">rest</span>
          </span>
        </div>
        <h1>Manager</h1>
        <p className="muted">Entre com a API key de administrador ou de uma instância.</p>

        <label>
          Token de acesso
          <div className="input-row">
            <input
              type={show ? 'text' : 'password'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="ADMIN_API_KEY ou zr_…"
              required
            />
            <button type="button" className="ghost" onClick={() => setShow((s) => !s)}>
              {show ? 'Ocultar' : 'Mostrar'}
            </button>
          </div>
        </label>

        {error && <div className="alert error">{error}</div>}

        <button type="submit" className="primary block" disabled={busy || !key.trim()}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>

        <p className="muted tiny">Admin gerencia todas as instâncias. Key de instância abre só aquela sessão.</p>
      </form>
    </div>
  )
}
