/**
 * Shared pagination bounds so route/store limits stop being scattered magic
 * numbers. Each caller passes its own ceiling; the domain-specific caps below
 * document the historical values (kept to avoid behavior changes).
 *
 * @example
 *   const limit = clampLimit(query.limit, PAGE_LIMITS.messages) // 1..200, default 50
 */
export const DEFAULT_PAGE_SIZE = 50

export const PAGE_LIMITS = {
  messages: 200,
  chats: 200,
  calls: 200,
  contacts: 500,
  lids: 500,
  labels: 200,
  metrics: 200,
} as const

/**
 * Clamps a requested page size into `[1, max]`, falling back to `def` when the
 * input is missing or not a positive number.
 */
export function clampLimit(raw: unknown, max: number, def = DEFAULT_PAGE_SIZE): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n < 1) return Math.min(def, max)
  return Math.min(Math.floor(n), max)
}
