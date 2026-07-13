import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebhookOutbox } from '~/webhooks/outbox'
import type { WebhookConfigRecord, WebhookPayloadEnvelope } from '~/webhooks/types'
import { makeEnv } from '../helpers/fixtures'

// These tests exercise delivery/retry/HMAC logic, not the SSRF guard. `assertPublicUrl` does a
// real DNS lookup and would reject the `.example` placeholder hosts (ENOTFOUND), so stub it to a
// pass-through; the guard itself is covered by crypto/ssrf-focused suites.
vi.mock('~/lib/ssrf-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/ssrf-guard')>()
  return { ...actual, assertPublicUrl: vi.fn(async (raw: string) => new URL(raw)) }
})

type OutboxRow = {
  id: string
  instance_name: string
  webhook_id: string | null
  event: string
  event_id: string
  payload: unknown
  url: string
  hmac_key: string | null
  custom_headers: { name: string; value: string }[]
  attempts: number
  max_attempts: number
  next_attempt_at: Date
  last_error: string | null
  status: string
}

class OutboxPool {
  rows = new Map<string, OutboxRow>()
  queries: { sql: string; params?: unknown[] }[] = []

  async query(sql: string, params?: unknown[]) {
    this.queries.push({ sql, params })
    const s = sql.replace(/\s+/g, ' ')

    if (s.includes('INSERT INTO webhook_outbox')) {
      const row: OutboxRow = {
        id: String(params?.[0]),
        instance_name: String(params?.[1]),
        webhook_id: (params?.[2] as string | null) ?? null,
        event: String(params?.[3]),
        event_id: String(params?.[4]),
        payload: JSON.parse(String(params?.[5])),
        url: String(params?.[6]),
        hmac_key: (params?.[7] as string | null) ?? null,
        custom_headers: JSON.parse(String(params?.[8] ?? '[]')),
        attempts: 0,
        max_attempts: Number(params?.[9] ?? 5),
        next_attempt_at: new Date(0),
        last_error: null,
        status: 'pending',
      }
      this.rows.set(row.id, row)
      return { rows: [], rowCount: 1 }
    }

    // claim(): atomically move due 'pending' rows to 'sending' and return them (RETURNING *).
    // Must be matched before the generic `next_attempt_at` branch — the claim SQL also mentions
    // next_attempt_at in its WHERE/ORDER BY.
    if (s.includes("SET status = 'sending'")) {
      const claimed = [...this.rows.values()].filter(
        (r) => r.status === 'pending' && r.next_attempt_at.getTime() <= Date.now(),
      )
      for (const row of claimed) row.status = 'sending'
      return { rows: claimed, rowCount: claimed.length }
    }

    if (s.includes("status = 'delivered'")) {
      const row = this.rows.get(String(params?.[0]))
      if (row) {
        row.status = 'delivered'
        row.attempts = Number(params?.[1])
        row.last_error = null
      }
      return { rows: [], rowCount: 1 }
    }

    if (s.includes("status = 'failed'")) {
      const row = this.rows.get(String(params?.[0]))
      if (row) {
        row.status = 'failed'
        row.attempts = Number(params?.[1])
        row.last_error = String(params?.[2])
      }
      return { rows: [], rowCount: 1 }
    }

    // failOrRetry(): row goes back to 'pending' (from the claimed 'sending') with a future retry time.
    if (s.includes('next_attempt_at')) {
      const row = this.rows.get(String(params?.[0]))
      if (row) {
        row.status = 'pending'
        row.attempts = Number(params?.[1])
        row.last_error = String(params?.[2])
        row.next_attempt_at = new Date(Date.now() + Number(params?.[3] ?? 0))
      }
      return { rows: [], rowCount: 1 }
    }

    return { rows: [], rowCount: 0 }
  }
}

const envelope = (event = 'message'): WebhookPayloadEnvelope => ({
  id: '01EVENTID',
  event,
  instance: 'sales-1',
  timestamp: Date.now(),
  engine: 'zapo',
  payload: { hello: 'world', n: 1 },
})

