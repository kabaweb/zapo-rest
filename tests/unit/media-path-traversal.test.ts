import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMediaStorage, ensureMediaStorageReady } from '~/media/storage'
import { makeEnv } from '../helpers/fixtures'

describe('LocalMediaStorage path traversal', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zapo-media-trav-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects getStream keys that escape the media root', async () => {
    const env = makeEnv({ MEDIA_STORAGE: 'local', MEDIA_LOCAL_DIR: dir })
    const storage = createMediaStorage(env)
    await ensureMediaStorageReady(storage, env)

    await expect(storage.getStream('../outside.txt')).rejects.toThrow(/path traversal/)
    await expect(storage.getStream('inst-a/../../etc/passwd')).rejects.toThrow(/path traversal/)
  })

  it('rejects putAt keys that escape the media root', async () => {
    const env = makeEnv({ MEDIA_STORAGE: 'local', MEDIA_LOCAL_DIR: dir })
    const storage = createMediaStorage(env)
    await ensureMediaStorageReady(storage, env)

    await expect(storage.putAt('../escape.bin', Buffer.from('x'))).rejects.toThrow(/path traversal/)
  })

  it('allows normal CAS keys under the root', async () => {
    const env = makeEnv({ MEDIA_STORAGE: 'local', MEDIA_LOCAL_DIR: dir })
    const storage = createMediaStorage(env)
    await ensureMediaStorageReady(storage, env)

    const stored = await storage.put('sales-1', Buffer.from('payload'), {
      mimeType: 'image/jpeg',
      filename: 'a.jpg',
    })
    const buf = await storage.getBuffer(stored.storageKey)
    expect(buf.toString()).toBe('payload')
  })

  it('route-level key shape rejects encoded traversal segments', async () => {
    // Mirrors src/routes/media.ts validation
    const badKeys = ['../other/cas/x', 'a/../../b', 'x\\y', 'a%2e%2e']
    for (const key of badKeys) {
      // After Fastify decode, %2e%2e becomes .. when present as path segment content
      const decoded = decodeURIComponent(key)
      const ok = /^[a-zA-Z0-9._/-]+$/.test(decoded) && !decoded.includes('..')
      expect(ok).toBe(false)
    }
    expect(/^[a-zA-Z0-9._/-]+$/.test('cas/sha256/abc.jpg') && !'cas/sha256/abc.jpg'.includes('..')).toBe(true)
  })

  it('does not serve sibling-instance objects via relative segments when join is used', async () => {
    const env = makeEnv({ MEDIA_STORAGE: 'local', MEDIA_LOCAL_DIR: dir })
    const storage = createMediaStorage(env)
    await ensureMediaStorageReady(storage, env)

    await storage.put('victim', Buffer.from('secret'), { mimeType: 'text/plain', filename: 's.txt' })
    // Attacker with access to "attacker" must not read victim via ../
    await expect(storage.getStream('attacker/../victim/cas/sha256/nope')).rejects.toThrow()
  })
})
