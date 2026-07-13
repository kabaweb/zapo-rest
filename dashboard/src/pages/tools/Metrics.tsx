import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  getInstanceMetrics,
  getInstanceMetricsResources,
  getInstanceMetricsTimeseries,
  type MetricsResources,
  type MetricsSummary,
  type MetricsTimeseries,
} from '../../api/client'
import { ErrorBox, Shell } from '../../components/Shell'

type Props = { onLogout: () => void }
type RangeKey = '24h' | '7d' | '30d' | '90d'

function rangeFromKey(key: RangeKey): { from: string; to: string; bucket: 'hour' | 'day' } {
  const to = new Date()
  const from = new Date(to)
  if (key === '24h') {
    from.setTime(to.getTime() - 24 * 60 * 60 * 1000)
    return { from: from.toISOString(), to: to.toISOString(), bucket: 'hour' }
  }
  if (key === '7d') from.setDate(from.getDate() - 7)
  else if (key === '30d') from.setDate(from.getDate() - 30)
  else from.setDate(from.getDate() - 90)
  return { from: from.toISOString(), to: to.toISOString(), bucket: key === '7d' ? 'day' : 'day' }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function fmtDuration(secs: number | null): string {
  if (secs == null) return '—'
  if (secs < 60) return `${Math.round(secs)}s`
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  return `${m}m ${s}s`
}

/** Simple multi-series SVG line/area chart */
function LineChart({
  series,
  height = 160,
}: {
  series: { key: string; color: string; points: { t: string; v: number }[] }[]
  height?: number
}) {
  const width = 640
  const pad = { t: 12, r: 12, b: 28, l: 36 }
  const all = series.flatMap((s) => s.points)
  if (!all.length) {
    return <p className="muted">Sem dados no período</p>
  }
  const times = [...new Set(all.map((p) => p.t))].sort()
  const maxV = Math.max(1, ...all.map((p) => p.v))
  const iw = width - pad.l - pad.r
  const ih = height - pad.t - pad.b

  const xOf = (t: string) => {
    const i = times.indexOf(t)
    return pad.l + (times.length <= 1 ? iw / 2 : (i / (times.length - 1)) * iw)
  }
  const yOf = (v: number) => pad.t + ih - (v / maxV) * ih

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="metrics-chart" role="img" aria-label="Metrics chart">
      {[0, 0.5, 1].map((f) => {
        const y = pad.t + ih * (1 - f)
        const label = Math.round(maxV * f)
        return (
          <g key={f}>
            <line x1={pad.l} x2={width - pad.r} y1={y} y2={y} className="metrics-grid" />
            <text x={pad.l - 6} y={y + 4} textAnchor="end" className="metrics-axis">
              {label}
            </text>
          </g>
        )
      })}
      {series.map((s) => {
        if (!s.points.length) return null
        const d = s.points
          .slice()
          .sort((a, b) => a.t.localeCompare(b.t))
          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(p.t).toFixed(1)} ${yOf(p.v).toFixed(1)}`)
          .join(' ')
        return <path key={s.key} d={d} fill="none" stroke={s.color} strokeWidth={2} />
      })}
      {/* x labels: first / mid / last */}
      {[0, Math.floor(times.length / 2), times.length - 1]
        .filter((i, idx, arr) => i >= 0 && arr.indexOf(i) === idx)
        .flatMap((i) => {
          const t = times[i]
          if (t == null) return []
          const d = new Date(t)
          const label =
            times.length > 48
              ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
              : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' })
          return [
            <text key={t} x={xOf(t)} y={height - 8} textAnchor="middle" className="metrics-axis">
              {label}
            </text>,
          ]
        })}
    </svg>
  )
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="metrics-stat">
      <div className="metrics-stat-label">{label}</div>
      <div className="metrics-stat-value">{value}</div>
      {sub ? <div className="metrics-stat-sub">{sub}</div> : null}
    </div>
  )
}

export function MetricsPage({ onLogout }: Props) {
  const { name = '' } = useParams()
  const [range, setRange] = useState<RangeKey>('7d')
  const [summary, setSummary] = useState<MetricsSummary | null>(null)
  const [series, setSeries] = useState<MetricsTimeseries | null>(null)
  const [resources, setResources] = useState<MetricsResources | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!name) return
    setLoading(true)
    try {
      const r = rangeFromKey(range)
      const [s, ts, res] = await Promise.all([
        getInstanceMetrics(name, { from: r.from, to: r.to }),
        getInstanceMetricsTimeseries(name, { from: r.from, to: r.to, bucket: r.bucket }),
        getInstanceMetricsResources(name),
      ])
      setSummary(s)
      setSeries(ts)
      setResources(res)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar métricas')
    } finally {
      setLoading(false)
    }
  }, [name, range])

  useEffect(() => {
    void load()
  }, [load])

  // Live resources poll
  useEffect(() => {
    if (!name) return
    const t = setInterval(() => {
      void getInstanceMetricsResources(name)
        .then(setResources)
        .catch(() => undefined)
    }, 5000)
    return () => clearInterval(t)
  }, [name])

  const msgSeries = useMemo(() => {
    if (!series) return []
    return [
      {
        key: 'sent',
        color: '#22c55e',
        points: series.messages.map((p) => ({ t: p.t, v: p.sent })),
      },
      {
        key: 'received',
        color: '#5bb8ff',
        points: series.messages.map((p) => ({ t: p.t, v: p.received })),
      },
    ]
  }, [series])

  const callSeries = useMemo(() => {
    if (!series) return []
    return [
      {
        key: 'outbound',
        color: '#e6b450',
        points: series.calls.map((p) => ({ t: p.t, v: p.outbound })),
      },
      {
        key: 'inbound',
        color: '#a78bfa',
        points: series.calls.map((p) => ({ t: p.t, v: p.inbound })),
      },
      {
        key: 'answered',
        color: '#22c55e',
        points: series.calls.map((p) => ({ t: p.t, v: p.answered })),
      },
    ]
  }, [series])

  const mediaByCat = useMemo(() => {
    if (!summary) return [] as { cat: string; count: number; bytes: number }[]
    const map = new Map<string, { count: number; bytes: number }>()
    for (const row of summary.media.byType) {
      const cur = map.get(row.category) ?? { count: 0, bytes: 0 }
      cur.count += row.count
      cur.bytes += row.bytes
      map.set(row.category, cur)
    }
    return [...map.entries()].map(([cat, v]) => ({ cat, ...v })).sort((a, b) => b.bytes - a.bytes)
  }, [summary])

  return (
    <Shell
      title="Métricas"
      subtitle="Mensagens, chamadas, mídia e recursos por instância"
      instanceName={name}
      onLogout={onLogout}
      actions={
        <>
          <div className="metrics-range">
            {(['24h', '7d', '30d', '90d'] as RangeKey[]).map((k) => (
              <button
                key={k}
                type="button"
                className={range === k ? 'btn small' : 'btn ghost small'}
                onClick={() => setRange(k)}
              >
                {k}
              </button>
            ))}
          </div>
          <button type="button" className="btn ghost small" onClick={() => void load()} disabled={loading}>
            Atualizar
          </button>
          <Link to={`/instances/${encodeURIComponent(name)}`} className="btn ghost">
            ← Hub
          </Link>
        </>
      }
    >
      <ErrorBox error={error} />

      {loading && !summary ? <p className="muted">Carregando métricas…</p> : null}

      {summary && (
        <>
          <section className="metrics-section">
            <h3 className="metrics-h">Mensagens</h3>
            <div className="metrics-stats">
              <Stat label="Enviadas" value={summary.messages.sent} />
              <Stat label="Recebidas" value={summary.messages.received} />
              <Stat label="Total" value={summary.messages.total} />
              <Stat label="Com mídia" value={summary.messages.withMedia} />
            </div>
            <div className="metrics-legend">
              <span>
                <i style={{ background: '#22c55e' }} /> enviadas
              </span>
              <span>
                <i style={{ background: '#5bb8ff' }} /> recebidas
              </span>
              <span className="muted">bucket: {series?.bucket ?? '—'}</span>
            </div>
            <div className="panel metrics-panel">
              <LineChart series={msgSeries} />
            </div>
          </section>

          <section className="metrics-section">
            <h3 className="metrics-h">Chamadas (VoIP)</h3>
            <div className="metrics-stats">
              <Stat label="Efetuadas" value={summary.calls.outbound} />
              <Stat
                label="Efetuadas atendidas"
                value={summary.calls.outboundAnswered}
                sub={`${summary.calls.outboundMissedOrRejected} sem atendimento`}
              />
              <Stat label="Recebidas" value={summary.calls.inbound} />
              <Stat
                label="Recebidas atendidas"
                value={summary.calls.inboundAnswered}
                sub={`${summary.calls.inboundMissedOrRejected} recusadas/perdidas`}
              />
              <Stat label="Duração média" value={fmtDuration(summary.calls.avgDurationSecs)} />
              <Stat label="Tempo total em chamada" value={fmtDuration(summary.calls.totalDurationSecs)} />
              <Stat
                label="Gravações"
                value={summary.calls.recordingsReady}
                sub={fmtBytes(summary.calls.recordingBytes)}
              />
            </div>
            <div className="metrics-legend">
              <span>
                <i style={{ background: '#e6b450' }} /> outbound
              </span>
              <span>
                <i style={{ background: '#a78bfa' }} /> inbound
              </span>
              <span>
                <i style={{ background: '#22c55e' }} /> atendidas
              </span>
            </div>
            <div className="panel metrics-panel">
              <LineChart series={callSeries} />
            </div>
          </section>

          <section className="metrics-section">
            <h3 className="metrics-h">Mídia & storage</h3>
            <div className="metrics-stats">
              <Stat label="Arquivos" value={summary.media.objects} />
              <Stat label="Espaço mídia" value={fmtBytes(summary.media.bytes)} />
              <Stat label="Gravações" value={fmtBytes(summary.storage.callRecordingBytes)} />
              <Stat label="Total estimado" value={fmtBytes(summary.storage.estimatedTotalBytes)} />
              <Stat label="Msgs no DB" value={summary.storage.messagesCount} />
              <Stat label="Chats" value={summary.storage.chatsCount} />
            </div>
            {mediaByCat.length > 0 && (
              <div className="panel metrics-panel">
                <table className="metrics-table">
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th>Qtd</th>
                      <th>Espaço</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {mediaByCat.map((row) => {
                      const maxB = mediaByCat[0]?.bytes | 1
                      const pct = Math.round((row.bytes / maxB) * 100)
                      return (
                        <tr key={row.cat}>
                          <td>{row.cat}</td>
                          <td>{row.count}</td>
                          <td>{fmtBytes(row.bytes)}</td>
                          <td className="metrics-bar-cell">
                            <div className="metrics-bar">
                              <div style={{ width: `${pct}%` }} />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {resources && (
        <section className="metrics-section">
          <h3 className="metrics-h">
            Recursos em tempo real{' '}
            <span className={`live-pill ${resources.live ? 'on' : ''}`}>
              {resources.live ? '● sessão live' : '○ offline neste processo'}
            </span>
          </h3>
          <div className="metrics-stats">
            <Stat
              label="RSS processo"
              value={fmtBytes(resources.process.memory.rssBytes)}
              sub={`heap ${fmtBytes(resources.process.memory.heapUsedBytes)}`}
            />
            <Stat
              label="CPU (1 core)"
              value={
                resources.process.cpu.percentSinceLastSample != null
                  ? `${resources.process.cpu.percentSinceLastSample}%`
                  : '…'
              }
              sub="desde última amostra"
            />
            <Stat
              label="Share heap (est.)"
              value={resources.estimatedHeapShareBytes != null ? fmtBytes(resources.estimatedHeapShareBytes) : '—'}
              sub={`${resources.liveSessions} sessão(ões) live`}
            />
            <Stat
              label="Storage instância"
              value={fmtBytes(resources.storage.estimatedTotalBytes)}
              sub={resources.cache.note}
            />
            <Stat label="Uptime processo" value={`${Math.floor(resources.process.uptimeSecs / 60)} min`} />
            <Stat label="PID" value={resources.process.pid} />
          </div>
          <p className="muted tiny">
            CPU/memória são do processo Node inteiro (todas as instâncias). Share divide o heap igualmente entre sessões
            live. Storage usa media_objects + gravações.
          </p>
        </section>
      )}
    </Shell>
  )
}
