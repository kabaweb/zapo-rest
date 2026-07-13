import { Redis } from 'ioredis'
import type { Env } from '~/config/env'
import { getLogger } from '~/lib/logger'

export type CacheClient = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  del(key: string): Promise<void>
  incr(key: string, ttlSeconds?: number): Promise<number>
  /** Publish JSON event on a channel (no-op without Redis pub/sub consumers) */
  publish(channel: string, payload: unknown): Promise<void>
  quit(): Promise<void>
  readonly kind: 'redis' | 'memory'
}

class MemoryCache implements CacheClient {
  readonly kind = 'memory' as const
  // Bound both maps: without Redis the process must not grow unbounded when a
  // caller writes many distinct keys with no/long TTL (lazy expiry only fires on read).
  private static readonly MAX_ENTRIES = 10_000
  private readonly map = new Map<string, { value: string; expiresAt?: number }>()
  private readonly counters = new Map<string, number>()
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor() {
    // Reclaim expired-but-untouched keys so idle entries don't linger until read.
    this.sweeper = setInterval(() => this.sweepExpired(), 60_000)
    this.sweeper.unref?.()
  }

  async get(key: string): Promise<string | null> {
    const row = this.map.get(key)
    if (!row) return null
    if (row.expiresAt && row.expiresAt < Date.now()) {
      this.map.delete(key)
      return null
    }
    return row.value
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.map.delete(key) // re-insert so the key moves to the most-recent slot
    this.map.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    })
    this.evictOldest(this.map)
  }

  async del(key: string): Promise<void> {
    this.map.delete(key)
    this.counters.delete(key)
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    this.evictOldest(this.counters)
    if (ttlSeconds && next === 1) {
      setTimeout(() => this.counters.delete(key), ttlSeconds * 1000).unref?.()
    }
    return next
  }

  async publish(): Promise<void> {
    // in-memory bus is handled by EventBus, not cache
  }

  async quit(): Promise<void> {
    clearInterval(this.sweeper)
    this.map.clear()
    this.counters.clear()
  }

  /** Drop oldest-inserted keys (Map preserves insertion order) once over cap. */
  private evictOldest<V>(store: Map<string, V>): void {
    while (store.size > MemoryCache.MAX_ENTRIES) {
      const oldest = store.keys().next().value
      if (oldest === undefined) break
      store.delete(oldest)
    }
  }

  private sweepExpired(): void {
    const now = Date.now()
    for (const [key, row] of this.map) {
      if (row.expiresAt && row.expiresAt < now) this.map.delete(key)
    }
  }
}

class RedisCache implements CacheClient {
  readonly kind = 'redis' as const
  private closed = false

  constructor(private readonly redis: Redis) {
    // ioredis rejects in-flight commands when the socket drops — never let that
    // become an unhandledRejection that kills the API process.
    redis.on('end', () => {
      this.closed = true
    })
    redis.on('close', () => {
      this.closed = true
    })
    redis.on('ready', () => {
      this.closed = false
    })
  }

  async get(key: string): Promise<string | null> {
    if (this.closed) return null
    try {
      return await this.redis.get(key)
    } catch {
      return null
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.closed) return
    try {
      if (ttlSeconds) {
        await this.redis.set(key, value, 'EX', ttlSeconds)
      } else {
        await this.redis.set(key, value)
      }
    } catch {
      // best-effort cache
    }
  }

  async del(key: string): Promise<void> {
    if (this.closed) return
    try {
      await this.redis.del(key)
    } catch {
      // ignore
    }
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    if (this.closed) return 0
    try {
      const n = await this.redis.incr(key)
      if (ttlSeconds && n === 1) {
        await this.redis.expire(key, ttlSeconds)
      }
      return n
    } catch {
      return 0
    }
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    // Fire-and-forget side channel — never throw into event handlers / shutdown
    if (this.closed || this.redis.status !== 'ready') return
    try {
      await this.redis.publish(channel, JSON.stringify(payload))
    } catch {
      // Connection closed mid-publish during shutdown or redis flap
    }
  }

  async quit(): Promise<void> {
    this.closed = true
    try {
      // Prefer quit (clean) with short race; fall back to disconnect so shutdown never hangs
      await Promise.race([
        this.redis.quit().then(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            try {
              this.redis.disconnect()
            } catch {
              /* */
            }
            resolve()
          }, 250)
        }),
      ])
    } catch {
      try {
        this.redis.disconnect()
      } catch {
        // ignore
      }
    }
  }
}

let cache: CacheClient | null = null
let redis: Redis | null = null

export function createCache(env: Env): CacheClient {
  const log = getLogger({ component: 'redis' })
  if (!env.REDIS_URL) {
    log.info('REDIS_URL not set — using in-memory cache')
    cache = new MemoryCache()
    return cache
  }

  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: false,
  })
  redis.on('error', (err) => {
    log.warn({ err }, 'redis error')
  })
  redis.on('connect', () => {
    log.info('redis connected')
  })
  cache = new RedisCache(redis)
  return cache
}

export function getCache(): CacheClient {
  if (!cache) {
    cache = new MemoryCache()
  }
  return cache
}

export async function closeCache(): Promise<void> {
  if (cache) {
    await cache.quit().catch(() => undefined)
    cache = null
  }
  redis = null
}

export function cacheKey(...parts: string[]): string {
  return `zapo:${parts.join(':')}`
}
