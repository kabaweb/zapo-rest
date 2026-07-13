import type { FastifyPluginAsync } from 'fastify'
import { isAdmin } from '~/auth/types'
import { ErrorBodySchema, MeResponseSchema } from '~/http/openapi-schemas'
import type { InstanceManager } from '~/instances/manager'

export type MeRoutesDeps = {
  manager: InstanceManager
}

export const meRoutes: FastifyPluginAsync<MeRoutesDeps> = async (app, deps) => {
  app.get(
    '/v1/me',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Resolve current API key',
        description:
          'Identifies whether the provided API key is **admin** or an **instance** key.\n\n' +
          'Used by the dashboard after login.\n\n' +
          '**Responses:**\n' +
          '- Admin: `{ "role": "admin" }`\n' +
          '- Instance: `{ "role": "instance", "instance": { ...full instance including apiKey } }`\n\n' +
          '**Example**\n' +
          '```bash\n' +
          'curl -s "$BASE/v1/me" -H "X-Api-Key: $KEY"\n' +
          '```',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        response: {
          200: MeResponseSchema,
          401: ErrorBodySchema,
        },
      },
    },
    async (request) => {
      const actor = request.actor
      if (actor.role === 'admin' || isAdmin(actor)) {
        return { role: 'admin' as const }
      }
      const instance = await deps.manager.get(actor.instanceName)
      return { role: 'instance' as const, instance }
    },
  )
}
