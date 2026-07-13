import { readFile } from 'node:fs/promises'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireInstanceAccess } from '~/auth/plugin'
import type { Env } from '~/config/env'
import { ErrorBodySchema, InstanceNameParams } from '~/http/openapi-schemas'
import type { InstanceManager } from '~/instances/manager'
import { resolveMediaToFile } from '~/media/fetch'

export type ProfileRoutesDeps = {
  manager: InstanceManager
  env: Env
}

export const profileRoutes: FastifyPluginAsync<ProfileRoutesDeps> = async (fastify, deps) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()
  const { manager, env } = deps

  app.get(
    '/v1/instances/:name/profile',
    {
      schema: {
        tags: ['Profile'],
        summary: 'Get own profile snapshot',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        params: InstanceNameParams,
        response: {
          200: z.object({ profile: z.any().meta({ type: 'object', additionalProperties: true }) }),
          503: ErrorBodySchema,
        },
      },
    },
    async (request) => {
      const { name } = request.params
      requireInstanceAccess(request, name)
      const client = manager.requireRegisteredClient(name)
      const creds = client.getCredentials()
      const meJid = creds?.meJid
      let status: string | null = null
      let picture: unknown = null
      if (meJid) {
        try {
          const s = await client.profile.getStatus(meJid)
          status = s.status
        } catch {
          // ignore
        }
        try {
          picture = await client.profile.getProfilePicture(meJid, 'preview')
        } catch {
          // ignore
        }
      }
      return {
        profile: {
          meJid,
          status,
          picture,
          credentials: {
            meJid: creds?.meJid ?? null,
            registered: Boolean(creds?.meJid),
          },
        },
      }
    },
  )

  app.put(
    '/v1/instances/:name/profile/name',
    {
      schema: {
        tags: ['Profile'],
        summary: 'Set push name (display name)',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        params: InstanceNameParams,
        body: z.object({ name: z.string().max(25) }),
      },
    },
    async (request) => {
      const { name } = request.params
      requireInstanceAccess(request, name)
      const body = request.body
      const client = manager.requireRegisteredClient(name)
      await client.profile.setPushName(body.name)
      return { ok: true as const }
    },
  )

  app.put(
    '/v1/instances/:name/profile/status',
    {
      schema: {
        tags: ['Profile'],
        summary: 'Set about status',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        params: InstanceNameParams,
        body: z.object({ status: z.string().max(139) }),
      },
    },
    async (request) => {
      const { name } = request.params
      requireInstanceAccess(request, name)
      const body = request.body
      const client = manager.requireRegisteredClient(name)
      await client.profile.setStatus(body.status)
      return { ok: true as const }
    },
  )

  app.put(
    '/v1/instances/:name/profile/picture',
    {
      schema: {
        tags: ['Profile'],
        summary: 'Set profile picture (JPEG bytes via URL or base64)',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        params: InstanceNameParams,
        body: z.object({
          mediaUrl: z.string().url().optional(),
          mediaBase64: z.string().optional(),
        }),
      },
    },
    async (request) => {
      const { name } = request.params
      requireInstanceAccess(request, name)
      const body = request.body
      const client = manager.requireRegisteredClient(name)
      const media = await resolveMediaToFile(body, env)
      try {
        const bytes = await readFile(media.path)
        const id = await client.profile.setProfilePicture(bytes)
        return { ok: true as const, pictureId: id }
      } finally {
        await media.cleanup()
      }
    },
  )

  app.delete(
    '/v1/instances/:name/profile/picture',
    {
      schema: {
        tags: ['Profile'],
        summary: 'Delete profile picture',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        params: InstanceNameParams,
      },
    },
    async (request) => {
      const { name } = request.params
      requireInstanceAccess(request, name)
      const client = manager.requireRegisteredClient(name)
      await client.profile.deleteProfilePicture()
      return { ok: true as const }
    },
  )
}
