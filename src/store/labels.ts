import type pg from 'pg'
import { ulid } from 'ulid'

export type AppLabel = {
  instanceName: string
  labelId: string
  name: string
  color: number
  isActive: boolean
  predefinedId: string | null
  raw: unknown
  createdAt: Date
  updatedAt: Date
}

type LabelRow = {
  instance_name: string
  label_id: string
  name: string
  color: number
  is_active: boolean
  predefined_id: string | null
  raw: unknown
  created_at: Date
  updated_at: Date
}

function mapLabel(row: LabelRow): AppLabel {
  return {
    instanceName: row.instance_name,
    labelId: row.label_id,
    name: row.name,
    color: row.color,
    isActive: row.is_active,
    predefinedId: row.predefined_id,
    raw: row.raw,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toPublicLabel(l: AppLabel) {
  return {
    id: l.labelId,
    name: l.name,
    color: l.color,
    isActive: l.isActive,
    predefinedId: l.predefinedId,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  }
}

export class LabelStore {
  constructor(private readonly pool: pg.Pool) {}

  async list(instanceName: string): Promise<AppLabel[]> {
    const { rows } = await this.pool.query<LabelRow>(
      `SELECT * FROM app_labels WHERE instance_name = $1 ORDER BY name ASC`,
      [instanceName],
    )
    return rows.map(mapLabel)
  }

  async get(instanceName: string, labelId: string): Promise<AppLabel | null> {
    const { rows } = await this.pool.query<LabelRow>(
      `SELECT * FROM app_labels WHERE instance_name = $1 AND label_id = $2`,
      [instanceName, labelId],
    )
    return rows[0] ? mapLabel(rows[0]) : null
  }

  async upsert(input: {
    instanceName: string
    labelId?: string
    name: string
    color?: number
    isActive?: boolean
    predefinedId?: string | null
    raw?: unknown
  }): Promise<AppLabel> {
    const id = input.labelId ?? ulid()
    const { rows } = await this.pool.query<LabelRow>(
      `INSERT INTO app_labels (instance_name, label_id, name, color, is_active, predefined_id, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (instance_name, label_id) DO UPDATE SET
         name = EXCLUDED.name,
         color = EXCLUDED.color,
         is_active = EXCLUDED.is_active,
         predefined_id = COALESCE(EXCLUDED.predefined_id, app_labels.predefined_id),
         raw = CASE WHEN EXCLUDED.raw::text = '{}'::text THEN app_labels.raw ELSE EXCLUDED.raw END,
         updated_at = now()
       RETURNING *`,
      [
        input.instanceName,
        id,
        input.name,
        input.color ?? 0,
        input.isActive ?? true,
        input.predefinedId ?? null,
        JSON.stringify(input.raw ?? {}),
      ],
    )
    const row = rows[0]
    if (!row) throw new Error('upsert returned no row')
    return mapLabel(row)
  }

  async delete(instanceName: string, labelId: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM app_labels WHERE instance_name = $1 AND label_id = $2`, [
      instanceName,
      labelId,
    ])
    return (res.rowCount ?? 0) > 0
  }

  async setChatLabel(instanceName: string, labelId: string, chatJid: string, labeled: boolean): Promise<void> {
    if (!labeled) {
      await this.pool.query(
        `DELETE FROM app_label_chats WHERE instance_name = $1 AND label_id = $2 AND chat_jid = $3`,
        [instanceName, labelId, chatJid],
      )
      return
    }
    await this.pool.query(
      `INSERT INTO app_label_chats (instance_name, label_id, chat_jid, labeled)
       VALUES ($1,$2,$3,true)
       ON CONFLICT (instance_name, label_id, chat_jid) DO UPDATE SET
         labeled = true, updated_at = now()`,
      [instanceName, labelId, chatJid],
    )
  }

  async listChats(instanceName: string, labelId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ chat_jid: string }>(
      `SELECT chat_jid FROM app_label_chats
       WHERE instance_name = $1 AND label_id = $2 AND labeled = true
       ORDER BY chat_jid`,
      [instanceName, labelId],
    )
    return rows.map((r) => r.chat_jid)
  }

  async listLabelsForChat(instanceName: string, chatJid: string): Promise<AppLabel[]> {
    const { rows } = await this.pool.query<LabelRow>(
      `SELECT l.* FROM app_labels l
       INNER JOIN app_label_chats c
         ON c.instance_name = l.instance_name AND c.label_id = l.label_id
       WHERE l.instance_name = $1 AND c.chat_jid = $2 AND c.labeled = true
       ORDER BY l.name`,
      [instanceName, chatJid],
    )
    return rows.map(mapLabel)
  }
}
