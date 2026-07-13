import { createHmac } from 'node:crypto'
import type pg from 'pg'
import { ulid } from 'ulid'
import type { Env } from '~/config/env'
import { getLogger } from '~/lib/logger'
import { assertPublicUrl } from '~/lib/ssrf-guard'
import type { RetryPolicy, WebhookConfigRecord, WebhookCustomHeader, WebhookPayloadEnvelope } from './types'

type OutboxRow = {
  id: string
  instance_name: string
  webhook_id: string | null
  event: string
  event_id: string
  payload: unknown
  url: string
  hmac_key: string | null
  custom_headers: WebhookCustomHeader[] | unknown
  attempts: number
  max_attempts: number
  next_attempt_at: Date
  last_error: string | null
  status: string
}

type OutboxEnv = Pick<
  Env,
  'WEBHOOK_TIMEOUT_MS' | 'WEBHOOK_WORKER_INTERVAL_MS' | 'WEBHOOK_DEFAULT_ATTEMPTS' | 'NODE_ENV'
>

/** Max deliveries in flight at once so one slow endpoint can't stall the batch. */
const DELIVERY_CONCURRENCY = 8
/** How often to requeue orphaned in-flight rows and purge terminal rows. */
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000

function nextDelayMs(policy: RetryPolicy, delaySeconds: number, attempt: number): number {
  const base = Math.max(1, delaySeconds) * 1000
  if (policy === 'constant') return base
  if (policy === 'linear') return base * attempt
  // exponential
  return base * 2 ** Math.max(0, attempt - 1)
}

/**
 * Transactional-outbox worker for webhook delivery. The dispatcher enqueues rows;
 * each drain atomically claims a batch (status 'pending' → 'sending'), delivers
 * with bounded concurrency, then marks each row 'delivered', retried (back to
 * 'pending'), or 'failed'. A reentrancy guard prevents overlapping drains and a
 * low-frequency maintenance pass requeues orphaned 'sending' rows and purges old
 * terminal rows.
 *
 * @example
 *   const outbox = new WebhookOutbox(pool, env)
 *   outbox.start() // begins draining on an interval
 *   await outbox.enqueue(instance.name, webhook, envelope)
 */
export class WebhookOutbox {
  private timer: ReturnType<typeof setInterval> | null = null
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null
  private draining = false
  private readonly allowHttp: boolean
  private readonly log = getLogger({ component: 'webhook-outbox' })

  constructor(
    private readonly pool: pg.Pool,
    private readonly env: OutboxEnv,
  ) {
    this.allowHttp = env.NODE_ENV !== 'production'
  }

