import type pg from 'pg'

export type MetricsRange = {
  from: Date
  to: Date
  bucket: 'hour' | 'day'
}

export type MessageTotals = {
  sent: number
  received: number
  total: number
  withMedia: number
}

export type MessageSeriesPoint = {
  t: string
  sent: number
  received: number
}

export type CallTotals = {
  outbound: number
  inbound: number
  total: number
  /** Calls with duration > 0 (media connected) */
  answered: number
  /** Outbound that got answered by peer */
  outboundAnswered: number
  /** Outbound not answered / rejected / missed */
  outboundMissedOrRejected: number
  /** Inbound we accepted (duration > 0) */
  inboundAnswered: number
  /** Inbound rejected or missed */
  inboundMissedOrRejected: number
  /** Avg duration of answered calls (seconds) */
  avgDurationSecs: number | null
  /** Total talk time seconds */
  totalDurationSecs: number
  recordingsReady: number
  recordingBytes: number
}

export type CallSeriesPoint = {
  t: string
  outbound: number
  inbound: number
  answered: number
  missedOrRejected: number
}

export type MediaByType = {
  mime: string
  category: string
  count: number
  bytes: number
}

export type MediaTotals = {
  objects: number
  bytes: number
  byType: MediaByType[]
}

export type StorageBreakdown = {
  mediaObjectsBytes: number
  mediaObjectsCount: number
  callRecordingBytes: number
  messagesCount: number
  chatsCount: number
  contactsCount: number
  /** Rough estimate: media + recordings (row payloads not fully measured) */
  estimatedTotalBytes: number
}

export type InstanceMetricsSummary = {
  instance: string
  range: { from: string; to: string }
  messages: MessageTotals
  calls: CallTotals
  media: MediaTotals
  storage: StorageBreakdown
  generatedAt: string
}

function categoryFromMime(mime: string | null): string {
  if (!mime) return 'unknown'
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m.includes('pdf') || m.includes('document') || m.includes('msword') || m.includes('sheet')) {
    return 'document'
  }
  if (m.includes('sticker') || m === 'image/webp') return 'sticker'
  return 'other'
}

function bucketExpr(bucket: 'hour' | 'day', col: string): string {
  // timestamp_ms is epoch ms
  if (bucket === 'hour') {
    return `date_trunc('hour', to_timestamp((${col}) / 1000.0))`
  }
  return `date_trunc('day', to_timestamp((${col}) / 1000.0))`
}

export class MetricsStore {
  constructor(private readonly pool: pg.Pool) {}

