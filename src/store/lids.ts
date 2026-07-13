import type pg from 'pg'

export type LidMapping = {
  lid: string
  pn: string | null
  displayName: string | null
  pushName: string | null
  source: 'app_contacts' | 'mailbox_contacts'
}

/**
 * LID ↔ phone mappings from app projections and zapo mailbox_contacts.
 * multi-config list/count/get.
 */
export class LidStore {
  constructor(private readonly pool: pg.Pool) {}

  async list(instanceName: string, opts: { limit?: number; offset?: number } = {}): Promise<LidMapping[]> {
    const limit = Math.min(opts.limit ?? 100, 500)
    const offset = opts.offset ?? 0

    try {
      // Union app_contacts (with lid) + mailbox_contacts (session_id = instance)
      const { rows } = await this.pool.query<{
        lid: string
        pn: string | null
        display_name: string | null
        push_name: string | null
        source: string
      }>(
        `
 WITH mapped AS (
 SELECT
 CASE WHEN jid LIKE '%@lid' THEN jid ELSE lid END AS lid,
 COALESCE(phone_number, CASE WHEN jid LIKE '%@s.whatsapp.net' THEN split_part(jid, '@', 1) ELSE NULL END) AS pn,
 display_name,
 push_name,
 'app_contacts'::text AS source
 FROM app_contacts
 WHERE instance_name = $1
 AND (jid LIKE '%@lid' OR (lid IS NOT NULL AND lid <> ''))

 UNION ALL

 SELECT
 CASE WHEN jid LIKE '%@lid' THEN jid ELSE lid END AS lid,
 COALESCE(phone_number, CASE WHEN jid LIKE '%@s.whatsapp.net' THEN split_part(jid, '@', 1) ELSE NULL END) AS pn,
 display_name,
 push_name,
 'mailbox_contacts'::text AS source
 FROM mailbox_contacts
 WHERE session_id = $1
 AND (jid LIKE '%@lid' OR (lid IS NOT NULL AND lid <> ''))
 )
 SELECT DISTINCT ON (lid)
 lid, pn, display_name, push_name, source
 FROM mapped
 WHERE lid IS NOT NULL AND lid <> ''
 ORDER BY lid ASC
 LIMIT $2 OFFSET $3
 `,
        [instanceName, limit, offset],
      )

      return rows.map((r) => ({
        lid: r.lid.includes('@') ? r.lid : `${r.lid}@lid`,
        pn: r.pn,
        displayName: r.display_name,
        pushName: r.push_name,
        source: r.source as LidMapping['source'],
      }))
    } catch {
      // mailbox_contacts may not exist yet
      const { rows } = await this.pool.query<{
        lid: string
        pn: string | null
        display_name: string | null
        push_name: string | null
      }>(
        `
 SELECT DISTINCT ON (lid)
 CASE WHEN jid LIKE '%@lid' THEN jid ELSE lid END AS lid,
 COALESCE(phone_number, CASE WHEN jid LIKE '%@s.whatsapp.net' THEN split_part(jid, '@', 1) ELSE NULL END) AS pn,
 display_name,
 push_name
 FROM app_contacts
 WHERE instance_name = $1
 AND (jid LIKE '%@lid' OR (lid IS NOT NULL AND lid <> ''))
 AND (CASE WHEN jid LIKE '%@lid' THEN jid ELSE lid END) IS NOT NULL
 ORDER BY lid ASC
 LIMIT $2 OFFSET $3
 `,
        [instanceName, limit, offset],
      )
      return rows.map((r) => ({
        lid: r.lid.includes('@') ? r.lid : `${r.lid}@lid`,
        pn: r.pn,
        displayName: r.display_name,
        pushName: r.push_name,
        source: 'app_contacts' as const,
      }))
    }
  }

