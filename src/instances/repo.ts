import type pg from 'pg'
import { generateApiKey, hashApiKey } from '~/lib/crypto-keys'
import type { CreateInstanceInput, InstanceRecord, InstanceStatus } from './types'

type Row = {
  name: string
  api_key_hash: string
  webhook_url: string | null
  webhook_events: string[] | null
  status: string
  me_jid: string | null
  pair_phone: string | null
  last_qr: string | null
  last_qr_at: Date | null
  config?: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
}

/**
 * Placeholder returned in `apiKey` on reads: the plaintext key is hashed at rest
 * and unrecoverable. Only create/rotate override this with the real key (once).
 */
const MASKED_API_KEY = '***'

function mapRow(row: Row): InstanceRecord {
  return {
    name: row.name,
    apiKey: MASKED_API_KEY,
    webhookUrl: row.webhook_url,
    webhookEvents: row.webhook_events ?? [],
    status: row.status as InstanceStatus,
    meJid: row.me_jid,
    pairPhone: row.pair_phone,
    lastQr: row.last_qr,
    lastQrAt: row.last_qr_at,
    config: (row.config && typeof row.config === 'object' ? row.config : {}) as InstanceRecord['config'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class InstanceRepo {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<InstanceRecord[]> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM instances ORDER BY name ASC')
    return rows.map(mapRow)
  }

  async getByName(name: string): Promise<InstanceRecord | null> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM instances WHERE name = $1', [name])
    const row = rows[0]
    return row ? mapRow(row) : null
  }

  /** Resolve an instance by its plaintext key via the stored SHA-256 hash. */
  async getByApiKey(apiKey: string): Promise<InstanceRecord | null> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM instances WHERE api_key_hash = $1', [
      hashApiKey(apiKey),
    ])
    const row = rows[0]
    return row ? mapRow(row) : null
  }

  async create(input: CreateInstanceInput): Promise<InstanceRecord> {
    const apiKey = generateApiKey()
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO instances (name, api_key_hash, webhook_url, webhook_events, pair_phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.name, hashApiKey(apiKey), input.webhookUrl ?? null, input.webhookEvents ?? [], input.pairPhone ?? null],
    )
    const row = rows[0]
    if (!row) throw new Error('insert returned no row')
    // Surface the plaintext once — it cannot be recovered after this call.
    return { ...mapRow(row), apiKey }
  }

  async delete(name: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM instances WHERE name = $1', [name])
    return (result.rowCount ?? 0) > 0
  }

  async updateStatus(
    name: string,
    patch: {
      status?: InstanceStatus
      meJid?: string | null
      lastQr?: string | null
      lastQrAt?: Date | null
      pairPhone?: string | null
      webhookUrl?: string | null
      webhookEvents?: string[]
    },
  ): Promise<InstanceRecord | null> {
    const sets: string[] = ['updated_at = now()']
    const values: unknown[] = []
    let i = 1

    const add = (col: string, val: unknown) => {
      sets.push(`${col} = $${i++}`)
      values.push(val)
    }

    if (patch.status !== undefined) add('status', patch.status)
    if (patch.meJid !== undefined) add('me_jid', patch.meJid)
    if (patch.lastQr !== undefined) add('last_qr', patch.lastQr)
    if (patch.lastQrAt !== undefined) add('last_qr_at', patch.lastQrAt)
    if (patch.pairPhone !== undefined) add('pair_phone', patch.pairPhone)
    if (patch.webhookUrl !== undefined) add('webhook_url', patch.webhookUrl)
    if (patch.webhookEvents !== undefined) add('webhook_events', patch.webhookEvents)

    values.push(name)
    const { rows } = await this.pool.query<Row>(
      `UPDATE instances SET ${sets.join(', ')} WHERE name = $${i} RETURNING *`,
      values,
    )
    const row = rows[0]
    return row ? mapRow(row) : null
  }

  async rotateApiKey(name: string): Promise<InstanceRecord | null> {
    const apiKey = generateApiKey()
    const { rows } = await this.pool.query<Row>(
      `UPDATE instances SET api_key_hash = $1, updated_at = now() WHERE name = $2 RETURNING *`,
      [hashApiKey(apiKey), name],
    )
    const row = rows[0]
    // Surface the plaintext once — the previous key is now invalid.
    return row ? { ...mapRow(row), apiKey } : null
  }

  async getConfig(name: string): Promise<Record<string, unknown>> {
    const { rows } = await this.pool.query<{ config: Record<string, unknown> | null }>(
      `SELECT config FROM instances WHERE name = $1`,
      [name],
    )
    return rows[0]?.config ?? {}
  }

  async patchConfig(name: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { rows } = await this.pool.query<{ config: Record<string, unknown> }>(
      `UPDATE instances
       SET config = COALESCE(config, '{}'::jsonb) || $2::jsonb,
           updated_at = now()
       WHERE name = $1
       RETURNING config`,
      [name, JSON.stringify(patch)],
    )
    if (!rows[0]) throw new Error(`instance ${name} not found`)
    return rows[0].config
  }
}
