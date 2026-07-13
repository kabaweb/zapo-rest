import { describe, expect, it } from 'vitest'
import { generateApiKey, safeEqual } from '~/lib/crypto-keys'

describe('crypto-keys', () => {
  it('generates prefixed keys', () => {
    const key = generateApiKey()
    expect(key.startsWith('zr_')).toBe(true)
    expect(key.length).toBeGreaterThan(20)
  })

  it('safeEqual is true for equal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
  })

  it('safeEqual is false for different strings', () => {
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'ab')).toBe(false)
  })
})
