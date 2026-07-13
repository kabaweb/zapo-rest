import { describe, expect, it } from 'vitest'
import { EventIdempotencyStore } from '~/store/events'

class ClaimPool {
  keys = new Set<string>()
  deleted = 0

  async query(sql: string, params?: unknown[]) {
    if (sql.includes('INSERT INTO processed_events')) {
      const k = `${params?.[0]}::${params?.[1]}`
      if (this.keys.has(k)) return { rowCount: 0, rows: [] }
      this.keys.add(k)
      return { rowCount: 1, rows: [] }
    }
    if (sql.includes('SELECT 1 FROM processed_events')) {
      const k = `${params?.[0]}::${params?.[1]}`
      return { rows: this.keys.has(k) ? [{}] : [], rowCount: this.keys.has(k) ? 1 : 0 }
    }
    if (sql.includes('DELETE FROM processed_events')) {
      const n = this.keys.size
      this.keys.clear()
      this.deleted = n
      return { rowCount: n, rows: [] }
    }
    return { rows: [], rowCount: 0 }
  }
}

describe('EventIdempotencyStore', () => {
  it('tryClaim is true once then false; has + prune work', async () => {
    const pool = new ClaimPool()
    const store = new EventIdempotencyStore(pool as never)

    expect(await store.tryClaim('i1', 'msg:1', 'message')).toBe(true)
    expect(await store.tryClaim('i1', 'msg:1', 'message')).toBe(false)
    expect(await store.has('i1', 'msg:1')).toBe(true)
    expect(await store.has('i1', 'msg:2')).toBe(false)
    expect(await store.prune(1)).toBe(1)
    expect(await store.has('i1', 'msg:1')).toBe(false)
  })
})