  start(): void {
    if (this.timer) return
    void this.requeueStale().catch((err) => this.log.warn({ err }, 'outbox requeue on start failed'))
    this.timer = setInterval(() => {
      void this.drain().catch((err) => this.log.warn({ err }, 'outbox drain failed'))
    }, this.env.WEBHOOK_WORKER_INTERVAL_MS)
    this.timer.unref?.()
    this.maintenanceTimer = setInterval(() => {
      void this.maintain().catch((err) => this.log.warn({ err }, 'outbox maintenance failed'))
    }, MAINTENANCE_INTERVAL_MS)
    this.maintenanceTimer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer)
      this.maintenanceTimer = null
    }
  }

  async enqueue(
    instanceName: string,
    webhook: WebhookConfigRecord | null,
    envelope: WebhookPayloadEnvelope,
    opts?: { url?: string; hmacKey?: string | null; customHeaders?: WebhookCustomHeader[]; maxAttempts?: number },
  ): Promise<void> {
    const url = opts?.url ?? webhook?.url
    if (!url) return

    await this.pool.query(
      `INSERT INTO webhook_outbox (
        id, instance_name, webhook_id, event, event_id, payload, url,
        hmac_key, custom_headers, max_attempts, status
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,'pending')`,
      [
        ulid(),
        instanceName,
        webhook?.id ?? null,
        envelope.event,
        envelope.id,
        JSON.stringify(envelope),
        url,
        opts?.hmacKey ?? webhook?.hmacKey ?? null,
        JSON.stringify(opts?.customHeaders ?? webhook?.customHeaders ?? []),
        opts?.maxAttempts ?? webhook?.retriesAttempts ?? this.env.WEBHOOK_DEFAULT_ATTEMPTS,
      ],
    )
  }

  async drain(limit = 20): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      const rows = await this.claim(limit)
      await this.deliverBatch(rows)
    } finally {
      this.draining = false
    }
  }

  /**
   * Atomically move a batch from 'pending' to 'sending' so no other drain (or
   * process) claims the same rows; the prior bare `SELECT ... FOR UPDATE SKIP
   * LOCKED` ran in autocommit and released the lock immediately, allowing double
   * delivery. SKIP LOCKED keeps concurrent workers from blocking each other.
   */
  private async claim(limit: number): Promise<OutboxRow[]> {
    const { rows } = await this.pool.query<OutboxRow>(
      `UPDATE webhook_outbox SET status = 'sending', updated_at = now()
       WHERE id IN (
         SELECT id FROM webhook_outbox
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit],
    )
    return rows
  }

  private async deliverBatch(rows: OutboxRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += DELIVERY_CONCURRENCY) {
      const chunk = rows.slice(i, i + DELIVERY_CONCURRENCY)
      await Promise.all(chunk.map((row) => this.deliver(row)))
    }
  }

  private async deliver(row: OutboxRow): Promise<void> {
    const attempt = row.attempts + 1
    if (!(await this.urlAllowed(row, attempt))) return

    const body = JSON.stringify(row.payload)
    const headers = this.buildHeaders(row, attempt, body)
    try {
      const res = await this.post(row.url, headers, body)
      if (res.ok) {
        await this.markDelivered(row, attempt)
        return
      }
      await this.failOrRetry(row, attempt, `HTTP ${res.status}`)
    } catch (err) {
      await this.failOrRetry(row, attempt, err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Re-validate the destination before every send: the config may predate the
   * SSRF guard, or DNS may now resolve to a private/loopback address. A blocked
   * URL is a permanent failure (it won't become public on retry), not a retry.
   */
  private async urlAllowed(row: OutboxRow, attempt: number): Promise<boolean> {
    try {
      await assertPublicUrl(row.url, { allowHttp: this.allowHttp })
      return true
    } catch (err) {
      await this.markFailed(row, attempt, `blocked url: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  private buildHeaders(row: OutboxRow, attempt: number, body: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-webhook-event': row.event,
      'x-webhook-id': row.event_id,
      'x-webhook-attempt': String(attempt),
    }
    const custom = Array.isArray(row.custom_headers) ? (row.custom_headers as WebhookCustomHeader[]) : []
    for (const h of custom) {
      if (h?.name) headers[h.name.toLowerCase()] = h.value
    }
    if (row.hmac_key) {
      const sig = createHmac('sha512', row.hmac_key).update(body).digest('hex')
      headers['x-webhook-hmac'] = sig
      headers['x-webhook-hmac-sha512'] = sig
    }
    return headers
  }

  private async post(url: string, headers: Record<string, string>, body: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.env.WEBHOOK_TIMEOUT_MS)
    try {
      // redirect: 'error' — a 3xx could point the vetted request at an internal host.
      return await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  private async markDelivered(row: OutboxRow, attempt: number): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_outbox SET status = 'delivered', attempts = $2, updated_at = now(), last_error = NULL
       WHERE id = $1`,
      [row.id, attempt],
    )
  }

  private async markFailed(row: OutboxRow, attempt: number, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_outbox SET status = 'failed', attempts = $2, last_error = $3, updated_at = now()
       WHERE id = $1`,
      [row.id, attempt, error.slice(0, 500)],
    )
    this.log.warn({ id: row.id, event: row.event, error }, 'webhook permanently failed')
  }

  private async failOrRetry(row: OutboxRow, attempt: number, error: string): Promise<void> {
    if (attempt >= row.max_attempts) {
      await this.markFailed(row, attempt, error)
      return
    }

    // Back to 'pending' so the next drain can re-claim it (claim only sees 'pending').
    const delay = nextDelayMs('exponential', 2, attempt)
    await this.pool.query(
      `UPDATE webhook_outbox SET
        status = 'pending',
        attempts = $2,
        last_error = $3,
        next_attempt_at = now() + ($4 || ' milliseconds')::interval,
        updated_at = now()
       WHERE id = $1`,
      [row.id, attempt, error.slice(0, 500), delay],
    )
  }

  private async maintain(): Promise<void> {
    await this.requeueStale()
    const { rowCount } = await this.pool.query(
      `DELETE FROM webhook_outbox
       WHERE status IN ('delivered','failed') AND updated_at < now() - interval '7 days'`,
    )
    if (rowCount) this.log.debug({ removed: rowCount }, 'outbox purged terminal rows')
  }

  /** Return rows stuck in 'sending' (a worker died mid-delivery) to 'pending'. */
  private async requeueStale(): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE webhook_outbox SET status = 'pending', updated_at = now()
       WHERE status = 'sending' AND updated_at < now() - interval '2 minutes'`,
    )
    if (rowCount) this.log.info({ requeued: rowCount }, 'outbox requeued orphaned in-flight rows')
  }
}
