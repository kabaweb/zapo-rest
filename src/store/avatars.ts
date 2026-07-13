import { createHash } from 'node:crypto'
import type pg from 'pg'
import type { ProfilePictureType } from '~/lib/profile-picture-cache'

export type AvatarStatus = 'ok' | 'none' | 'privacy'

export type ContactAvatar = {
  instanceName: string
  jid: string
  picType: ProfilePictureType
  status: AvatarStatus
  storageKey: string | null
  sha256: string | null
  waPictureId: string | null
  mimeType: string | null
  sizeBytes: number | null
  lastCheckedAt: Date
  lastFetchedAt: Date | null
  reason: string | null
}

type Row = {
  instance_name: string
  jid: string
  pic_type: string
  status: string
  storage_key: string | null
  sha256: string | null
  wa_picture_id: string | null
  mime_type: string | null
  size_bytes: string | number | null
  last_checked_at: Date
  last_fetched_at: Date | null
  reason: string | null
}

function mapRow(r: Row): ContactAvatar {
  return {
    instanceName: r.instance_name,
    jid: r.jid,
    picType: (r.pic_type === 'image' ? 'image' : 'preview') as ProfilePictureType,
    status: (r.status as AvatarStatus) || 'ok',
    storageKey: r.storage_key,
    sha256: r.sha256,
    waPictureId: r.wa_picture_id,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    lastCheckedAt: r.last_checked_at,
    lastFetchedAt: r.last_fetched_at,
    reason: r.reason,
  }
}

/** Deterministic path — updates overwrite the same object (no orphans). */
export function avatarStorageKey(instanceName: string, jid: string, picType: ProfilePictureType): string {
  const hash = createHash('sha256').update(jid).digest('hex').slice(0, 32)
  return `${instanceName}/avatars/${hash}/${picType}.jpg`
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export class AvatarStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(instanceName: string, jid: string, picType: ProfilePictureType): Promise<ContactAvatar | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM contact_avatars
       WHERE instance_name = $1 AND jid = $2 AND pic_type = $3`,
      [instanceName, jid, picType],
    )
    return rows[0] ? mapRow(rows[0]) : null
  }

  async upsertOk(input: {
    instanceName: string
    jid: string
    picType: ProfilePictureType
    storageKey: string
    sha256: string
    waPictureId: string | null
    mimeType: string | null
    sizeBytes: number
    bytesChanged: boolean
  }): Promise<ContactAvatar> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO contact_avatars (
         instance_name, jid, pic_type, status, storage_key, sha256, wa_picture_id,
         mime_type, size_bytes, last_checked_at, last_fetched_at, reason
       ) VALUES ($1,$2,$3,'ok',$4,$5,$6,$7,$8,now(),now(),NULL)
       ON CONFLICT (instance_name, jid, pic_type) DO UPDATE SET
         status = 'ok',
         storage_key = EXCLUDED.storage_key,
         sha256 = EXCLUDED.sha256,
         wa_picture_id = EXCLUDED.wa_picture_id,
         mime_type = EXCLUDED.mime_type,
         size_bytes = EXCLUDED.size_bytes,
         last_checked_at = now(),
         last_fetched_at = CASE WHEN $9 THEN now() ELSE contact_avatars.last_fetched_at END,
         reason = NULL,
         updated_at = now()
       RETURNING *`,
      [
        input.instanceName,
        input.jid,
        input.picType,
        input.storageKey,
        input.sha256,
        input.waPictureId,
        input.mimeType,
        input.sizeBytes,
        input.bytesChanged,
      ],
    )
    const row = rows[0]
    if (!row) throw new Error('upsert returned no row')
    return mapRow(row)
  }

  /** Negative cache: privacy / no picture — clear storage_key in meta (caller deletes object). */
  async upsertNegative(input: {
    instanceName: string
    jid: string
    picType: ProfilePictureType
    status: 'none' | 'privacy'
    reason: string | null
  }): Promise<ContactAvatar> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO contact_avatars (
         instance_name, jid, pic_type, status, storage_key, sha256, wa_picture_id,
         mime_type, size_bytes, last_checked_at, last_fetched_at, reason
       ) VALUES ($1,$2,$3,$4,NULL,NULL,NULL,NULL,NULL,now(),NULL,$5)
       ON CONFLICT (instance_name, jid, pic_type) DO UPDATE SET
         status = EXCLUDED.status,
         storage_key = NULL,
         sha256 = NULL,
         wa_picture_id = NULL,
         mime_type = NULL,
         size_bytes = NULL,
         last_checked_at = now(),
         reason = EXCLUDED.reason,
         updated_at = now()
       RETURNING *`,
      [input.instanceName, input.jid, input.picType, input.status, input.reason],
    )
    const row = rows[0]
    if (!row) throw new Error('upsert returned no row')
    return mapRow(row)
  }

  /** Touch last_checked without re-download (same WA id / hash). */
  async touchChecked(instanceName: string, jid: string, picType: ProfilePictureType): Promise<void> {
    await this.pool.query(
      `UPDATE contact_avatars SET last_checked_at = now(), updated_at = now()
       WHERE instance_name = $1 AND jid = $2 AND pic_type = $3`,
      [instanceName, jid, picType],
    )
  }
}
