import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { canAccessInstance, isAdmin } from '~/auth/types'
import type { Env } from '~/config/env'
import { getEnv } from '~/config/env'
import { type RealtimeEvent, realtimeBus } from '~/events/bus'
import { forbidden, tooManyRequests } from '~/lib/errors'
import { getLogger } from '~/lib/logger'

export type EventsSseDeps = {
  /** Optional env override for tests; defaults to getEnv(). */
  env?: Pick<Env, 'NODE_ENV' | 'CORS_ORIGINS' | 'SSE_MAX_CONNECTIONS' | 'SSE_MAX_CONNECTIONS_PER_ACTOR'>
}

const QuerySchema = z.object({
  /**
   * @deprecated Prefer `X-Api-Key` / `Authorization` header.
   * Query only for native `EventSource` (cannot set headers). Leaks into logs/proxies.
   */
  apiKey: z.string().optional(),
  /** Admin may filter; instance keys are always scoped to their own instance. */
  instance: z.string().min(1).optional(),
})

/** One connected SSE client. Pre-computed filter + a ready-frame writer. */
type SseClient = {
  filterInstance: string | null
  actorInstance: string | null
  admin: boolean
  write: (frame: string) => void
}

/** Same allow/deny decision as `resolveCorsOrigin` in src/http/cors.ts. */
function isOriginAllowed(origin: string, env: Pick<Env, 'NODE_ENV' | 'CORS_ORIGINS'>): boolean {
  const raw = env.CORS_ORIGINS?.trim()
  if (!raw) return env.NODE_ENV !== 'production'
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (list.length === 0) return env.NODE_ENV !== 'production'
  if (list.includes('*')) return true
  return list.includes(origin)
}

/**
 * `reply.hijack()` bypasses @fastify/cors, so SSE must re-derive the same policy.
 * Reflect the request Origin only when the allowlist permits it; never emit a
 * wildcard origin alongside `Allow-Credentials`. No Origin header → no CORS headers.
 */
function corsHeadersForOrigin(
  origin: string | undefined,
  env: Pick<Env, 'NODE_ENV' | 'CORS_ORIGINS'>,
): Record<string, string> {
  if (!origin) return {}
  if (!isOriginAllowed(origin, env)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  }
}

function sseHeaders(origin: string | undefined, env: Pick<Env, 'NODE_ENV' | 'CORS_ORIGINS'>): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeadersForOrigin(origin, env),
  }
}

function clientAcceptsEvent(client: SseClient, instance: string): boolean {
  if (client.filterInstance && instance !== client.filterInstance) return false
  if (!client.admin && client.actorInstance && instance !== client.actorInstance) return false
  return true
}

/**
 * Server → client realtime events via **SSE** (unidirectional).
 *
 * ```
 * GET /v1/events?instance=optional
 * Accept: text/event-stream
 * X-Api-Key: <key>   # preferred
 * ```
 *
 * Auth (**prefer headers**):
 * - `X-Api-Key: <key>` or `Authorization: Bearer <key>` (curl, fetch, dashboard)
 * - query `?apiKey=` only as last resort (native EventSource cannot set headers)
 *
 * Each frame:
 * ```
 * data: {"instance":"…","event":"message.inbound","eventId":"…","timestamp":"…","data":{…}}\n\n
 * ```
 *
 * Keepalive comment every 15s: `: ping <ts>\n\n`
 *
 * VoIP control remains WebSocket (`/v1/voip`) because it is bidirectional.
 */
