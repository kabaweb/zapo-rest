import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Env } from '~/config/env'
import { getLogger } from '~/lib/logger'
import { contentDisposition } from '~/media/filename'

export type StoredObject = {
  storageKey: string
  url: string | null
  sizeBytes: number
  mimeType?: string
  /** SHA-256 hex of the object bytes (content-addressed identity within the instance). */
  sha256: string
  /** True when the object already existed for this instance and no bytes were rewritten. */
  deduped: boolean
}

export type MediaStorage = {
  readonly kind: 'local' | 's3'
  /**
   * Store bytes with **per-instance content-addressed dedup** (SHA-256).
   * Same payload within one instance → same key:
   *   `{instanceName}/cas/sha256/{hash}{ext}`
   * `ext` is a **type** suffix (from mime/filename), not the original display name —
   * so direct storage URLs open with the right type (e.g. `.xlsx`) while the
   * original name lives on the message row for API downloads.
   * Different instances do **not** share objects (wipe deletes `{name}/…`).
   * Avatars still use {@link putAt}.
   */
  put(
    instanceName: string,
    data: Buffer | Uint8Array,
    opts?: { mimeType?: string; filename?: string; messageId?: string },
  ): Promise<StoredObject>
  /** Overwrite at a fixed key (avatars) — no content-hash key, no CAS dedup. */
  putAt(storageKey: string, data: Buffer | Uint8Array, opts?: { mimeType?: string }): Promise<StoredObject>
  getStream(storageKey: string): Promise<Readable>
  getBuffer(storageKey: string): Promise<Buffer>
  delete(storageKey: string): Promise<void>
  /**
   * Delete every object for an instance (CAS + avatars + legacy keys under `{instanceName}/`).
   * Safe to call on instance teardown.
   */
  deleteInstance(instanceName: string): Promise<{ deleted: number }>
  exists(storageKey: string): Promise<boolean>
  /** Find any CAS object for this instance+hash (any extension). */
  findByContentHash(instanceName: string, sha256Hex: string): Promise<string | null>
  publicUrl(storageKey: string): string | null
  /**
   * Direct client download URL (no API proxy).
   * - S3/MinIO: presigned GET with optional ResponseContentDisposition (original filename)
   * - Local: public base URL when MEDIA_PUBLIC_BASE_URL is set (no custom filename)
   * Returns null when direct download is not available (caller should stream).
   */
  createDownloadUrl?(
    storageKey: string,
    opts?: {
      filename?: string | null
      mimeType?: string | null
      download?: boolean
      expiresInSeconds?: number
    },
  ): Promise<string | null>
}

/**
 * Per-instance content-addressed key with type extension for direct storage URLs.
 * Original display name is NOT in the key — it lives on `app_messages.media_filename`.
 */
export function contentAddressedKey(instanceName: string, sha256Hex: string, ext = ''): string {
  const hash = sha256Hex.toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('contentAddressedKey expects a 64-char hex SHA-256')
  }
  const inst = sanitizeInstanceSegment(instanceName)
  const safeExt = normalizeStorageExt(ext)
  return `${inst}/cas/sha256/${hash}${safeExt}`
}

/** Directory / S3 prefix for all variants of a hash (any extension). */
export function contentAddressedHashPrefix(instanceName: string, sha256Hex: string): string {
  const hash = sha256Hex.toLowerCase()
  const inst = sanitizeInstanceSegment(instanceName)
  return `${inst}/cas/sha256/${hash}`
}

/** Normalize extension to `.ext` lowercase, or empty string. */
export function normalizeStorageExt(extOrFilenameOrMime?: string): string {
  if (!extOrFilenameOrMime) return ''
  let e = extOrFilenameOrMime.trim().toLowerCase()
  // full filename → take suffix
  if (e.includes('/') || e.includes('\\')) {
    e = e.split(/[/\\]/).pop() ?? e
  }
  if (e.includes('.') && !e.startsWith('.')) {
    e = e.slice(e.lastIndexOf('.'))
  }
  if (!e.startsWith('.') && e.length > 0 && e.length <= 8 && !e.includes('/')) {
    // bare "xlsx" or mime subtype handled by guessStorageExt
    if (/^[a-z0-9]+$/.test(e)) e = `.${e}`
  }
  if (/^\.[a-z0-9]{1,8}$/.test(e)) return e
  return ''
}

