/**
 * SIP trunk REST routes.
 *
 * Endpoints for SIP trunk control and bridging WhatsApp calls to SIP.
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireInstanceAccess } from '~/auth/plugin'
import type { Env } from '~/config/env'
import type { InstanceManager } from '~/instances/manager'
import { asVoipClient } from '~/instances/wa-client'
import { badRequest, notFound } from '~/lib/errors'
import { resolveRecipientJid } from '~/lib/phone-resolve'
import type { CacheClient } from '~/redis/client'
import { SipBridge } from '~/sip/sip-bridge'
import { SipTrunk, type SipTrunkDeps } from '~/sip/sip-trunk'
import type { SipTrunkConfig } from '~/sip/types'
import type { CallStore } from '~/store/calls'

export type SipRoutesDeps = {
  env: Env
  manager: InstanceManager
  calls?: CallStore
  cache?: CacheClient
}

const SipBridgeBody = z.object({
  to: z.string().describe('WhatsApp phone number (e.g. 5511999999999)'),
  sipDest: z.string().describe('SIP URI to bridge to (e.g. sip:+5511999999999@trunk.example.com)'),
})

const InstanceNameParams = z.object({
  name: z.string().describe('WhatsApp instance name'),
})

type InstanceParams = { Params: z.infer<typeof InstanceNameParams> }

let sipTrunk: SipTrunk | null = null
let sipBridge: SipBridge | null = null

/** Build the SIP trunk config from environment. Call after parseEnv. */
export function buildSipTrunkConfig(env: Env): SipTrunkConfig {
  return {
    enabled: env.SIP_TRUNK_ENABLED,
    transport: env.SIP_TRANSPORT,
    localHost: env.SIP_LOCAL_HOST,
    localPort: env.SIP_LOCAL_PORT,
    proxyHost: env.SIP_PROXY_HOST,
    proxyPort: env.SIP_PROXY_PORT,
    username: env.SIP_USERNAME,
    password: env.SIP_PASSWORD,
    displayName: env.SIP_DISPLAY_NAME,
    realm: env.SIP_REALM,
    codec: env.SIP_CODEC,
    registerExpirySecs: env.SIP_REGISTER_EXPIRY_SECS,
    didMapping: parseDidMapping(env.SIP_DID_MAPPING),
    defaultDstDid: env.SIP_DEFAULT_DST_DID || null,
  }
}

function parseDidMapping(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  const map: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const [did, phone] = pair.split('=')
    if (did && phone) {
      map[did.trim()] = phone.trim()
    }
  }
  return map
}

export function getSipTrunk(): SipTrunk | null {
  return sipTrunk
}

export function getSipBridge(): SipBridge | null {
  return sipBridge
}

export const sipRoutes: FastifyPluginAsync<SipRoutesDeps> = async (app, deps) => {
  const { env, manager, calls, cache } = deps

  if (!env.SIP_TRUNK_ENABLED) return

  const config = buildSipTrunkConfig(env)

  sipBridge = new SipBridge({ manager })

  const trunkDeps: SipTrunkDeps = {
    config,
    manager,
    calls,
    bridgeAudio: (bridged) => (sipBridge as SipBridge).startBridge(bridged),
    teardownBridge: (callId) => (sipBridge as SipBridge).stopBridge(callId),
  }

  sipTrunk = new SipTrunk(trunkDeps)

  const trunk = sipTrunk
  const bridge = sipBridge

  // Start SIP trunk after routes registered
  setImmediate(() => {
    trunk.start().catch((err) => {
      app.log.error({ err }, 'sip trunk start failed')
    })
  })

  // Graceful shutdown
  app.addHook('onClose', async () => {
    await trunk.stop()
  })

  // ── Status ──────────────────────────────────────────────────────────────

  app.get(
    '/v1/sip/status',
    {
      schema: {
        tags: ['SIP'],
        summary: 'Get SIP trunk status',
        description: 'Returns registration state, local address, and active bridged calls.',
      },
    },
    async () => {
      return {
        enabled: true,
        registrationState: trunk.registrationState,
        localHost: trunk.localHost,
        localPort: trunk.localPort,
        activeBridges: bridge.getActiveBridges(),
        activeBridgeCount: bridge.getActiveBridges().length,
      }
    },
  )

  // ── Bridge outbound WhatsApp → SIP ─────────────────────────────────────

  app.post<InstanceParams & { Body: z.infer<typeof SipBridgeBody> }>(
    '/v1/instances/:name/calls/sip',
    {
      schema: {
        tags: ['SIP'],
        summary: 'Bridge WhatsApp call to SIP trunk',
        description:
          'Starts a WhatsApp call to `to` and bridges it to the SIP destination `sipDest`.\n\n' +
          'The WhatsApp call is started first, then a SIP INVITE is sent to the trunk. ' +
          'When both sides answer, audio is bridged bidirectionally (Float32 16kHz ↔ G.711).\n\n' +
          '```json\n' +
          '{"to": "5511999999999", "sipDest": "sip:+5511999999999@trunk.example.com"}\n' +
          '```',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        params: InstanceNameParams,
        body: SipBridgeBody,
      },
    },
    async (request) => {
      const { name } = request.params
      requireInstanceAccess(request, name)

      if (!sipTrunk || !sipBridge) {
        throw badRequest('SIP trunk not enabled')
      }

      const body = request.body

      try {
        const client = asVoipClient(manager.requireRegisteredClient(name))
        const peerJid = await resolveRecipientJid(client, body.to, cache)
        const whatsAppCallId = await client.voip.startCall({ peerJid })
        try {
          client.voip.setExternalAudioMode(whatsAppCallId, true)
        } catch {
          /* */
        }

        const result = await sipTrunk.bridgeWhatsAppToSip(name, whatsAppCallId, body.sipDest)

        return {
          bridgeId: result.bridgeId,
          whatsAppCallId,
          sipCallId: result.sipCallId,
          direction: 'outbound',
        }
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : 'Failed to bridge call to SIP')
      }
    },
  )

  // ── End SIP bridged call ───────────────────────────────────────────────

  app.post<{ Params: { bridgeId: string } }>(
    '/v1/sip/bridges/:bridgeId/end',
    {
      schema: {
        tags: ['SIP'],
        summary: 'End a SIP bridged call',
        description: 'Sends SIP BYE and ends the WhatsApp call.',
        security: [{ apiKey: [] }, { bearerAuth: [] }],
        params: z.object({ bridgeId: z.string().describe('Bridge ID') }),
      },
    },
    async (request) => {
      const { bridgeId } = request.params

      if (!sipTrunk || !sipBridge) {
        throw badRequest('SIP trunk not enabled')
      }

      const bridged = sipTrunk.getBridgedCall(bridgeId)
      if (!bridged) {
        throw notFound(`bridge ${bridgeId} not found`)
      }

      await sipBridge.stopBridge(bridgeId)

      try {
        const client = asVoipClient(manager.requireRegisteredClient(bridged.instanceName))
        await client.voip.endCall(bridged.whatsAppCallId)
      } catch {
        /* ignore */
      }

      return { ok: true as const }
    },
  )
}
