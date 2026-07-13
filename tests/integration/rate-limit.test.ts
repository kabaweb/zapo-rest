import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '~/app'
import { InstanceManager } from '~/instances/manager'
import { WebhookDispatcher } from '~/webhooks/dispatcher'
import { makeEnv } from '../helpers/fixtures'
import { MemoryInstanceRepo } from '../helpers/memory-repo'

describe('rate limit on /v1', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    const env = makeEnv({
      RATE_LIMIT_ENABLED: true,
      RATE_LIMIT_MAX: 3,
      RATE_LIMIT_TIME_WINDOW_MS: 60_000,
    })
    const repo = new MemoryInstanceRepo()
    const pool = { query: async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }) } as unknown as pg.Pool
    const webhooks = new WebhookDispatcher({ env })
    const manager = new InstanceManager({
      env,
      pool,
      // @ts-expect-error memory repo
      repo,
      webhooks,
      dryRun: true,
    })
    await manager.init()
    app = await buildApp({
      env,
      pool,
      // @ts-expect-error memory repo
      instanceRepo: repo,
      manager,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 429 after max /v1 requests from same client', async () => {
    const headers = { 'x-api-key': 'test-admin-api-key-min-16' }
    const codes: number[] = []
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/instances', headers })
      codes.push(res.statusCode)
    }
    expect(codes.slice(0, 3).every((c) => c === 200 || c === 401 || c === 403 || c < 500)).toBe(true)
    // 4th and 5th should be rate limited (3 allowed)
    expect(codes[3]).toBe(429)
    expect(codes[4]).toBe(429)
    const body = (await app.inject({ method: 'GET', url: '/v1/instances', headers })).json() as {
      error?: { code?: string }
    }
    expect(body.error?.code).toBe('RATE_LIMITED')
  })

  it('does not rate-limit /health', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.statusCode).toBe(200)
    }
  })
})