export const eventsSseRoutes: FastifyPluginAsync<EventsSseDeps> = async (app, deps) => {
  const log = getLogger({ component: 'events-sse' })
  const r = app.withTypeProvider<ZodTypeProvider>()
  const env = deps.env ?? getEnv()
  const maxGlobal = env.SSE_MAX_CONNECTIONS
  const maxPerActor = env.SSE_MAX_CONNECTIONS_PER_ACTOR

  // Fan-out registry: serialize each event ONCE, then write the ready frame to
  // every matching client (was one JSON.stringify per client before).
  const clients = new Set<SseClient>()
  const perActor = new Map<string, number>()
  realtimeBus.onAny((payload: RealtimeEvent) => {
    if (clients.size === 0) return
    const frame = `data: ${JSON.stringify(payload)}\n\n`
    for (const client of clients) {
      if (clientAcceptsEvent(client, payload.instance)) client.write(frame)
    }
  })

  // One shared keepalive for all clients instead of a timer per connection.
  const ping = setInterval(() => {
    if (clients.size === 0) return
    const frame = `: ping ${Date.now()}\n\n`
    for (const client of clients) client.write(frame)
  }, 15_000)
  ping.unref?.()

  r.get(
    '/v1/events',
    {
      schema: {
        tags: ['Realtime'],
        summary: 'SSE event stream (server → client)',
        description: [
          'Unidirectional live event stream (messages, connection, presence, calls, …).',
          '',
          '**Auth: put the API key in headers**, not in the URL (avoids access logs, proxies, Referer).',
          '',
          '### curl (recommended)',
          '```bash',
          'curl -N -H "X-Api-Key: $KEY" -H "Accept: text/event-stream" \\',
          '  "$BASE/v1/events?instance=sales-1"',
          '```',
          '',
          '### Browser (fetch + stream — can send headers)',
          '```js',
          'const res = await fetch(`/v1/events?instance=sales-1`, {',
          '  headers: { "X-Api-Key": key, Accept: "text/event-stream" },',
          '})',
          '// read res.body with TextDecoder…',
          '```',
          '',
          'Native `EventSource` cannot set headers — only then use `?apiKey=` (discouraged).',
          '',
          '- **Instance keys** are always scoped to their instance.',
          '- **Admin** may omit `instance` (all) or filter with `instance=`.',
          '- First event: `{ "event": "connected", "role", "instance", "timestamp" }`.',
          '- Keepalive: SSE comments every 15s (`: ping …`).',
        ].join('\n'),
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        querystring: QuerySchema,
      },
    },
    async (request, reply) => {
      const actor = request.actor
      const q = request.query

      const actorInstance = actor.role === 'instance' ? actor.instanceName : null
      // Instance keys are always scoped to their own instance. If they pass
      // `?instance=` for another name, reject (do not silently ignore).
      if (actorInstance && q.instance && q.instance !== actorInstance) {
        throw forbidden(`No access to instance "${q.instance}"`)
      }
      const filterInstance = actorInstance ?? q.instance ?? null

      if (filterInstance && !canAccessInstance(actor, filterInstance)) {
        throw forbidden(`No access to instance "${filterInstance}"`)
      }

      const actorKey = actor.role === 'admin' ? 'admin' : `instance:${actor.instanceName}`
      if (clients.size >= maxGlobal) {
        throw tooManyRequests(`SSE connection limit reached (max ${maxGlobal} process-wide)`)
      }
      if ((perActor.get(actorKey) ?? 0) >= maxPerActor) {
        throw tooManyRequests(`SSE connection limit reached (max ${maxPerActor} per API key)`)
      }

      // Take over the socket for long-lived streaming (skip Fastify JSON serializer)
      reply.hijack()

      const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
      reply.raw.writeHead(200, sseHeaders(origin, env))
      // Flush headers early on Node
      if (typeof (reply.raw as { flushHeaders?: () => void }).flushHeaders === 'function') {
        ;(reply.raw as { flushHeaders: () => void }).flushHeaders()
      }

      const write = (frame: string) => {
        if (reply.raw.writableEnded) return
        try {
          reply.raw.write(frame)
        } catch (err) {
          log.debug({ err }, 'sse write failed')
        }
      }

      const client: SseClient = { filterInstance, actorInstance, admin: isAdmin(actor), write }
      clients.add(client)
      perActor.set(actorKey, (perActor.get(actorKey) ?? 0) + 1)

      write(
        `data: ${JSON.stringify({
          event: 'connected',
          role: actor.role,
          instance: filterInstance,
          timestamp: new Date().toISOString(),
        })}\n\n`,
      )

      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        clients.delete(client)
        const n = (perActor.get(actorKey) ?? 1) - 1
        if (n <= 0) perActor.delete(actorKey)
        else perActor.set(actorKey, n)
        try {
          if (!reply.raw.writableEnded) reply.raw.end()
        } catch {
          /* */
        }
      }

      request.raw.on('close', cleanup)
      request.raw.on('error', cleanup)
      reply.raw.on('error', cleanup)

      log.debug({ role: actor.role, instance: filterInstance }, 'sse client connected')
    },
  )
}
