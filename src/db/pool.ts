import pg from 'pg'
import type { Env } from '~/config/env'
import { getLogger } from '~/lib/logger'

const { Pool } = pg

let pool: pg.Pool | null = null

type PoolEnv = Pick<
  Env,
  'DATABASE_URL' | 'DB_POOL_MAX' | 'DB_CONNECTION_TIMEOUT_MS' | 'DB_IDLE_TIMEOUT_MS' | 'DB_STATEMENT_TIMEOUT_MS'
>

export function createPool(env: PoolEnv): pg.Pool {
  if (pool) return pool
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    // Cap runaway queries at the session level (applied to every pooled client).
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  })
  pool.on('error', (err) => {
    getLogger({ component: 'pg' }).error({ err }, 'unexpected pool error')
  })
  return pool
}

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error('Database pool not initialized')
  }
  return pool
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

/** Test helper */
export function setPool(p: pg.Pool | null): void {
  pool = p
}
