/**
 * End-to-end against @zapo-js/fake-server:
 * pair WaClient → createFakePeer → sendConversation → EventProcessor projections.
 * Soft-skips if fake-server/zapo-js pairing surface diverges.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EventProcessor } from '~/events/processor'
import { makeEnv } from '../helpers/fixtures'
import { MemoryInstanceRepo } from '../helpers/memory-repo'
import {
  MemoryChatStore,
  MemoryContactStore,
  MemoryIdempotencyStore,
  MemoryLidMapStore,
  MemoryMediaStorage,
  MemoryMessageStore,
} from '../helpers/memory-stores'

async function waitForCreds(client: { getCredentials: () => unknown }, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    // biome-ignore lint/suspicious/noExplicitAny: credentials bag
    const creds = client.getCredentials() as any
    if (creds?.advSecretKey && creds.registrationInfo?.identityKeyPair) {
      return {
        advSecretKey: creds.advSecretKey,
        identityPublicKey: creds.registrationInfo.identityKeyPair.pubKey,
      }
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('credentials not ready for pairing')
}

describe('fake-server + EventProcessor pipeline', () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic fake-server / client
  let server: any
  // biome-ignore lint/suspicious/noExplicitAny: dynamic
  let client: any
  // biome-ignore lint/suspicious/noExplicitAny: dynamic
  let peer: any
  // biome-ignore lint/suspicious/noExplicitAny: dynamic
  let pipeline: any
  let available = false
  let lastMessageEvent: unknown = null
  let skipReason = ''

  beforeAll(async () => {
    try {
      const { FakeWaServer } = await import('@zapo-js/fake-server')
      const { createStore, WaClient } = await import('zapo-js')

      server = await FakeWaServer.start()
      const store = createStore({})
      client = new WaClient({
        store,
        sessionId: 'e2e-pipeline',
        chatSocketUrls: [server.url],
        testHooks: { noiseRootCa: server.noiseRootCa },
        proxy: {
          mediaUpload: server.mediaProxyAgent,
          mediaDownload: server.mediaProxyAgent,
        },
        history: { enabled: false },
      })

      client.on('message', (ev: unknown) => {
        lastMessageEvent = ev
      })

      const connectPromise = client.connect()
      pipeline = await server.waitForAuthenticatedPipeline()
      await server.runPairing(pipeline, { deviceJid: '5511999999999:1@s.whatsapp.net' }, () => waitForCreds(client))
      await connectPromise

      // Post-pair IK reconnect
      try {
        pipeline = await server.waitForNextAuthenticatedPipeline(8_000)
      } catch {
        // some versions stay on the same pipeline
      }

      if (typeof server.createFakePeer !== 'function') {
        skipReason = 'createFakePeer not available'
        return
      }

      // biome-ignore lint/suspicious/noExplicitAny: credentials
      const me = (client.getCredentials() as any)?.meJid
      if (!me) {
        skipReason =
          'pairing did not register meJid (pair-success HMAC / zapo-js version skew) — smoke test still covers connect'
        return
      }

      peer = await server.createFakePeer(
        { jid: '5511888888888:0@s.whatsapp.net', displayName: 'Peer' },
        pipeline ?? (await server.waitForAuthenticatedPipeline(5_000)),
      )
      available = true
    } catch (err) {
      skipReason = err instanceof Error ? err.message : String(err)
      console.warn('fake-server pipeline setup failed — soft-skip:', skipReason)
    }
  }, 90_000)

  afterAll(async () => {
    try {
      await client?.disconnect()
      await server?.stop()
    } catch {
      /* */
    }
  })

  it('receives peer conversation and projects via EventProcessor', async (ctx) => {
    // Real skip (reported SKIPPED) when the fake-server/zapo-js pairing surface diverged.
    ctx.skip(!available, skipReason || 'fake-server pipeline unavailable')

    lastMessageEvent = null
    await peer.sendConversation('ping from fake peer')

    for (let i = 0; i < 120 && !lastMessageEvent; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(lastMessageEvent).toBeTruthy()

    const messages = new MemoryMessageStore()
    const chats = new MemoryChatStore()
    const contacts = new MemoryContactStore()
    const idempotency = new MemoryIdempotencyStore()
    const lidMap = new MemoryLidMapStore()
    const mediaStorage = new MemoryMediaStorage()
    const repo = new MemoryInstanceRepo()
    repo.seed({ name: 'e2e-pipeline', apiKey: 'zr_e2e' })
    const webhooks = { emit: vi.fn(async () => undefined) }

    const processor = new EventProcessor({
      env: makeEnv({ MEDIA_AUTO_DOWNLOAD: false }),
      // @ts-expect-error memory
      instanceRepo: repo,
      // @ts-expect-error memory
      messages,
      // @ts-expect-error memory
      chats,
      // @ts-expect-error memory
      contacts,
      // @ts-expect-error memory
      idempotency,
      // @ts-expect-error mock
      webhooks,
      mediaStorage,
      // @ts-expect-error memory
      lidMap,
    })

    await processor.onMessage('e2e-pipeline', lastMessageEvent, 'live', client)

    expect(messages.byKey.size).toBeGreaterThanOrEqual(1)
    const msg = [...messages.byKey.values()][0]
    expect(msg?.body?.toLowerCase()).toContain('ping')
    expect(webhooks.emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'e2e-pipeline' }),
      'message',
      expect.objectContaining({ body: expect.stringMatching(/ping/i) }),
    )
    expect(chats.byKey.size).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('client can send text to peer (outbound path smoke)', async (ctx) => {
    ctx.skip(!available, skipReason || 'fake-server unavailable')
    // biome-ignore lint/suspicious/noExplicitAny: credentials
    const me = (client.getCredentials() as any)?.meJid
    // Pairing HMAC can fail across zapo-js minor bumps — skip (not fake-pass) rather than assert absence.
    ctx.skip(!me, 'no meJid after fake pairing (zapo-js version skew)')

    const result = await client.message.send('5511888888888@s.whatsapp.net', 'pong from zapo-rest e2e')
    expect(result).toBeTruthy()
  }, 30_000)
})
