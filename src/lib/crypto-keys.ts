import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const KEY_BYTES = 24

/** Generate a URL-safe instance API key (e.g. `zr_...`). */
export function generateApiKey(prefix = 'zr'): string {
  return `${prefix}_${randomBytes(KEY_BYTES).toString('base64url')}`
}

/**
 * SHA-256 hex digest of an API key. This is what we persist and index — the
 * plaintext key is shown to the caller once (on create/rotate) and never stored.
 * Lookups hash the incoming key and match on the digest (see InstanceRepo.getByApiKey).
 *
 * @example hashApiKey('zr_abc') // => '9f86d0818...' (64 hex chars)
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** Constant-time string equality (pads to same length first). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // Still run a compare to reduce timing leaks on length
    const pad = Buffer.alloc(bufA.length)
    timingSafeEqual(bufA, pad)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}