  async count(instanceName: string): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ c: string }>(
        `
 SELECT COUNT(DISTINCT lid)::text AS c FROM (
 SELECT CASE WHEN jid LIKE '%@lid' THEN jid ELSE lid END AS lid
 FROM app_contacts
 WHERE instance_name = $1 AND (jid LIKE '%@lid' OR (lid IS NOT NULL AND lid <> ''))
 UNION
 SELECT CASE WHEN jid LIKE '%@lid' THEN jid ELSE lid END AS lid
 FROM mailbox_contacts
 WHERE session_id = $1 AND (jid LIKE '%@lid' OR (lid IS NOT NULL AND lid <> ''))
 ) t
 WHERE lid IS NOT NULL AND lid <> ''
 `,
        [instanceName],
      )
      return Number(rows[0]?.c ?? 0)
    } catch {
      // mailbox_contacts may not exist yet (no zapo migration)
      const { rows } = await this.pool.query<{ c: string }>(
        `
 SELECT COUNT(*)::text AS c FROM (
 SELECT DISTINCT CASE WHEN jid LIKE '%@lid' THEN jid ELSE lid END AS lid
 FROM app_contacts
 WHERE instance_name = $1 AND (jid LIKE '%@lid' OR (lid IS NOT NULL AND lid <> ''))
 ) t WHERE lid IS NOT NULL AND lid <> ''
 `,
        [instanceName],
      )
      return Number(rows[0]?.c ?? 0)
    }
  }

  /**
   * Resolve a single LID mapping without materializing the whole list. Matches
   * the `@lid` jid (PK-indexed) first, then the `lid` column, preferring
   * app_contacts and falling back to mailbox_contacts when it exists.
   *
   * @example lids.findByLid('inst', '12345@lid')
   */
  async findByLid(instanceName: string, lid: string): Promise<LidMapping | null> {
    const normalized = lid.includes('@') ? lid : `${lid}@lid`
    const lidUser = lid.split('@')[0] ?? lid

    const fromApp = await this.lookupLidRow('app_contacts', 'instance_name', instanceName, normalized, lidUser)
    if (fromApp) return { ...fromApp, source: 'app_contacts' }

    try {
      const fromMailbox = await this.lookupLidRow('mailbox_contacts', 'session_id', instanceName, normalized, lidUser)
      if (fromMailbox) return { ...fromMailbox, source: 'mailbox_contacts' }
    } catch {
      // mailbox_contacts may not exist yet (no zapo migration)
    }
    return null
  }

  private async lookupLidRow(
    table: 'app_contacts' | 'mailbox_contacts',
    scopeCol: 'instance_name' | 'session_id',
    scope: string,
    normalized: string,
    lidUser: string,
  ): Promise<Omit<LidMapping, 'source'> | null> {
    const { rows } = await this.pool.query<{
      lid: string
      pn: string | null
      display_name: string | null
      push_name: string | null
    }>(
      `
 SELECT
 CASE WHEN jid LIKE '%@lid' THEN jid ELSE lid END AS lid,
 COALESCE(phone_number, CASE WHEN jid LIKE '%@s.whatsapp.net' THEN split_part(jid, '@', 1) ELSE NULL END) AS pn,
 display_name,
 push_name
 FROM ${table}
 WHERE ${scopeCol} = $1
 AND (jid = $2 OR lid = $2 OR lid = $3)
 ORDER BY (CASE WHEN jid LIKE '%@lid' THEN 0 ELSE 1 END)
 LIMIT 1
 `,
      [scope, normalized, lidUser],
    )
    const r = rows[0]
    if (!r) return null
    return {
      lid: r.lid.includes('@') ? r.lid : `${r.lid}@lid`,
      pn: r.pn,
      displayName: r.display_name,
      pushName: r.push_name,
    }
  }

  async findPnByLid(instanceName: string, lid: string): Promise<string | null> {
    const row = await this.findByLid(instanceName, lid)
    return row?.pn ?? null
  }

  async findLidByPn(instanceName: string, pn: string): Promise<string | null> {
    const digits = pn.replace(/\D/g, '')
    const { rows } = await this.pool.query<{ lid: string | null }>(
      `
 SELECT COALESCE(
 CASE WHEN jid LIKE '%@lid' THEN jid ELSE lid END,
 lid
 ) AS lid
 FROM app_contacts
 WHERE instance_name = $1
 AND (
 phone_number = $2
 OR phone_number = $3
 OR jid = $4
 OR jid LIKE $5
 )
 LIMIT 1
 `,
      [instanceName, digits, pn, `${digits}@s.whatsapp.net`, `${digits}:%@s.whatsapp.net`],
    )
    const lid = rows[0]?.lid
    if (!lid) return null
    return lid.includes('@') ? lid : `${lid}@lid`
  }
}
