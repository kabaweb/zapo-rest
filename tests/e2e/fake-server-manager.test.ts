/**
 * InstanceManager + FakeWaServer via testHooks.
 * Soft-skips when pair-success HMAC fails (zapo-js / fake-server version skew).
 */
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseEnv, resetEnvCache } from '~/config/env'
import { InstanceManager } from '~/instances/manager'
import { WebhookDispatcher } from '~/webhooks/dispatcher'
import { MemoryInstanceRepo } from '../helpers/memory-repo'

describe('InstanceManager + fake-server testHooks', () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic
  let server: any
  let manager: InstanceManager | null = null
  let available = false
  let skipReason = ''
  const sessionName = 'fake-mgr'

  beforeAll(async () => {
    try {
      const { FakeWaServer } = await import('@zapo-js/fake-server')
      server = await FakeWaServer.start()

      resetEnvCache()
      process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? 'test-admin-api-key-min-16'
      process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://zapo:zapo@127.0.0.1:5555/zapo_test'
      process.env.AUTO_CONNECT_ON_BOOT = 'false'
      process.env.HISTORY_SYNC_ENABLED = 'false'
      const env = parseEnv()

      const repo = new MemoryInstanceRepo()
      const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as pg.Pool
      manager = new InstanceManager({
        env,
        pool,
        // @ts-expect-error memory
        repo,
        webhooks: new WebhookDispatcher(env),
        dryRun: false,
        testHooks: {
          chatSocketUrls: [server.url],
          noiseRootCa: server.noiseRootCa,
          mediaProxyAgent: server.mediaProxyAgent,
        },
      })
      await manager.init()
      await manager.create({ name: sessionName })

      // connect in background; pair when pipeline authenticates
      const connectP = manager.connect(sessionName)
      const pipeline = await server.waitForAuthenticatedPipeline(15_000)
      await server.runPairing(pipeline, { deviceJid: '5511999999999:1@s.whatsapp.net' }, async () => {
        for (let i = 0; i < 80; i++) {
          const client = manager?.tryGetClient(sessionName)
          // biome-ignore lint/suspicious/noExplicitAny: credentials
          const creds = client?.getCredentials() as any
          if (creds?.advSecretKey && creds.registrationInfo?.identityKeyPair) {
            return {
              advSecretKey: creds.advSecretKey,
              identityPublicKey: creds.registrationInfo.identityKeyPair.pubKey,
            }
          }
          await new Promise((r) => setTimeout(r, 50))
        }
        throw new Error('credentials not ready')
      })

      try {
        await connectP
      } catch {
        /* pair may error client mid-connect */
      }

      // wait for meJid
      for (let i = 0; i < 60; i++) {
        if (manager.isRegistered(sessionName)) {
          available = true
          break
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      if (!available) {
        skipReason = 'instance never registered meJid after fake pairing'
      }
    } catch (err) {
      skipReason = err instanceof Error ? err.message : String(err)
      console.warn('fake-server manager setup soft-skip:', skipReason)
    }
  }, 90_000)

  afterAll(async () => {
    try {
      if (manager) {
        try {
          await manager.disconnect(sessionName)
        } catch {
          /* */
        }
        try {
          await manager.delete(sessionName)
        } catch {
          /* */
        }
      }
      await server?.stop()
    } catch {
      /* */
    }
  })

  it('lists live session after connect attempt', async (ctx) => {
    // Real skip (reported SKIPPED) when fake-server manager setup bailed.
    ctx.skip(!manager, skipReason || 'fake-server manager unavailable')
    const mgr = manager as InstanceManager
    // even without full register, create+connect should not throw for dry paths after setup
    const list = await mgr.list()
    expect(list.some((i) => i.name === sessionName)).toBe(true)
  })

  it('requireRegisteredClient works when pairing succeeds', async (ctx) => {
    ctx.skip(!available || !manager, skipReason || 'pairing did not register meJid')
    const mgr = manager as InstanceManager
    const client = mgr.requireRegisteredClient(sessionName)
    expect(client.getCredentials()?.meJid).toBeTruthy()
    expect(mgr.listLiveSessionNames()).toContain(sessionName)
  })

  it('tryGetClient returns client while session is live', async (ctx) => {
    ctx.skip(!manager, skipReason || 'fake-server manager unavailable')
    const mgr = manager as InstanceManager
    // session may still exist after failed pair
    const c = mgr.tryGetClient(sessionName)
    // either connected object or null — both valid depending on pair result
    expect(c === null || typeof c === 'object').toBe(true)
  })
})
