import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { HealthResponseSchema, ReadyResponseSchema } from '~/http/openapi-schemas'
import type { CacheClient } from '~/redis/client'

export type HealthDeps = {
  pool: Pool
  cache?: CacheClient
}

export const healthRoutes: FastifyPluginAsync<HealthDeps> = async (app, deps) => {
  app.get(
    '/health',
    {
      schema: {
        hide: false,
        tags: ['Health'],
        summary: 'Liveness probe',
        description:
          'Returns `200 { "status": "ok" }` when the process is up. **No authentication.**\n\n' +
          'Use for load balancers / Kubernetes liveness probes.',
        security: [],
        response: {
          200: HealthResponseSchema,
        },
      },
    },
    async () => ({ status: 'ok' as const }),
  )

  app.get(
    '/ready',
    {
      schema: {
        tags: ['Health'],
        summary: 'Readiness probe',
        description:
          'Checks Postgres connectivity with `SELECT 1`.\n\n' +
          '- `200 { "status": "ready" }` when the database is reachable\n' +
          '- `503 { "status": "not_ready" }` otherwise\n\n' +
          '**No authentication.** Use for readiness gates before sending traffic.',
        security: [],
        response: {
          200: ReadyResponseSchema,
          503: ReadyResponseSchema,
        },
      },
    },
    async (_req, reply) => {
      try {
        await deps.pool.query('SELECT 1')
        // touch cache to ensure it's usable (no-op for memory)
        if (deps.cache) await deps.cache.set('zapo:ready-check', '1', 10)
        return { status: 'ready' as const }
      } catch {
        return reply.status(503).send({ status: 'not_ready' as const })
      }
    },
  )
}
