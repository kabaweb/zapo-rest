import { describe, expect, it } from 'vitest'
import { isSoftProfileQueryFailure, parseWaIqError } from '~/lib/wa-iq-error'

describe('parseWaIqError', () => {
  it('maps profile picture not-authorized', () => {
    const err = new Error('profile.getPicture iq failed (401: not-authorized)')
    const soft = parseWaIqError(err)
    expect(soft?.kind).toBe('privacy')
    expect(soft?.code).toBe('not-authorized')
    expect(isSoftProfileQueryFailure(err)).toBe(true)
  })

  it('maps item-not-found', () => {
    const err = new Error('profile.getPicture iq failed (404: item-not-found)')
    expect(parseWaIqError(err)?.kind).toBe('not_found')
  })

  it('returns null for unrelated errors', () => {
    expect(parseWaIqError(new Error('ECONNRESET'))).toBeNull()
  })
})
