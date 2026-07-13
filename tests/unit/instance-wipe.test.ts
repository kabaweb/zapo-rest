import { describe, expect, it } from 'vitest'
import { wipeInstanceCompletely } from '~/instances/wipe'

type QueryCall = { text: string; values?: unknown[] }

function makePool(opts?: { hasInstance?: boolean }) {
  const calls: QueryCall[] = []
  const hasInstance = opts?.hasInstance ?? true
  const pool = {
    connect: async () => {
      const client = {
        query: async (textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
          const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text
          const vals = typeof textOrConfig === 'string' ? values : textOrConfig.values
          calls.push({ text, values: vals })

          if (text.includes('information_schema.tables') && text.includes('EXISTS')) {
            return { rows: [{ exists: true }], rowCount: 1 }
          }
          if (text.includes('information_schema.columns') && text.includes('EXISTS')) {
            return { rows: [{ exists: true }], rowCount: 1 }
          }
          // listTablesWithColumn('session_id')
          if (text.includes('information_schema.columns') && text.includes('BASE TABLE')) {
            return {
              rows: [{ table_name: 'auth_credentials' }, { table_name: 'mailbox_messages' }],
              rowCount: 2,
            }
          }
          if (text.startsWith('DELETE FROM') || text.includes('DELETE FROM')) {
            if (text.includes('FROM "instances"') || text.includes('FROM instances')) {
              return { rows: [], rowCount: hasInstance ? 1 : 0 }
            }
            return { rows: [], rowCount: 2 }
          }
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
            return { rows: [], rowCount: 0 }
          }
          return { rows: [], rowCount: 0 }
        },
        release: () => undefined,
      }
      return client
    },
  }
  return { pool: pool as unknown as import('pg').Pool, calls }
}

describe('wipeInstanceCompletely', () => {
  it('wipes app tables, zapo session tables, instances row, and media', async () => {
    const { pool, calls } = makePool()
    const media = {
      deleteInstance: async (name: string) => {
        expect(name).toBe('wipe-me')
        return { deleted: 7 }
      },
    }

    const report = await wipeInstanceCompletely(pool, 'wipe-me', {
      mediaStorage: media as unknown as import('~/media/storage').MediaStorage,
    })
    expect(report.instanceDeleted).toBe(true)
    expect(report.mediaDeleted).toBe(7)
    expect(report.appRows.app_messages).toBe(2)
    expect(report.zapoRows.auth_credentials).toBe(2)

    const texts = calls.map((c) => c.text)
    expect(texts.some((t) => t.includes('BEGIN'))).toBe(true)
    expect(texts.some((t) => t.includes('COMMIT'))).toBe(true)
    expect(texts.some((t) => t.includes('DELETE FROM "app_messages"'))).toBe(true)
    expect(texts.some((t) => t.includes('DELETE FROM "auth_credentials"'))).toBe(true)
    expect(texts.some((t) => t.includes('DELETE FROM instances'))).toBe(true)
  })
})
