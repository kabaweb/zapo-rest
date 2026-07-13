import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '~/app'
import { parseEnv, resetEnvCache } from '~/config/env'
import { InstanceManager } from '~/instances/manager'
import { WebhookDispatcher } from '~/webhooks/dispatcher'

/**
 * Lightweight integration: dryRun manager + in-memory-ish repo mock via real SQL only if DB up.
 * Falls back to skip when DATABASE unreachable.
 */

class MemoryRepo {
  private rows = new Map<
    string,
    {
      name: string
      apiKey: string
      webhookUrl: string | null
      webhookEvents: string[]
      status: string
      meJid: string | null
      pairPhone: string | null
      lastQr: string | null
      lastQrAt: Date | null
      createdAt: Date
      updatedAt: Date
    }
  >()

  async list() {
    return [...this.rows.values()]
  }
  async getByName(name: string) {
    return this.rows.get(name) ?? null
  }
  async getByApiKey(apiKey: string) {
    return [...this.rows.values()].find((r) => r.apiKey === apiKey) ?? null
  }
  async create(input: { name: string; webhookUrl?: string | null; webhookEvents?: string[] }) {
    const row = {
      name: input.name,
      apiKey: `zr_test_${input.name}`,
      webhookUrl: input.webhookUrl ?? null,
      webhookEvents: input.webhookEvents ?? [],
      status: 'created' as const,
      meJid: null,
      pairPhone: null,
      lastQr: null,
      lastQrAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.rows.set(input.name, row)
    return row
  }
  async delete(name: string) {
    return this.rows.delete(name)
  }
  async updateStatus(name: string, patch: Record<string, unknown>) {
    const row = this.rows.get(name)
    if (!row) return null
    Object.assign(row, {
      status: patch.status ?? row.status,
      meJid: patch.meJid !== undefined ? patch.meJid : row.meJid,
      lastQr: patch.lastQr !== undefined ? patch.lastQr : row.lastQr,
      lastQrAt: patch.lastQrAt !== undefined ? patch.lastQrAt : row.lastQrAt,
      updatedAt: new Date(),
    })
    return row
  }
  async rotateApiKey(name: string) {
    const row = this.rows.get(name)
    if (!row) return null
    row.apiKey = `zr_rotated_${name}`
    row.updatedAt = new Date()
    return row
  }
}

describe('auth + instance routes (dryRun)', () => {
  let app: FastifyInstance
  let repo: MemoryRepo

  beforeAll(async () => {
    resetEnvCache()
    const env = parseEnv()
    repo = new MemoryRepo()
    const pool = {
      query: async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }),
    } as unknown as pg.Pool

    const webhooks = new WebhookDispatcher(env)
    const manager = new InstanceManager({
      env,
      pool,
      // @ts-expect-error memory repo shape compatible for dryRun paths
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

  it('rejects missing api key on /v1', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/instances' })
    expect(res.statusCode).toBe(401)
  })

  it('admin can create and list instances', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { 'x-api-key': 'test-admin-api-key-min-16' },
      payload: { name: 'demo-1' },
    })
    expect(create.statusCode).toBe(200)
    const body = create.json()
    expect(body.instance.name).toBe('demo-1')
    expect(body.instance.apiKey).toMatch(/^zr_/)

    const list = await app.inject({
      method: 'GET',
      url: '/v1/instances',
      headers: { 'x-api-key': 'test-admin-api-key-min-16' },
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().instances.length).toBeGreaterThanOrEqual(1)
  })

  it('instance key cannot list all; can get own', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { 'x-api-key': 'test-admin-api-key-min-16' },
      payload: { name: 'scoped' },
    })
    const apiKey = create.json().instance.apiKey as string

    const list = await app.inject({
      method: 'GET',
      url: '/v1/instances',
      headers: { 'x-api-key': apiKey },
    })
    expect(list.statusCode).toBe(403)

    const get = await app.inject({
      method: 'GET',
      url: '/v1/instances/scoped',
      headers: { 'x-api-key': apiKey },
    })
    // The instance key authenticates the read (200), but the read view never echoes the key back.
    expect(get.statusCode).toBe(200)
    expect(get.json().instance.name).toBe('scoped')
    expect(get.json().instance).not.toHaveProperty('apiKey')

    const other = await app.inject({
      method: 'GET',
      url: '/v1/instances/demo-1',
      headers: { 'x-api-key': apiKey },
    })
    expect(other.statusCode).toBe(403)
  })

  it('health is public', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('ok')
  })
})
