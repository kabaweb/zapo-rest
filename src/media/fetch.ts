import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Env } from '~/config/env'
import { badRequest } from '~/lib/errors'
import { assertPublicUrl } from '~/lib/ssrf-guard'

/** Hard cap for a single media download (URL stream or base64), in bytes. */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024
/** Abort a URL download that stalls past this window. */
const DOWNLOAD_TIMEOUT_MS = 30_000

type WebReadable = import('node:stream/web').ReadableStream

export type MediaSource = {
  mediaUrl?: string
  mediaBase64?: string
  mimetype?: string
  fileName?: string
}

export type ResolvedMedia = {
  path: string
  mimetype?: string
  cleanup: () => Promise<void>
}

export async function resolveMediaToFile(source: MediaSource, env: Pick<Env, 'MEDIA_TMP_DIR'>): Promise<ResolvedMedia> {
  const dir = env.MEDIA_TMP_DIR || tmpdir()
  await mkdir(dir, { recursive: true })
  const id = randomBytes(12).toString('hex')

  if (source.mediaUrl) return downloadUrlToFile(source.mediaUrl, source.mimetype, dir, id)
  if (source.mediaBase64) return decodeBase64ToFile(source.mediaBase64, source.mimetype, dir, id)
  throw badRequest('mediaUrl or mediaBase64 is required')
}

/** Fetch a user-supplied URL with SSRF vetting, no redirects, a timeout, and a byte cap. */
async function downloadUrlToFile(
  mediaUrl: string,
  mimetype: string | undefined,
  dir: string,
  id: string,
): Promise<ResolvedMedia> {
  await assertPublicUrl(mediaUrl)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(mediaUrl, { redirect: 'error', signal: controller.signal })
    if (!res.ok || !res.body) throw badRequest(`failed to download mediaUrl: HTTP ${res.status}`)
    assertContentLengthWithinLimit(res.headers.get('content-length'))
    const contentType = mimetype ?? res.headers.get('content-type') ?? undefined
    const path = join(dir, `${id}${guessExt(contentType)}`)
    await streamToFileCapped(res.body as WebReadable, path)
    return { path, mimetype: contentType, cleanup: () => removeQuietly(path) }
  } finally {
    clearTimeout(timeout)
  }
}

/** Decode inline base64, rejecting before allocation when it would exceed the cap. */
async function decodeBase64ToFile(
  mediaBase64: string,
  mimetype: string | undefined,
  dir: string,
  id: string,
): Promise<ResolvedMedia> {
  const raw = mediaBase64.includes(',') ? (mediaBase64.split(',')[1] ?? mediaBase64) : mediaBase64
  assertBase64WithinLimit(raw)
  const path = join(dir, `${id}${guessExt(mimetype)}`)
  await writeFile(path, Buffer.from(raw, 'base64'))
  return { path, mimetype, cleanup: () => removeQuietly(path) }
}

/** Reject early when the server already declares a body larger than the cap. */
function assertContentLengthWithinLimit(header: string | null): void {
  if (!header) return
  const declared = Number.parseInt(header, 10)
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
    throw badRequest(`mediaUrl too large: content-length ${declared} exceeds limit ${MAX_MEDIA_BYTES} bytes`)
  }
}

/** base64 decodes to ~3/4 of its length; reject before Buffer.from allocates. */
function assertBase64WithinLimit(raw: string): void {
  const estimatedBytes = Math.floor((raw.length * 3) / 4)
  if (estimatedBytes > MAX_MEDIA_BYTES) {
    throw badRequest(`mediaBase64 too large: ~${estimatedBytes} bytes exceeds limit ${MAX_MEDIA_BYTES} bytes`)
  }
}

/** Stream body to disk, aborting and cleaning the partial file if it exceeds the cap. */
async function streamToFileCapped(body: WebReadable, path: string): Promise<void> {
  try {
    await pipeline(Readable.fromWeb(body), byteCapTransform(), createWriteStream(path))
  } catch (err) {
    await removeQuietly(path)
    throw err
  }
}

/** Passthrough that fails the stream (badRequest) once cumulative bytes exceed the cap. */
function byteCapTransform(): Transform {
  let total = 0
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length
      if (total > MAX_MEDIA_BYTES) {
        cb(badRequest(`mediaUrl too large: exceeded limit ${MAX_MEDIA_BYTES} bytes during download`))
        return
      }
      cb(null, chunk)
    },
  })
}

function removeQuietly(path: string): Promise<void> {
  return unlink(path).catch(() => undefined)
}

function guessExt(mimetype?: string): string {
  if (!mimetype) return '.bin'
  if (mimetype.includes('jpeg') || mimetype.includes('jpg')) return '.jpg'
  if (mimetype.includes('png')) return '.png'
  if (mimetype.includes('webp')) return '.webp'
  if (mimetype.includes('ogg')) return '.ogg'
  if (mimetype.includes('mpeg') || mimetype.includes('mp3')) return '.mp3'
  if (mimetype.includes('mp4')) return '.mp4'
  if (mimetype.includes('pdf')) return '.pdf'
  return '.bin'
}
