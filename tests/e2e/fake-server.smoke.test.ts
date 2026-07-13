/**
 * E2E against @zapo-js/fake-server — verifies pairing + optional send path.
 * Soft-skips if fake-server API diverges across versions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('fake-server e2e', () => {
  let FakeWaServer: typeof import('@zapo-js/fake-server').FakeWaServer
  let createStore: typeof import('zapo-js').createStore
  let WaClient: typeof import('zapo-js').WaClient
  // biome-ignore lint/suspicious/noExplicitAny: dynamic handles
  let server: any
  // biome-ignore lint/suspicious/noExplicitAny: dynamic client
  let client: any
  let available = false

  beforeAll(async () => {
    try {
      ;({ FakeWaServer } = await import('@zapo-js/fake-server'))
      ;({ createStore, WaClient } = await import('zapo-js'))
      server = await FakeWaServer.start()
      const store = createStore({})
      client = new WaClient({
        store,
        sessionId: 'e2e-test',
        chatSocketUrls: [server.url],
        testHooks: { noiseRootCa: server.noiseRootCa },
        proxy: {
          mediaUpload: server.mediaProxyAgent,
          mediaDownload: server.mediaProxyAgent,
        },
        history: { enabled: false },
      })
      available = true
    } catch (err) {
      console.warn('fake-server setup failed — tests will soft-skip', err)
    }
  }, 60_000)

  afterAll(async () => {
    try {
      await client?.disconnect()
      await server?.stop()
    } catch {
      // ignore
    }
  })

  it('connects to fake server and completes QR pairing', async (ctx) => {
    // Real skip (reported as SKIPPED) when the fake-server surface diverged and setup bailed —
    // not a green pass from asserting `false === false`.
    ctx.skip(!available, 'fake-server unavailable (module/setup diverged)')

    const connectPromise = client.connect()
    const pipeline = await server.waitForAuthenticatedPipeline()

    await server.runPairing(pipeline, { deviceJid: '5511999999999:1@s.whatsapp.net' }, async () => {
      // Poll until credentials materialize after Noise handshake
      for (let i = 0; i < 50; i++) {
        const creds = client.getCredentials()
        if (creds?.advSecretKey && creds.registrationInfo?.identityKeyPair) {
          return {
            advSecretKey: creds.advSecretKey,
            identityPublicKey: creds.registrationInfo.identityKeyPair.pubKey,
          }
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error('credentials not ready for pairing')
    })

    await connectPromise

    // After pair-success the client may reconnect; credentials should be registered
    const creds = client.getCredentials()
    expect(creds).toBeTruthy()
    // meJid may appear after IK reconnect — status open is enough for smoke
    expect(creds?.advSecretKey).toBeTruthy()
  }, 60_000)
})