/** Prefer mime map, then original filename extension. */
export function guessStorageExt(mime?: string, filename?: string): string {
  if (mime) {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'audio/ogg': '.ogg',
      'audio/mpeg': '.mp3',
      'audio/mp4': '.m4a',
      'audio/wav': '.wav',
      'video/mp4': '.mp4',
      'application/pdf': '.pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'application/zip': '.zip',
    }
    if (map[mime]) return map[mime]
  }
  if (filename?.includes('.')) {
    return normalizeStorageExt(filename)
  }
  return ''
}

export function instanceStoragePrefix(instanceName: string): string {
  return `${sanitizeInstanceSegment(instanceName)}/`
}

export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function sanitizeInstanceSegment(instanceName: string): string {
  // prevent path traversal in storage keys
  const s = instanceName.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!s) throw new Error('invalid instanceName for media storage')
  return s
}

class LocalMediaStorage implements MediaStorage {
  readonly kind = 'local' as const

  constructor(
    private readonly dir: string,
    private readonly publicBaseUrl?: string,
  ) {}

  async put(
    instanceName: string,
    data: Buffer | Uint8Array,
    opts?: { mimeType?: string; filename?: string; messageId?: string },
  ): Promise<StoredObject> {
    return putContentAddressed(this, instanceName, data, opts)
  }

  async putAt(storageKey: string, data: Buffer | Uint8Array, opts?: { mimeType?: string }): Promise<StoredObject> {
    const full = this.containedPath(storageKey)
    await mkdir(dirname(full), { recursive: true })
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    await writeFile(full, buf)
    const hash = sha256Hex(buf)
    return {
      storageKey,
      url: this.publicUrl(storageKey),
      sizeBytes: buf.byteLength,
      mimeType: opts?.mimeType,
      sha256: hash,
      deduped: false,
    }
  }

  /** Resolve a key under {@link dir}, rejecting path traversal before any fs access. */
  private containedPath(storageKey: string): string {
    // Reject relative segments before join so cross-tenant `a/../b/...` cannot resolve under the root.
    if (
      storageKey.includes('..') ||
      storageKey.includes('\\') ||
      storageKey.startsWith('/') ||
      storageKey.includes('\0')
    ) {
      throw new Error(`invalid media storage key (path traversal): ${storageKey}`)
    }
    const full = join(this.dir, storageKey)
    if (!resolve(full).startsWith(resolve(this.dir) + sep)) {
      throw new Error(`invalid media storage key (path traversal): ${storageKey}`)
    }
    return full
  }

  async getStream(storageKey: string): Promise<Readable> {
    const full = this.containedPath(storageKey)
    if (!existsSync(full)) throw new Error(`media not found: ${storageKey}`)
    return createReadStream(full)
  }

  async getBuffer(storageKey: string): Promise<Buffer> {
    return readFile(this.containedPath(storageKey))
  }

  async delete(storageKey: string): Promise<void> {
    await unlink(this.containedPath(storageKey)).catch(() => undefined)
  }

  async deleteInstance(instanceName: string): Promise<{ deleted: number }> {
    const prefixDir = join(this.dir, sanitizeInstanceSegment(instanceName))
    if (!existsSync(prefixDir)) return { deleted: 0 }
    const deleted = await countFilesRecursive(prefixDir)
    await rm(prefixDir, { recursive: true, force: true })
    return { deleted }
  }

  async exists(storageKey: string): Promise<boolean> {
    return existsSync(this.containedPath(storageKey))
  }

  async findByContentHash(instanceName: string, sha256Hex: string): Promise<string | null> {
    const prefix = contentAddressedHashPrefix(instanceName, sha256Hex)
    const dir = join(this.dir, dirname(prefix))
    const base = prefix.slice(prefix.lastIndexOf('/') + 1)
    if (!existsSync(dir)) return null
    const entries = await readdir(dir).catch(() => [])
    const hit = entries.find((f) => f === base || f.startsWith(`${base}.`))
    return hit ? `${dirname(prefix)}/${hit}`.replace(/\\/g, '/') : null
  }

