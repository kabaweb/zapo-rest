import { describe, expect, it } from 'vitest'
import { webhookMatchesEvent } from '~/webhooks/repo'
import { toPublicWebhook } from '~/webhooks/types'

describe('webhookMatchesEvent', () => {
  it('empty events = all', () => {
    expect(webhookMatchesEvent([], 'call.incoming')).toBe(true)
    expect(webhookMatchesEvent([], 'message')).toBe(true)
  })

  it('star matches all', () => {
    expect(webhookMatchesEvent(['*'], 'presence.update')).toBe(true)
  })

  it('exact event name', () => {
    expect(webhookMatchesEvent(['message.ack'], 'message.ack')).toBe(true)
    expect(webhookMatchesEvent(['message.ack'], 'message')).toBe(false)
  })

  it('message.any only matches message* events', () => {
    expect(webhookMatchesEvent(['message.any'], 'message')).toBe(true)
    expect(webhookMatchesEvent(['message.any'], 'message.inbound')).toBe(true)
    expect(webhookMatchesEvent(['message.any'], 'message.ack')).toBe(true)
    expect(webhookMatchesEvent(['message.any'], 'message.media.stored')).toBe(true)
    expect(webhookMatchesEvent(['message.any'], 'message.media.failed')).toBe(true)
    expect(webhookMatchesEvent(['message.any'], 'call.incoming')).toBe(false)
    expect(webhookMatchesEvent(['message.any'], 'presence.update')).toBe(false)
    expect(webhookMatchesEvent(['message.any'], 'history.sync')).toBe(false)
  })

  it('message.any + other names', () => {
    expect(webhookMatchesEvent(['message.any', 'call.incoming'], 'call.incoming')).toBe(true)
    expect(webhookMatchesEvent(['message.any', 'call.incoming'], 'message.edited')).toBe(true)
  })
})

describe('toPublicWebhook', () => {
  it('never re-echoes hmac key', () => {
    const pub = toPublicWebhook({
      id: 'wh_1',
      instanceName: 'sales-1',
      url: 'https://hooks.example/a',
      events: ['message'],
      hmacKey: 'super-secret',
      retriesPolicy: 'exponential',
      retriesDelaySeconds: 2,
      retriesAttempts: 5,
      customHeaders: [],
      enabled: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(pub.hmac).toEqual({ configured: true })
    expect(JSON.stringify(pub)).not.toContain('super-secret')
  })

  it('null hmac when not configured', () => {
    const pub = toPublicWebhook({
      id: 'wh_2',
      instanceName: 'sales-1',
      url: 'https://hooks.example/b',
      events: [],
      hmacKey: null,
      retriesPolicy: 'linear',
      retriesDelaySeconds: 1,
      retriesAttempts: 3,
      customHeaders: [],
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    expect(pub.hmac).toBeNull()
  })
})
