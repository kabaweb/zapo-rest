import type pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseEnv, resetEnvCache } from '~/config/env'
import { InstanceManager } from '~/instances/manager'
import { WebhookDispatcher } from '~/webhooks/dispatcher'
import { MemoryInstanceRepo } from '../helpers/memory-repo'

describe('InstanceManager (dryRun)', () => {
  let repo: MemoryInstanceRepo
  let manager: InstanceManager

  beforeEach(async () => {
    resetEnvCache()
    const env = parseEnv()
    repo = new MemoryInstanceRepo()
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as pg.Pool
    manager = new InstanceManager({
      env,
      pool,
      // @ts-expect-error memory repo
      repo,
      webhooks: new WebhookDispatcher(env),
      dryRun: true,
    })
    await manager.init()
  })

  afterEach(async () => {
    // dispose sessions if any
  })

  it('create / list / get / rotateKey / delete', async () => {
    const created = await manager.create({ name: 'mgr-1' })
    expect(created.name).toBe('mgr-1')
    expect(created.apiKey).toMatch(/^zr_/)

    const list = await manager.list()
    expect(list.some((i) => i.name === 'mgr-1')).toBe(true)

    const got = await manager.get('mgr-1')
    expect(got.apiKey).toBe(created.apiKey)

    const rotated = await manager.rotateKey('mgr-1')
    expect(rotated.apiKey).not.toBe(created.apiKey)

    await manager.delete('mgr-1')
    await expect(manager.get('mgr-1')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('rejects invalid names and duplicates', async () => {
    await expect(manager.create({ name: 'bad name' })).rejects.toMatchObject({ statusCode: 400 })
    await manager.create({ name: 'dup' })
    await expect(manager.create({ name: 'dup' })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('dryRun connect sets status open without WaClient', async () => {
    await manager.create({ name: 'conn-1' })
    const open = await manager.connect('conn-1')
    expect(open.status).toBe('open')
    expect(manager.tryGetClient('conn-1')).toBeNull()
    expect(manager.listLiveSessionNames()).toEqual([])
  })

  it('requireRegisteredClient throws when not connected', async () => {
    await manager.create({ name: 'reg-1' })
    expect(() => manager.requireRegisteredClient('reg-1')).toThrow(/not connected/i)
  })

  it('getClient throws when not connected', async () => {
    await manager.create({ name: 'gc-1' })
    expect(() => manager.getClient('gc-1')).toThrow(/not connected/i)
  })

  it('disconnect / restart on dryRun', async () => {
    await manager.create({ name: 'rs-1' })
    await manager.connect('rs-1')
    const closed = await manager.disconnect('rs-1')
    expect(closed.status).toBe('close')
    const again = await manager.restart('rs-1')
    expect(again.status).toBe('open')
  })
})
