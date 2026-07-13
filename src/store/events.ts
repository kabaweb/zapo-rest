import type pg from 'pg'

/**
 * Short-lived idempotency ledger for WhatsApp events.
 * Not event-sourcing — just "have we already processed event_key?"
 */
export class EventIdempotencyStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Try to claim processing of an event. Returns true if this is the first claim.
   */
  async tryClaim(instanceName: string, eventKey: string, eventType: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO processed_events (instance_name, event_key, event_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (instance_name, event_key) DO NOTHING`,
      [instanceName, eventKey, eventType],
    )
    return (rowCount ?? 0) > 0
  }

  async has(instanceName: string, eventKey: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM processed_events WHERE instance_name = $1 AND event_key = $2 LIMIT 1`,
      [instanceName, eventKey],
    )
    return rows.length > 0
  }

  /** Prune old entries (call periodically). */
  async prune(olderThanHours = 72): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM processed_events WHERE processed_at < now() - ($1 || ' hours')::interval`,
      [olderThanHours],
    )
    return rowCount ?? 0
  }
}
