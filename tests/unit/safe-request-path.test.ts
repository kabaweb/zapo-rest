import { describe, expect, it } from 'vitest'
import { safeRequestPath } from '~/plugins/error-handler'

describe('safeRequestPath', () => {
  it('strips query string including apiKey', () => {
    expect(safeRequestPath('/v1/events?apiKey=super-secret&instance=a')).toBe('/v1/events')
  })

  it('returns path unchanged when no query', () => {
    expect(safeRequestPath('/v1/instances/sales-1')).toBe('/v1/instances/sales-1')
  })

  it('handles empty', () => {
    expect(safeRequestPath(undefined)).toBe('')
    expect(safeRequestPath('')).toBe('')
  })
})
