import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { statusLabel } from '../api/client'

type Props = {
  title?: string
  subtitle?: string
  instanceName?: string
  instanceStatus?: string
  onLogout: () => void
  children: ReactNode
  actions?: ReactNode
  wide?: boolean
}

export function Shell({ title, subtitle, instanceName, instanceStatus, onLogout, children, actions, wide }: Props) {
  return (
    <div className={`app ${wide ? 'app-wide' : ''}`}>
      <header className="topnav">
        <div className="topnav-left">
          <Link to="/instances" className="brand">
            <span className="brand-mark">z</span>
            <span>
              zapo<span className="brand-accent">rest</span>
            </span>
            <span className="brand-ver">dashboard</span>
          </Link>
        </div>
        <div className="topnav-right">
          {instanceName && (
            <div className="chip-group">
              <span className="chip mono">{instanceName}</span>
              {instanceStatus && (
                <span className={`chip status-${instanceStatus}`}>
                  <span className="dot" />
                  {statusLabel(instanceStatus)}
                </span>
              )}
            </div>
          )}
          <button type="button" className="icon-btn" onClick={onLogout} title="Sair">
            Sair
          </button>
        </div>
      </header>

      {(title || actions) && (
        <div className="page-head">
          <div>
            {title && <h1>{title}</h1>}
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {actions && <div className="page-actions">{actions}</div>}
        </div>
      )}

      <main className="page-body">{children}</main>
    </div>
  )
}

export function ModuleCard({
  title,
  description,
  badge,
  to,
  onClick,
  icon,
}: {
  title: string
  description: string
  badge?: string
  to?: string
  onClick?: () => void
  icon: string
}) {
  const inner = (
    <>
      {badge && <span className="mod-badge">{badge}</span>}
      <div className="mod-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </>
  )
  if (to) {
    return (
      <Link to={to} className="mod-card">
        {inner}
      </Link>
    )
  }
  return (
    <button type="button" className="mod-card" onClick={onClick}>
      {inner}
    </button>
  )
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="dot" />
      {statusLabel(status)}
    </span>
  )
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="alert error">{error}</div>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}