const webhook = (overrides: Partial<WebhookConfigRecord> = {}): WebhookConfigRecord => ({
  id: 'wh1',
  instanceName: 'sales-1',
  url: 'https://hooks.example/zapo',
  events: ['message'],
  hmacKey: 'super-secret-hmac-key',
  retriesPolicy: 'exponential',
  retriesDelaySeconds: 2,
  retriesAttempts: 3,
  customHeaders: [{ name: 'X-Source', value: 'zapo-rest' }],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

describe('WebhookOutbox', () => {
  let pool: OutboxPool
  let outbox: WebhookOutbox
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    pool = new OutboxPool()
    outbox = new WebhookOutbox(pool as never, makeEnv({ WEBHOOK_TIMEOUT_MS: 500, WEBHOOK_DEFAULT_ATTEMPTS: 3 }))
    fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    outbox.stop()
    vi.unstubAllGlobals()
  })

  it('enqueue persists pending row with envelope and hmac key', async () => {
    await outbox.enqueue('sales-1', webhook(), envelope())
    expect(pool.rows.size).toBe(1)
    const row = [...pool.rows.values()][0]
    expect(row).toBeDefined()
    expect(row?.url).toBe('https://hooks.example/zapo')
    expect(row?.hmac_key).toBe('super-secret-hmac-key')
    expect(row?.event).toBe('message')
    expect(row?.payload).toMatchObject({ engine: 'zapo', event: 'message' })
  })

  it('enqueue no-ops without url', async () => {
    await outbox.enqueue('sales-1', null, envelope())
    expect(pool.rows.size).toBe(0)
  })

  it('deliver signs body with HMAC-SHA512 and custom headers', async () => {
    await outbox.enqueue('sales-1', webhook(), envelope())
    await outbox.drain()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    expect(call).toBeDefined()
    const [url, init] = call ?? []
    expect(url).toBe('https://hooks.example/zapo')
    const headers = (init as { headers?: Record<string, string> } | undefined)?.headers ?? {}
    const body = String((init as { body?: string } | undefined)?.body ?? '')
    const expected = createHmac('sha512', 'super-secret-hmac-key').update(body).digest('hex')
    expect(headers['x-webhook-hmac']).toBe(expected)
    expect(headers['x-webhook-hmac-sha512']).toBe(expected)
    expect(headers['x-source']).toBe('zapo-rest')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-webhook-event']).toBe('message')
    expect(JSON.parse(body)).toMatchObject({ engine: 'zapo', payload: { hello: 'world' } })

    const row = [...pool.rows.values()][0]
    expect(row?.status).toBe('delivered')
    expect(row?.attempts).toBe(1)
  })

  it('retries on HTTP error with exponential delay', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    await outbox.enqueue('sales-1', webhook({ retriesAttempts: 3 }), envelope())
    await outbox.drain()

    const row = [...pool.rows.values()][0]
    expect(row?.status).toBe('pending')
    expect(row?.attempts).toBe(1)
    expect(row?.last_error).toContain('HTTP 500')
    expect(row?.next_attempt_at.getTime()).toBeGreaterThan(Date.now() - 1000)
  })

  it('marks failed after max attempts', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }))
    await outbox.enqueue('sales-1', webhook({ retriesAttempts: 2 }), envelope())
    const id = [...pool.rows.keys()][0]
    expect(id).toBeDefined()
    const pending = id ? pool.rows.get(id) : undefined
    expect(pending).toBeDefined()
    if (pending) pending.attempts = 1 // next deliver is attempt 2 = max

    await outbox.drain()
    expect(id ? pool.rows.get(id)?.status : undefined).toBe('failed')
  })

  it('retries on network error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    await outbox.enqueue('sales-1', webhook({ retriesAttempts: 5 }), envelope())
    await outbox.drain()
    const row = [...pool.rows.values()][0]
    expect(row?.status).toBe('pending')
    expect(row?.last_error).toContain('ECONNRESET')
  })

  it('start/stop is idempotent', () => {
    outbox.start()
    outbox.start()
    outbox.stop()
    outbox.stop()
  })

  it('legacy enqueue via opts url without webhook record', async () => {
    await outbox.enqueue('sales-1', null, envelope('instance.connection'), {
      url: 'https://legacy.example/hook',
      hmacKey: null,
      maxAttempts: 2,
    })
    await outbox.drain()
    expect(fetchMock).toHaveBeenCalledWith('https://legacy.example/hook', expect.objectContaining({ method: 'POST' }))
    const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>
    expect(headers['x-webhook-hmac']).toBeUndefined()
  })
})
