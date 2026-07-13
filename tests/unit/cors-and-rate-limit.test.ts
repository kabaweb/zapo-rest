import { describe, expect, it } from 'vitest'
import { isRateLimitEnabled, isV1ApiPath, resolveCorsOrigin } from '~/http/cors'

describe('resolveCorsOrigin', () => {
  it('allows any origin in development when CORS_ORIGINS unset', () => {
    expect(resolveCorsOrigin({ NODE_ENV: 'development', CORS_ORIGINS: undefined })).toBe(true)
  })

  it('disables CORS in production when CORS_ORIGINS unset', () => {
    expect(resolveCorsOrigin({ NODE_ENV: 'production', CORS_ORIGINS: undefined })).toBe(false)
  })

  it('parses comma-separated allowlist', () => {
    expect(
      resolveCorsOrigin({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.example.com, http://localhost:5173',
      }),
    ).toEqual(['https://app.example.com', 'http://localhost:5173'])
  })

  it('treats * as reflect-any', () => {
    expect(resolveCorsOrigin({ NODE_ENV: 'production', CORS_ORIGINS: '*' })).toBe(true)
  })
})

describe('isRateLimitEnabled', () => {
  it('defaults on only in production', () => {
    expect(isRateLimitEnabled({ NODE_ENV: 'production', RATE_LIMIT_ENABLED: undefined })).toBe(true)
    expect(isRateLimitEnabled({ NODE_ENV: 'development', RATE_LIMIT_ENABLED: undefined })).toBe(false)
    expect(isRateLimitEnabled({ NODE_ENV: 'test', RATE_LIMIT_ENABLED: undefined })).toBe(false)
  })

  it('honors explicit override', () => {
    expect(isRateLimitEnabled({ NODE_ENV: 'test', RATE_LIMIT_ENABLED: true })).toBe(true)
    expect(isRateLimitEnabled({ NODE_ENV: 'production', RATE_LIMIT_ENABLED: false })).toBe(false)
  })
})

describe('isV1ApiPath', () => {
  it('matches /v1 routes only', () => {
    expect(isV1ApiPath('/v1/instances')).toBe(true)
    expect(isV1ApiPath('/v1/events?instance=x')).toBe(true)
    expect(isV1ApiPath('/health')).toBe(false)
    expect(isV1ApiPath('/docs')).toBe(false)
    expect(isV1ApiPath('/guide/')).toBe(false)
  })
})
