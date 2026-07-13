import { describe, expect, it } from 'vitest'
import { AppError, badRequest, conflict, forbidden, notFound, serviceUnavailable, unauthorized } from '~/lib/errors'
import { cacheKey, createCache } from '~/redis/client'
import { makeEnv } from '../helpers/fixtures'

describe('AppError helpers', () => {
  it('builds typed HTTP errors', () => {
    expect(badRequest('x', { f: 1 })).toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      details: { f: 1 },
    })
    expect(unauthorized()).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' })
    expect(forbidden('nope')).toMatchObject({ statusCode: 403, message: 'nope' })
    expect(notFound()).toMatchObject({ statusCode: 404 })
    expect(conflict('exists')).toMatchObject({ statusCode: 409 })
    expect(serviceUnavailable('down')).toMatchObject({ statusCode: 503 })
    expect(new AppError('e', 418, 'TEAPOT')).toBeInstanceOf(Error)
  })
})

describe('MemoryCache', () => {
  it('get/set/del/incr/publish/quit', async () => {
    const cache = createCache(makeEnv({ REDIS_URL: undefined }))
    expect(cache.kind).toBe('memory')

    expect(await cache.get('k')).toBeNull()
    await cache.set('k', 'v')
    expect(await cache.get('k')).toBe('v')

    await cache.set('ttl', 'x', 1)
    expect(await cache.get('ttl')).toBe('x')

    expect(await cache.incr('c')).toBe(1)
    expect(await cache.incr('c')).toBe(2)

    await cache.del('k')
    expect(await cache.get('k')).toBeNull()

    await cache.publish('ch', { a: 1 })
    await cache.quit()
  })

  it('cacheKey joins segments', () => {
    expect(cacheKey('events', 'sales-1')).toBe('zapo:events:sales-1')
  })
})
