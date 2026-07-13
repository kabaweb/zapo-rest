import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import type { Env } from '~/config/env'
import type { InstanceRepo } from '~/instances/repo'
import { safeEqual } from '~/lib/crypto-keys'
import { forbidden, unauthorized } from '~/lib/errors'
import type { Actor } from './types'
import { canAccessInstance, isAdmin } from './types'

export type AuthDeps = {
  env: Env
  instanceRepo: InstanceRepo
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor
  }
}

function extractApiKey(request: FastifyRequest): string | null {
  // Prefer headers — never put secrets in URLs when the client can send headers
  // (SSE via fetch, REST, curl). Query is last-resort for native EventSource / WS browsers.
  const header = request.headers['x-api-key']
  if (typeof header === 'string' && header.length > 0) return header

  const auth = request.headers.authorization
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }

  // Fallback only: EventSource cannot set headers; browser WebSocket often cannot either.
  // Prefer fetch()+ReadableStream (SSE) or protocols that allow headers when possible.
  const q = request.query as { apiKey?: string } | undefined
  if (q && typeof q.apiKey === 'string' && q.apiKey.length > 0) return q.apiKey

  return null
}

export async function resolveActor(deps: AuthDeps, apiKey: string): Promise<Actor | null> {
  // Admin key lives in env as plaintext — compare timing-safely.
  if (safeEqual(apiKey, deps.env.ADMIN_API_KEY)) {
    return { role: 'admin' }
  }
  // Instance keys are stored as SHA-256 hashes. getByApiKey hashes the input and
  // matches the unique hash index, so a returned row IS the verification — there is
  // no recoverable plaintext to compare against.
  const instance = await deps.instanceRepo.getByApiKey(apiKey)
  if (!instance) return null
  return { role: 'instance', instanceName: instance.name }
}

const authPluginImpl: FastifyPluginAsync<AuthDeps> = async (app, deps) => {
  app.decorateRequest('actor', {
    getter(this: FastifyRequest) {
      return (this as FastifyRequest & { _actor?: Actor })._actor as Actor
    },
    setter(this: FastifyRequest, value: Actor) {
      ;(this as FastifyRequest & { _actor?: Actor })._actor = value
    },
  })

  app.addHook('onRequest', async (request) => {
    // Protect only /v1/* — OpenAPI UI/JSON at /docs is public (use network ACL in prod if needed)
    const url = request.url.split('?')[0] ?? ''
    if (!url.startsWith('/v1')) {
      return
    }

    const key = extractApiKey(request)
    if (!key) {
      throw unauthorized('Missing API key (X-Api-Key or Authorization: Bearer)')
    }
    const actor = await resolveActor(deps, key)
    if (!actor) {
      throw unauthorized('Invalid API key')
    }
    request.actor = actor
  })
}

export const authPlugin = fp(authPluginImpl, { name: 'auth-plugin' })

export function requireAdmin(request: FastifyRequest): void {
  if (!isAdmin(request.actor)) {
    throw forbidden('Admin API key required')
  }
}

export function requireInstanceAccess(request: FastifyRequest, instanceName: string): void {
  if (!canAccessInstance(request.actor, instanceName)) {
    throw forbidden(`No access to instance "${instanceName}"`)
  }
}
