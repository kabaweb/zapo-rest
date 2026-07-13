/**
 * Revive media download fields after JSON/jsonb round-trip.
 *
 * zapo-js `resolveMediaPayload` requires `mediaKey` (and hashes) as `Uint8Array`.
 * When we persist the WA event as JSONB, those bytes become either:
 * - `{ _type: 'bytes', base64 }` (preferred, written by sanitizeRaw)
 * - `{ type: 'Buffer', data: number[] }` (Node Buffer JSON)
 * - `{ "0": n, "1": n, ... }` (Uint8Array JSON)
 *
 * Without revival, re-download from WhatsApp always fails even when keys exist.
 */

const BINARY_FIELD_NAMES = new Set([
  'mediaKey',
  'fileSha256',
  'fileEncSha256',
  'jpegThumbnail',
  'thumbnailSha256',
  'thumbnailEncSha256',
  'midQualityFileSha256',
])

/** Fields that are protobufjs Long in live events and `{low,high,unsigned}` after JSON. */
const LONGISH_FIELD_NAMES = new Set([
  'fileLength',
  'mediaKeyTimestamp',
  'messageTimestamp',
  'seconds',
  'pageCount',
  'fileLengthWithPadding',
])

/** Encode binary for durable JSON storage (and skip huge/unusable blobs). */
export function sanitizeRawForStorage(event: unknown): unknown {
  if (!event || typeof event !== 'object') return event
  return sanitizeNode(event, /*isRoot*/ true)
}

function sanitizeNode(value: unknown, isRoot = false): unknown {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { _type: 'bytes', base64: Buffer.from(value).toString('base64') }
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeNode(v))
  if (!value || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isRoot && (k === 'rawNode' || k === 'messageBytes')) continue
    out[k] = sanitizeNode(v)
  }
  return out
}

/**
 * Convert a stored message `raw` into a source suitable for
 * `client.message.downloadBytes(...)`.
 *
 * Prefers the nested `message` proto when present (event shape).
 */
export function prepareMediaDownloadSource(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    throw new Error('no raw message payload for rehydrate')
  }
  const root = raw as Record<string, unknown>
  // Incoming event shape: { key, message: { imageMessage|documentMessage|... } }
  // Proto shape: { imageMessage|documentMessage|... }
  const message = root.message && typeof root.message === 'object' && !Array.isArray(root.message) ? root.message : root
  return reviveBinaryFields(message)
}

/** Deep-revive known binary media fields, Longs, and our `_type: bytes` markers. */
export function reviveBinaryFields(value: unknown): unknown {
  if (value == null) return value
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return value instanceof Uint8Array ? value : new Uint8Array(value)
  }
  if (Array.isArray(value)) return value.map(reviveBinaryFields)
  if (typeof value !== 'object') return value

  const obj = value as Record<string, unknown>

  // Preferred storage form
  if (obj._type === 'bytes' && typeof obj.base64 === 'string') {
    return new Uint8Array(Buffer.from(obj.base64, 'base64'))
  }

  // Standalone Long-shaped object (when field itself is the value)
  const asLong = coerceLongish(obj)
  if (asLong !== null && isPlainLongShape(obj)) return asLong

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (BINARY_FIELD_NAMES.has(k)) {
      out[k] = reviveBytes(v) ?? v
    } else if (LONGISH_FIELD_NAMES.has(k)) {
      out[k] = coerceLongish(v) ?? v
    } else if (v && typeof v === 'object') {
      out[k] = reviveBinaryFields(v)
    } else {
      out[k] = v
    }
  }
  return out
}

function isPlainLongShape(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj)
  if (!keys.includes('low') || !keys.includes('high')) return false
  return keys.every((k) => k === 'low' || k === 'high' || k === 'unsigned')
}

/**
 * Coerce protobufjs Long, JSON `{low,high,unsigned}`, number, or digit string → number.
 * Returns null when the value is not long-like.
 */
export function coerceLongish(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : null
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : null
  }
  if (typeof value === 'object') {
    const o = value as { toNumber?: () => number; low?: unknown; high?: unknown; unsigned?: unknown }
    if (typeof o.toNumber === 'function') {
      try {
        const n = o.toNumber()
        return typeof n === 'number' && Number.isFinite(n) ? n : null
      } catch {
        return null
      }
    }
    if (typeof o.low === 'number' && typeof o.high === 'number') {
      const low = o.low >>> 0
      const high = o.high >>> 0
      // unsigned 64-bit as JS number (fileLength etc. fit safe integer)
      const n = high * 0x1_0000_0000 + low
      return Number.isSafeInteger(n) ? n : null
    }
  }
  return null
}

export function reviveBytes(value: unknown): Uint8Array | null {
  if (value == null) return null
  if (value instanceof Uint8Array) return value
  if (Buffer.isBuffer(value)) return new Uint8Array(value)

  if (typeof value === 'string') {
    // bare base64 (some serializers)
    if (!value || value.length % 4 === 1) return null
    try {
      const buf = Buffer.from(value, 'base64')
      // reject if not valid base64 round-trip-ish (empty ok only for empty input)
      if (buf.byteLength === 0 && value.length > 0) return null
      return new Uint8Array(buf)
    } catch {
      return null
    }
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    if (Array.isArray(value) && value.every((n) => typeof n === 'number')) {
      return new Uint8Array(value as number[])
    }
    return null
  }

  const o = value as Record<string, unknown>

  if (o._type === 'bytes' && typeof o.base64 === 'string') {
    return new Uint8Array(Buffer.from(o.base64, 'base64'))
  }

  // Node Buffer JSON: { type: 'Buffer', data: number[] }
  if (o.type === 'Buffer' && Array.isArray(o.data)) {
    return new Uint8Array(o.data as number[])
  }

  // Uint8Array JSON: { "0": n, "1": n, ... }
  const keys = Object.keys(o)
  if (keys.length === 0) return null
  if (!keys.every((k) => /^\d+$/.test(k))) return null

  const len = keys.length
  // require dense 0..len-1
  for (let i = 0; i < len; i++) {
    if (!(String(i) in o)) return null
  }
  const arr = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    const n = o[String(i)]
    if (typeof n !== 'number' || n < 0 || n > 255 || !Number.isInteger(n)) return null
    arr[i] = n
  }
  return arr
}
