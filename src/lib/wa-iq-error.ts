/**
 * Map zapo-js / WhatsApp IQ stanza failures into soft outcomes.
 * Privacy-denied picture/status queries are normal — not API bugs.
 */

export type WaIqSoftFail = {
  kind: 'privacy' | 'not_found' | 'unavailable' | 'unknown'
  message: string
  code?: string
}

export function parseWaIqError(err: unknown): WaIqSoftFail | null {
  if (!(err instanceof Error)) return null
  const msg = err.message

  // profile.getPicture iq failed (401: not-authorized)
  // profile.getStatus iq failed (401: not-authorized)
  // iq failed (404: item-not-found)
  const m = msg.match(/\((\d{3}):\s*([a-z0-9_-]+)\)/i)
  const httpish = m?.[1]
  const code = m?.[2]?.toLowerCase()

  if (
    code === 'not-authorized' ||
    httpish === '401' ||
    httpish === '403' ||
    /not-authorized|not authorized|forbidden/i.test(msg)
  ) {
    return {
      kind: 'privacy',
      message: 'WhatsApp denied access (contact privacy / not authorized)',
      code: code ?? 'not-authorized',
    }
  }

  if (
    code === 'item-not-found' ||
    code === 'not-found' ||
    httpish === '404' ||
    /item-not-found|no profile picture|not found/i.test(msg)
  ) {
    return {
      kind: 'not_found',
      message: 'Resource not available on WhatsApp',
      code: code ?? 'item-not-found',
    }
  }

  if (httpish === '503' || code === 'service-unavailable' || /service-unavailable/i.test(msg)) {
    return {
      kind: 'unavailable',
      message: 'WhatsApp temporarily unavailable for this query',
      code: code ?? 'service-unavailable',
    }
  }

  if (/iq failed/i.test(msg)) {
    return { kind: 'unknown', message: msg, code }
  }

  return null
}

/** True when callers should return null instead of 500 (picture/status/about). */
export function isSoftProfileQueryFailure(err: unknown): boolean {
  const parsed = parseWaIqError(err)
  return parsed?.kind === 'privacy' || parsed?.kind === 'not_found' || parsed?.kind === 'unavailable'
}