  publicUrl(storageKey: string): string | null {
    if (!this.publicBaseUrl) return null
    return `${this.publicBaseUrl.replace(/\/$/, '')}/${storageKey}`
  }

  async createDownloadUrl(
    storageKey: string,
    _opts?: {
      filename?: string | null
      mimeType?: string | null
      download?: boolean
      expiresInSeconds?: number
    },
  ): Promise<string | null> {
    // Local public files cannot set Content-Disposition; client gets hash.ext name.
    return this.publicUrl(storageKey)
  }
}

class S3MediaStorage implements MediaStorage {
  readonly kind = 's3' as const
  private readonly client: S3Client
  /** Client bound to browser-reachable endpoint for presigned URLs. */
  private readonly presignClient: S3Client

  constructor(
    private readonly env: Env,
    private readonly bucket: string,
  ) {
    const credentials =
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          }
        : undefined

    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials,
    })

    const presignEndpoint = resolvePresignEndpoint(env)
    this.presignClient = new S3Client({
      region: env.S3_REGION,
      endpoint: presignEndpoint ?? env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials,
    })
  }

  async put(
    instanceName: string,
    data: Buffer | Uint8Array,
    opts?: { mimeType?: string; filename?: string; messageId?: string },
  ): Promise<StoredObject> {
    return putContentAddressed(this, instanceName, data, opts)
  }

  async putAt(storageKey: string, data: Buffer | Uint8Array, opts?: { mimeType?: string }): Promise<StoredObject> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const body = Readable.from(buf)

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: storageKey,
        Body: body,
        ContentType: opts?.mimeType,
        ContentLength: buf.byteLength,
      },
    })
    await upload.done()

    return {
      storageKey,
      url: this.publicUrl(storageKey),
      sizeBytes: buf.byteLength,
      mimeType: opts?.mimeType,
      sha256: sha256Hex(buf),
      deduped: false,
    }
  }

  async getStream(storageKey: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }))
    if (!res.Body) throw new Error(`empty S3 body for ${storageKey}`)
    return res.Body as Readable
  }

  async getBuffer(storageKey: string): Promise<Buffer> {
    const stream = await this.getStream(storageKey)
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }))
    } catch {
      /* ignore missing */
    }
  }

  async deleteInstance(instanceName: string): Promise<{ deleted: number }> {
    const prefix = instanceStoragePrefix(instanceName)
    let deleted = 0
    let token: string | undefined
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      )
      const keys = (listed.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k))
      // DeleteObjects accepts up to 1000 keys per request
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000)
        if (!chunk.length) continue
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
          }),
        )
        deleted += chunk.length
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined
    } while (token)
    return { deleted }
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }))
      return true
    } catch {
      return false
    }
  }

  async findByContentHash(instanceName: string, sha256Hex: string): Promise<string | null> {
    const prefix = contentAddressedHashPrefix(instanceName, sha256Hex)
    const listed = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: 5,
      }),
    )
    const key = listed.Contents?.find((o) => o.Key && (o.Key === prefix || o.Key.startsWith(`${prefix}.`)))?.Key
    return key ?? null
  }

  publicUrl(storageKey: string): string | null {
    if (this.env.S3_PUBLIC_URL) {
      return `${this.env.S3_PUBLIC_URL.replace(/\/$/, '')}/${storageKey}`
    }
    if (this.env.S3_ENDPOINT) {
      const base = this.env.S3_ENDPOINT.replace(/\/$/, '')
      return `${base}/${this.bucket}/${storageKey}`
    }
    return null
  }

  async createDownloadUrl(
    storageKey: string,
    opts?: {
      filename?: string | null
      mimeType?: string | null
      download?: boolean
      expiresInSeconds?: number
    },
  ): Promise<string | null> {
    const expiresIn = opts?.expiresInSeconds ?? this.env.MEDIA_PRESIGN_TTL_SECONDS ?? 3600
    const disposition = contentDisposition(
      opts?.filename ?? storageKey.split('/').pop() ?? 'file',
      opts?.download ? 'attachment' : 'inline',
    )

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
      ResponseContentDisposition: disposition,
      ...(opts?.mimeType ? { ResponseContentType: opts.mimeType } : {}),
    })

    try {
      return await getSignedUrl(this.presignClient, command, { expiresIn })
    } catch (err) {
      getLogger({ component: 'media-storage' }).warn({ err, storageKey }, 'presign failed')
      // Fall back to permanent public URL (no custom filename)
      return this.publicUrl(storageKey)
    }
  }
}

