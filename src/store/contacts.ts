import type pg from 'pg'

export type AppContact = {
  instanceName: string
  jid: string
  displayName: string | null
  pushName: string | null
  lid: string | null
  phoneNumber: string | null
  profilePictureUrl: string | null
  blocked: boolean
  lastUpdatedMs: number | null
  raw: unknown
  createdAt: Date
  updatedAt: Date
}

type Row = {
  instance_name: string
  jid: string
  display_name: string | null
  push_name: string | null
  lid: string | null
  phone_number: string | null
  profile_picture_url: string | null
  blocked: boolean
  last_updated_ms: string | number | null
  raw: unknown
  created_at: Date
  updated_at: Date
}

function mapRow(row: Row): AppContact {
  return {
    instanceName: row.instance_name,
    jid: row.jid,
    displayName: row.display_name,
    pushName: row.push_name,
    lid: row.lid,
    phoneNumber: row.phone_number,
    profilePictureUrl: row.profile_picture_url,
    blocked: row.blocked,
    lastUpdatedMs: row.last_updated_ms == null ? null : Number(row.last_updated_ms),
    raw: row.raw,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toPublicContact(c: AppContact) {
  return {
    id: c.jid,
    name: c.displayName ?? c.pushName,
    pushName: c.pushName,
    lid: c.lid,
    phoneNumber: c.phoneNumber,
    profilePictureUrl: c.profilePictureUrl,
    blocked: c.blocked,
    _data: c.raw,
  }
}

export type UpsertContactInput = {
  instanceName: string
  jid: string
  displayName?: string | null
  pushName?: string | null
  lid?: string | null
  phoneNumber?: string | null
  profilePictureUrl?: string | null
  blocked?: boolean
  lastUpdatedMs?: number | null
  raw?: unknown
}

export class ContactStore {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(input: UpsertContactInput): Promise<AppContact> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO app_contacts (
        instance_name, jid, display_name, push_name, lid, phone_number,
        profile_picture_url, blocked, last_updated_ms, raw
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      ON CONFLICT (instance_name, jid) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, app_contacts.display_name),
        push_name = COALESCE(EXCLUDED.push_name, app_contacts.push_name),
        lid = COALESCE(EXCLUDED.lid, app_contacts.lid),
        phone_number = COALESCE(EXCLUDED.phone_number, app_contacts.phone_number),
        profile_picture_url = COALESCE(EXCLUDED.profile_picture_url, app_contacts.profile_picture_url),
        blocked = COALESCE(EXCLUDED.blocked, app_contacts.blocked),
        last_updated_ms = COALESCE(EXCLUDED.last_updated_ms, app_contacts.last_updated_ms),
        raw = CASE WHEN EXCLUDED.raw::text = '{}'::text THEN app_contacts.raw ELSE EXCLUDED.raw END,
        updated_at = now()
      RETURNING *`,
      [
        input.instanceName,
        input.jid,
        input.displayName ?? null,
        input.pushName ?? null,
        input.lid ?? null,
        input.phoneNumber ?? null,
        input.profilePictureUrl ?? null,
        input.blocked ?? false,
        input.lastUpdatedMs ?? null,
        JSON.stringify(input.raw ?? {}),
      ],
    )
    const row = rows[0]
    if (!row) throw new Error('upsert returned no row')
    return mapRow(row)
  }

  async list(instanceName: string, opts: { limit?: number; offset?: number } = {}): Promise<AppContact[]> {
    const limit = Math.min(opts.limit ?? 100, 500)
    const offset = opts.offset ?? 0
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM app_contacts WHERE instance_name = $1
       ORDER BY COALESCE(display_name, push_name, jid) ASC
       LIMIT $2 OFFSET $3`,
      [instanceName, limit, offset],
    )
    return rows.map(mapRow)
  }

  async get(instanceName: string, jid: string): Promise<AppContact | null> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM app_contacts WHERE instance_name = $1 AND jid = $2`, [
      instanceName,
      jid,
    ])
    return rows[0] ? mapRow(rows[0]) : null
  }

  async setBlocked(instanceName: string, jid: string, blocked: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE app_contacts SET blocked = $3, updated_at = now()
       WHERE instance_name = $1 AND jid = $2`,
      [instanceName, jid, blocked],
    )
  }

  /** Persist avatar URL on contact row (best-effort after profile-picture fetch). */
  async setProfilePictureUrl(instanceName: string, jid: string, profilePictureUrl: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO app_contacts (instance_name, jid, profile_picture_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (instance_name, jid) DO UPDATE SET
         profile_picture_url = EXCLUDED.profile_picture_url,
         updated_at = now()`,
      [instanceName, jid, profilePictureUrl],
    )
  }
}