  async messageTotals(instance: string, from: Date, to: Date): Promise<MessageTotals> {
    const { rows } = await this.pool.query<{
      sent: string
      received: string
      total: string
      with_media: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE from_me) AS sent,
         COUNT(*) FILTER (WHERE NOT from_me) AS received,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE has_media) AS with_media
       FROM app_messages
       WHERE instance_name = $1
         AND timestamp_ms IS NOT NULL
         AND timestamp_ms >= $2
         AND timestamp_ms < $3`,
      [instance, from.getTime(), to.getTime()],
    )
    const r = rows[0]
    return {
      sent: Number(r?.sent ?? 0),
      received: Number(r?.received ?? 0),
      total: Number(r?.total ?? 0),
      withMedia: Number(r?.with_media ?? 0),
    }
  }

  async messageSeries(instance: string, from: Date, to: Date, bucket: 'hour' | 'day'): Promise<MessageSeriesPoint[]> {
    const be = bucketExpr(bucket, 'timestamp_ms')
    const { rows } = await this.pool.query<{ t: Date; sent: string; received: string }>(
      `SELECT
         ${be} AS t,
         COUNT(*) FILTER (WHERE from_me) AS sent,
         COUNT(*) FILTER (WHERE NOT from_me) AS received
       FROM app_messages
       WHERE instance_name = $1
         AND timestamp_ms IS NOT NULL
         AND timestamp_ms >= $2
         AND timestamp_ms < $3
       GROUP BY 1
       ORDER BY 1 ASC`,
      [instance, from.getTime(), to.getTime()],
    )
    return rows.map((r) => ({
      t: new Date(r.t).toISOString(),
      sent: Number(r.sent),
      received: Number(r.received),
    }))
  }

  async callTotals(instance: string, from: Date, to: Date): Promise<CallTotals> {
    const { rows } = await this.pool.query<{
      outbound: string
      inbound: string
      total: string
      answered: string
      outbound_answered: string
      outbound_missed: string
      inbound_answered: string
      inbound_missed: string
      avg_duration: string | null
      total_duration: string
      rec_ready: string
      rec_bytes: string
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE direction IN ('outgoing','outbound')) AS outbound,
         COUNT(*) FILTER (WHERE direction IN ('incoming','inbound')) AS inbound,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE COALESCE(duration_secs, 0) > 0) AS answered,
         COUNT(*) FILTER (
           WHERE direction IN ('outgoing','outbound') AND COALESCE(duration_secs, 0) > 0
         ) AS outbound_answered,
         COUNT(*) FILTER (
           WHERE direction IN ('outgoing','outbound') AND COALESCE(duration_secs, 0) = 0
         ) AS outbound_missed,
         COUNT(*) FILTER (
           WHERE direction IN ('incoming','inbound') AND COALESCE(duration_secs, 0) > 0
         ) AS inbound_answered,
         COUNT(*) FILTER (
           WHERE direction IN ('incoming','inbound') AND COALESCE(duration_secs, 0) = 0
         ) AS inbound_missed,
         AVG(duration_secs) FILTER (WHERE COALESCE(duration_secs, 0) > 0) AS avg_duration,
         COALESCE(SUM(duration_secs) FILTER (WHERE COALESCE(duration_secs, 0) > 0), 0) AS total_duration,
         COUNT(*) FILTER (WHERE recording_status = 'ready') AS rec_ready,
         COALESCE(SUM(recording_bytes), 0) AS rec_bytes
       FROM app_calls
       WHERE instance_name = $1
         AND started_at >= $2
         AND started_at < $3`,
      [instance, from, to],
    )
    const r = rows[0]
    return {
      outbound: Number(r?.outbound ?? 0),
      inbound: Number(r?.inbound ?? 0),
      total: Number(r?.total ?? 0),
      answered: Number(r?.answered ?? 0),
      outboundAnswered: Number(r?.outbound_answered ?? 0),
      outboundMissedOrRejected: Number(r?.outbound_missed ?? 0),
      inboundAnswered: Number(r?.inbound_answered ?? 0),
      inboundMissedOrRejected: Number(r?.inbound_missed ?? 0),
      avgDurationSecs: r?.avg_duration == null ? null : Math.round(Number(r.avg_duration) * 10) / 10,
      totalDurationSecs: Number(r?.total_duration ?? 0),
      recordingsReady: Number(r?.rec_ready ?? 0),
      recordingBytes: Number(r?.rec_bytes ?? 0),
    }
  }

  async callSeries(instance: string, from: Date, to: Date, bucket: 'hour' | 'day'): Promise<CallSeriesPoint[]> {
    const trunc = bucket === 'hour' ? "date_trunc('hour', started_at)" : "date_trunc('day', started_at)"
    const { rows } = await this.pool.query<{
      t: Date
      outbound: string
      inbound: string
      answered: string
      missed: string
    }>(
      `SELECT
         ${trunc} AS t,
         COUNT(*) FILTER (WHERE direction IN ('outgoing','outbound')) AS outbound,
         COUNT(*) FILTER (WHERE direction IN ('incoming','inbound')) AS inbound,
         COUNT(*) FILTER (WHERE COALESCE(duration_secs, 0) > 0) AS answered,
         COUNT(*) FILTER (WHERE COALESCE(duration_secs, 0) = 0) AS missed
       FROM app_calls
       WHERE instance_name = $1
         AND started_at >= $2
         AND started_at < $3
       GROUP BY 1
       ORDER BY 1 ASC`,
      [instance, from, to],
    )
    return rows.map((r) => ({
      t: new Date(r.t).toISOString(),
      outbound: Number(r.outbound),
      inbound: Number(r.inbound),
      answered: Number(r.answered),
      missedOrRejected: Number(r.missed),
    }))
  }

  async mediaTotals(instance: string, from?: Date, to?: Date): Promise<MediaTotals> {
    const params: unknown[] = [instance]
    let timeFilter = ''
    if (from && to) {
      params.push(from, to)
      timeFilter = ' AND created_at >= $2 AND created_at < $3'
    }
    const { rows } = await this.pool.query<{
      mime_type: string | null
      count: string
      bytes: string
    }>(
      `SELECT mime_type, COUNT(*)::text AS count, COALESCE(SUM(size_bytes),0)::text AS bytes
       FROM media_objects
       WHERE instance_name = $1${timeFilter}
       GROUP BY mime_type
       ORDER BY SUM(size_bytes) DESC NULLS LAST
       LIMIT 50`,
      params,
    )
    const byType: MediaByType[] = rows.map((r) => ({
      mime: r.mime_type ?? 'unknown',
      category: categoryFromMime(r.mime_type),
      count: Number(r.count),
      bytes: Number(r.bytes),
    }))
    // collapse by category for UI convenience is done client-side; totals:
    let objects = 0
    let bytes = 0
    for (const b of byType) {
      objects += b.count
      bytes += b.bytes
    }
    return { objects, bytes, byType }
  }

  async storageBreakdown(instance: string): Promise<StorageBreakdown> {
    const { rows } = await this.pool.query<{
      media_bytes: string
      media_count: string
      rec_bytes: string
      messages: string
      chats: string
      contacts: string
    }>(
      `SELECT
         (SELECT COALESCE(SUM(size_bytes),0) FROM media_objects WHERE instance_name = $1) AS media_bytes,
         (SELECT COUNT(*) FROM media_objects WHERE instance_name = $1) AS media_count,
         (SELECT COALESCE(SUM(recording_bytes),0) FROM app_calls WHERE instance_name = $1) AS rec_bytes,
         (SELECT COUNT(*) FROM app_messages WHERE instance_name = $1) AS messages,
         (SELECT COUNT(*) FROM app_chats WHERE instance_name = $1) AS chats,
         (SELECT COUNT(*) FROM app_contacts WHERE instance_name = $1) AS contacts`,
      [instance],
    )
    const r = rows[0]
    const mediaObjectsBytes = Number(r?.media_bytes ?? 0)
    const callRecordingBytes = Number(r?.rec_bytes ?? 0)
    return {
      mediaObjectsBytes,
      mediaObjectsCount: Number(r?.media_count ?? 0),
      callRecordingBytes,
      messagesCount: Number(r?.messages ?? 0),
      chatsCount: Number(r?.chats ?? 0),
      contactsCount: Number(r?.contacts ?? 0),
      estimatedTotalBytes: mediaObjectsBytes + callRecordingBytes,
    }
  }

  async summary(instance: string, from: Date, to: Date): Promise<InstanceMetricsSummary> {
    const [messages, calls, media, storage] = await Promise.all([
      this.messageTotals(instance, from, to),
      this.callTotals(instance, from, to),
      this.mediaTotals(instance, from, to),
      this.storageBreakdown(instance),
    ])
    return {
      instance,
      range: { from: from.toISOString(), to: to.toISOString() },
      messages,
      calls,
      media,
      storage,
      generatedAt: new Date().toISOString(),
    }
  }
}
