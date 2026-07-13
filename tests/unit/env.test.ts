import { afterEach, describe, expect, it } from 'vitest'
import { parseEnv, resetEnvCache } from '~/config/env'

describe('parseEnv', () => {
  afterEach(() => {
    resetEnvCache()
  })

  it('parses valid env', () => {
    const env = parseEnv({
      NODE_ENV: 'test',
      ADMIN_API_KEY: 'test-admin-api-key-min-16',
      DATABASE_URL: 'postgresql://zapo:zapo@localhost:5432/zapo',
      AUTO_CONNECT_ON_BOOT: 'false',
    })
    expect(env.PORT).toBe(3000)
    expect(env.AUTO_CONNECT_ON_BOOT).toBe(false)
    expect(env.ADMIN_API_KEY.length).toBeGreaterThanOrEqual(16)
  })

  it('fails on short admin key', () => {
    expect(() =>
      parseEnv({
        ADMIN_API_KEY: 'short',
        DATABASE_URL: 'postgresql://zapo:zapo@localhost:5432/zapo',
      }),
    ).toThrow(/Invalid environment/)
  })
})