function resolvePresignEndpoint(env: Env): string | undefined {
  if (env.S3_PRESIGN_ENDPOINT) return env.S3_PRESIGN_ENDPOINT
  if (env.S3_PUBLIC_URL) {
    try {
      return new URL(env.S3_PUBLIC_URL).origin
    } catch {
      /* ignore */
    }
  }
  return undefined
}

/**
 * Shared CAS put: hash + type extension → per-instance key.
 * Dedup prefers any existing object for the same hash (any extension), so renames
 * never create a second copy. New objects store with a stable type extension for
 * direct storage URLs (open as .xlsx etc.).
 */
async function putContentAddressed(
  storage: Pick<MediaStorage, 'exists' | 'putAt' | 'publicUrl' | 'findByContentHash'>,
  instanceName: string,
  data: Buffer | Uint8Array,
  opts?: { mimeType?: string; filename?: string; messageId?: string },
): Promise<StoredObject> {
  const log = getLogger({ component: 'media-storage' })
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const hash = sha256Hex(buf)
  const ext = guessStorageExt(opts?.mimeType, opts?.filename)
  const preferredKey = contentAddressedKey(instanceName, hash, ext)

  // 1) exact preferred key
  // 2) any existing CAS object for this hash (dedup across slight ext differences)
  const existingKey = (await storage.exists(preferredKey))
    ? preferredKey
    : await storage.findByContentHash(instanceName, hash)

  if (existingKey) {
    log.info(
      {
        instanceName,
        storageKey: existingKey,
        sha256: hash,
        sizeBytes: buf.byteLength,
        messageId: opts?.messageId,
        filename: opts?.filename,
        deduped: true,
      },
      'media CAS hit — reusing existing object',
    )
    return {
      storageKey: existingKey,
      url: storage.publicUrl(existingKey),
      sizeBytes: buf.byteLength,
      mimeType: opts?.mimeType,
      sha256: hash,
      deduped: true,
    }
  }

  const stored = await storage.putAt(preferredKey, buf, { mimeType: opts?.mimeType })
  log.info(
    {
      instanceName,
      storageKey: preferredKey,
      sha256: hash,
      sizeBytes: buf.byteLength,
      messageId: opts?.messageId,
      filename: opts?.filename,
      ext,
      deduped: false,
    },
    'media CAS miss — stored new object',
  )
  return { ...stored, sha256: hash, deduped: false }
}

async function countFilesRecursive(dir: string): Promise<number> {
  let n = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.isDirectory()) n += await countFilesRecursive(join(dir, e.name))
    else if (e.isFile()) n += 1
  }
  return n
}

export function createMediaStorage(env: Env): MediaStorage {
  const log = getLogger({ component: 'media-storage' })
  if (env.MEDIA_STORAGE === 's3') {
    if (!env.S3_BUCKET) {
      throw new Error('MEDIA_STORAGE=s3 requires S3_BUCKET')
    }
    log.info({ bucket: env.S3_BUCKET, endpoint: env.S3_ENDPOINT }, 'using S3 media storage (per-instance CAS)')
    return new S3MediaStorage(env, env.S3_BUCKET)
  }
  log.info({ dir: env.MEDIA_LOCAL_DIR }, 'using local media storage (per-instance CAS)')
  return new LocalMediaStorage(env.MEDIA_LOCAL_DIR, env.MEDIA_PUBLIC_BASE_URL)
}

/** Ensure local dir exists (no-op for S3). */
export async function ensureMediaStorageReady(storage: MediaStorage, env: Env): Promise<void> {
  if (storage.kind === 'local') {
    await mkdir(env.MEDIA_LOCAL_DIR, { recursive: true })
  }
}
