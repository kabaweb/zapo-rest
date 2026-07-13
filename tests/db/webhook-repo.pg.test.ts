import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebhookConfigRepo } from '~/webhooks/repo'
import { toPublicWebhook } from '~/webhooks/types'
import { seedInstance, tryCreateTestPool, uniqueName, wipeInstance } from '../helpers/pg'

// SKIPPED (not silently green) when Postgres is unavailable — resolved at collection time.
const pool = await tryCreateTestPool()

describe.skipIf(!pool)('WebhookConfigRepo (Postgres)', () => {
  const db = pool as pg.Pool
  let repo: WebhookConfigRepo
  const inst = uniqueName('wh')

  beforeAll(async () => {
    repo = new WebhookConfigRepo(db)
    await seedInstance(db, inst)
  })

  afterAll(async () => {
    await wipeInstance(db, inst)
  })

  it('CRUD + matching filters', async () => {
    const created = await repo.create(inst, {
      url: 'https://hooks.example/a',
      events: ['message', 'message.any'],
      hmacKey: 'secret-hmac-key',
      retries: { policy: 'exponential', delaySeconds: 2, attempts: 4 },
      customHeaders: [{ name: 'X-Test', value: '1' }],
    })
    expect(created.id).toBeTruthy()
    expect(created.hmacKey).toBe('secret-hmac-key')

    const listed = await repo.list(inst)
    expect(listed.some((w) => w.id === created.id)).toBe(true)

    const got = await repo.get(inst, created.id)
    expect(got?.url).toBe('https://hooks.example/a')

    expect(got).toBeTruthy()
    if (!got) throw new Error('expected webhook')
    const pub = toPublicWebhook(got)
    expect(pub.hmac).toEqual({ configured: true })
    expect(pub.retries.attempts).toBe(4)
    expect(pub.createdAt).toMatch(/^\d{4}-/)

    // message.any must match message* but not call.incoming
    expect((await repo.matching(inst, 'message')).map((w) => w.id)).toContain(created.id)
    expect((await repo.matching(inst, 'message.ack')).map((w) => w.id)).toContain(created.id)
    expect((await repo.matching(inst, 'call.incoming')).map((w) => w.id)).not.toContain(created.id)

    const updated = await repo.update(inst, created.id, {
      events: ['call.incoming'],
      enabled: true,
    })
    expect(updated?.events).toEqual(['call.incoming'])

    expect((await repo.matching(inst, 'call.incoming')).map((w) => w.id)).toContain(created.id)
    expect(await repo.matching(inst, 'message')).toHaveLength(0)

    // empty events = all
    const catchAll = await repo.create(inst, {
      url: 'https://hooks.example/all',
      events: [],
    })
    expect((await repo.matching(inst, 'presence.update')).some((w) => w.id === catchAll.id)).toBe(true)

    expect(await repo.delete(inst, created.id)).toBe(true)
    expect(await repo.get(inst, created.id)).toBeNull()
  })
})
