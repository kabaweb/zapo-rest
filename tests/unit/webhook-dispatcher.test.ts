import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { realtimeBus } from '~/events/bus'
import { sanitizeForWebhook, WebhookDispatcher } from '~/webhooks/dispatcher'
import { makeEnv, makeInstance } from '../helpers/fixtures'

// The fireDirect path SSRF-validates the URL via a real DNS lookup, which rejects the `.example`
// placeholder host (ENOTFOUND). Stub the guard to a pass-through so the direct-delivery test can
// assert the fetch itself; SSRF classification is validated in its own suite.
vi.mock('~/lib/ssrf-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/ssrf-guard')>()
  return { ...actual, assertPublicUrl: vi.fn(async (raw: string) => new URL(raw)) }
})

describe('WebhookDispatcher.emit', () => {
  let outbox: { enqueue: ReturnType<typeof vi.fn> }
  let webhookRepo: { matching: ReturnType<typeof vi.fn> }
  let dispatcher: WebhookDispatcher

  beforeEach(() => {
    outbox = { enqueue: vi.fn(async () => undefined) }
    webhookRepo = {
      matching: vi.fn(async () => [
        {
          id: 'wh1',
          instanceName: 'sales-1',
          url: 'https://hooks.example',
          events: ['message'],
          hmacKey: 'k',
          retriesPolicy: 'exponential',
          retriesDelaySeconds: 2,
          retriesAttempts: 5,
          customHeaders: [],
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    }
    dispatcher = new WebhookDispatcher({
      env: makeEnv(),
      // @ts-expect-error mock
      webhookRepo,
      // @ts-expect-error mock
      outbox,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('publishes to realtime bus with stable envelope fields', async () => {
    const seen: unknown[] = []
    const unsub = realtimeBus.onInstance('sales-1', (p) => seen.push(p))

    await dispatcher.emit(makeInstance({ name: 'sales-1' }), 'message', {
      id: 'M1',
      body: 'hi',
      rawNode: { skip: true },
      blob: Buffer.from('xx'),
    })

    expect(seen).toHaveLength(1)
    const evt = seen[0] as { event: string; eventId: string; data: Record<string, unknown> }
    expect(evt.event).toBe('message')
    expect(evt.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i)
    expect(evt.data.body).toBe('hi')
    expect(evt.data.rawNode).toBeUndefined()
    expect(evt.data.blob).toEqual({ _type: 'binary', length: 2 })
    unsub()
  })

  it('enqueues matching multi-config webhooks with engine envelope', async () => {
    await dispatcher.emit(makeInstance(), 'message', { id: '1' })
    expect(webhookRepo.matching).toHaveBeenCalledWith('sales-1', 'message')
    expect(outbox.enqueue).toHaveBeenCalledWith(
      'sales-1',
      expect.objectContaining({ id: 'wh1' }),
      expect.objectContaining({
        engine: 'zapo',
        event: 'message',
        instance: 'sales-1',
        payload: { id: '1' },
      }),
    )
  })

  it('legacy instance.webhookUrl enqueues when event allowed', async () => {
    webhookRepo.matching.mockResolvedValue([])
    await dispatcher.emit(
      makeInstance({
        webhookUrl: 'https://legacy.example/hook',
        webhookEvents: ['message.inbound'],
      }),
      'message.inbound',
      { id: 'L1' },
    )
    expect(outbox.enqueue).toHaveBeenCalledWith(
      'sales-1',
      null,
      expect.objectContaining({ event: 'message.inbound' }),
      expect.objectContaining({ url: 'https://legacy.example/hook' }),
    )
  })

  it('legacy webhook skips events not in allow-list', async () => {
    webhookRepo.matching.mockResolvedValue([])
    await dispatcher.emit(
      makeInstance({
        webhookUrl: 'https://legacy.example/hook',
        webhookEvents: ['call.incoming'],
      }),
      'message',
      { id: 'L2' },
    )
    expect(outbox.enqueue).not.toHaveBeenCalled()
  })

  it('fireDirect path when no outbox (backward compat)', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const d = new WebhookDispatcher(makeEnv({ WEBHOOK_TIMEOUT_MS: 500 }))
    await d.emit(makeInstance({ webhookUrl: 'https://direct.example', webhookEvents: [] }), 'instance.connection', {
      status: 'open',
    })
    expect(fetchMock).toHaveBeenCalledWith('https://direct.example', expect.objectContaining({ method: 'POST' }))
    vi.unstubAllGlobals()
  })
})

describe('sanitizeForWebhook extended', () => {
  it('recurses arrays and drops messageBytes', () => {
    const out = sanitizeForWebhook({
      items: [{ messageBytes: new Uint8Array([1, 2]), ok: true }],
      messageBytes: new Uint8Array([9]),
    }) as { items: unknown[]; messageBytes?: unknown }
    expect(out.messageBytes).toBeUndefined()
    expect(out.items[0]).toEqual({ ok: true })
  })
})
