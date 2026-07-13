import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  contentAddressedHashPrefix,
  contentAddressedKey,
  createMediaStorage,
  ensureMediaStorageReady,
  guessStorageExt,
  sha256Hex,
} from '~/media/storage'
import { makeEnv } from '../helpers/fixtures'

describe('LocalMediaStorage', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zapo-media-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stores CAS objects with type extension for direct storage download', async () => {
    const env = makeEnv({
      MEDIA_STORAGE: 'local',
      MEDIA_LOCAL_DIR: dir,
      MEDIA_PUBLIC_BASE_URL: 'http://localhost:3000/v1/media',
    })
    const storage = createMediaStorage(env)
    await ensureMediaStorageReady(storage, env)

    const bytes = Buffer.from('hello-xlsx-bytes')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const stored = await storage.put('sales-1', bytes, {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: 'APRESENTACAO.xlsx',
      messageId: 'MSG1',
    })

    expect(stored.sha256).toBe(hash)
    expect(stored.storageKey).toBe(contentAddressedKey('sales-1', hash, '.xlsx'))
    expect(stored.storageKey.endsWith('.xlsx')).toBe(true)
    expect(stored.url).toBe(`http://localhost:3000/v1/media/${stored.storageKey}`)
    // original name is NOT in the storage key
    expect(stored.storageKey).not.toContain('APRESENTACAO')
  })

  it('dedupes same bytes with different original filenames (same type)', async () => {
    const env = makeEnv({ MEDIA_STORAGE: 'local', MEDIA_LOCAL_DIR: dir })
    const storage = createMediaStorage(env)
    const bytes = Buffer.from('shared-spreadsheet-payload')

    const a = await storage.put('inst-a', bytes, {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: 'APRESENTACAO.xlsx',
      messageId: 'm1',
    })
    const b = await storage.put('inst-a', bytes, {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: 'RELATORIO.xlsx',
      messageId: 'm2',
    })

    expect(a.storageKey).toBe(b.storageKey)
    expect(a.deduped).toBe(false)
    expect(b.deduped).toBe(true)
    expect(a.storageKey.endsWith('.xlsx')).toBe(true)

    const files = await readdir(join(dir, 'inst-a', 'cas', 'sha256'))
    expect(files).toHaveLength(1)
    expect(files[0]).toBe(`${a.sha256}.xlsx`)
  })

  it('reuses existing hash even if extension guess differs', async () => {
    const env = makeEnv({ MEDIA_STORAGE: 'local', MEDIA_LOCAL_DIR: dir })
    const storage = createMediaStorage(env)
    const bytes = Buffer.from('same-payload-ext-diff')

    const first = await storage.put('i1', bytes, {
      mimeType: 'application/pdf',
      filename: 'a.pdf',
    })
    // second put without mime, wrong/missing type metadata
    const second = await storage.put('i1', bytes, {
      filename: 'b.bin',
      messageId: 'x',
    })
    expect(second.deduped).toBe(true)
    expect(second.storageKey).toBe(first.storageKey)
    expect(await storage.findByContentHash('i1', first.sha256)).toBe(first.storageKey)
  })

  it('does not dedupe across instances', async () => {
    const env = makeEnv({ MEDIA_STORAGE: 'local', MEDIA_LOCAL_DIR: dir })
    const storage = createMediaStorage(env)
    const bytes = Buffer.from('same-bytes')
    const a = await storage.put('inst-a', bytes, { mimeType: 'image/png' })
    const b = await storage.put('inst-b', bytes, { mimeType: 'image/png' })
    expect(a.sha256).toBe(b.sha256)
    expect(a.storageKey).not.toBe(b.storageKey)
  })

  it('guessStorageExt prefers mime then filename', () => {
    expect(guessStorageExt('application/pdf', 'x.doc')).toBe('.pdf')
    expect(guessStorageExt(undefined, 'RELATORIO.xlsx')).toBe('.xlsx')
    expect(contentAddressedHashPrefix('s1', 'a'.repeat(64))).toBe(`s1/cas/sha256/${'a'.repeat(64)}`)
    expect(sha256Hex(Buffer.from('x')).length).toBe(64)
  })

  it('deleteInstance purges instance prefix', async () => {
    const env = makeEnv({ MEDIA_STORAGE: 'local', MEDIA_LOCAL_DIR: dir })
    const storage = createMediaStorage(env)
    const keep = await storage.put('keep', Buffer.from('x'), { mimeType: 'image/png' })
    const gone = await storage.put('gone', Buffer.from('y'), { mimeType: 'image/png' })
    await storage.putAt('gone/avatars/me.jpg', Buffer.from('avatar'))

    const { deleted } = await storage.deleteInstance('gone')
    expect(deleted).toBeGreaterThanOrEqual(2)
    expect(await storage.exists(gone.storageKey)).toBe(false)
    expect(await storage.exists(keep.storageKey)).toBe(true)
  })

  it('throws when s3 mode lacks bucket', () => {
    expect(() =>
      createMediaStorage(
        makeEnv({
          MEDIA_STORAGE: 's3',
          S3_BUCKET: undefined,
        }),
      ),
    ).toThrow(/S3_BUCKET/)
  })
})
