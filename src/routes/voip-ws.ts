/**
 * VoIP control WebSocket — signaling plane (softphone style).
 *
 * URL: ws(s)://host/v1/voip?apiKey=...&instance=optional
 *
 * Protocol: JSON text frames (native WS). Event stream is SSE at GET /v1/events.
 *
 * Client → server:
 * { op: "instance:attach", id, instance }
 * { op: "call:start", id, phone, contactName? }
 * { op: "call:accept", id, callId }
 * { op: "call:reject", id, callId }
 * { op: "call:end", id, callId }
 * { op: "call:mute", id, callId, muted }
 * { op: "ping", id }
 *
 * Server → client:
 * { op: "ready", instance, role }
 * { op: "ack", id, ok: true, data? } | { op: "ack", id, ok: false, code, message }
 * { op: "calls:snapshot", calls: SerializedCall[] }
 * { op: "call:offer" | "call:ringing" | "call:accepted" | "call:state" | "call:ended", call }
 * { op: "device:status", status, meJid? }
 * { op: "pong", id, ts }
 *
 * Audio PCM stays on GET /v1/instances/:name/calls/:callId/stream (separate channel).
 */

import type { FastifyPluginAsync } from 'fastify'
import type { WebSocket } from 'ws'
import { type AuthDeps, resolveActor } from '~/auth/plugin'
import { canAccessInstance, isAdmin } from '~/auth/types'
import type { Env } from '~/config/env'
import { type RealtimeEvent, realtimeBus } from '~/events/bus'
import type { InstanceManager } from '~/instances/manager'
import type { InstanceRepo } from '~/instances/repo'
import { asVoipClient } from '~/instances/wa-client'
import { getLogger } from '~/lib/logger'
import { resolveRecipientJid } from '~/lib/phone-resolve'
import type { CacheClient } from '~/redis/client'
import { resolveLiveCall, type SerializedCall, serializeCallInfo } from '~/voip/call-serialize'
import type { CallRecordingManager } from '~/voip/recording-manager'

export type VoipWsDeps = {
  env: Env
  instanceRepo: InstanceRepo
  manager: InstanceManager
  callRecording?: CallRecordingManager
  cache?: CacheClient
}

type ClientMsg = {
  op?: string
  id?: string
  instance?: string
  phone?: string
  callId?: string
  muted?: boolean
  contactName?: string
}

export const voipWsRoutes: FastifyPluginAsync<VoipWsDeps> = async (app, deps) => {
  const { cache } = deps
  const log = getLogger({ component: 'voip-ws' })
  const authDeps: AuthDeps = { env: deps.env, instanceRepo: deps.instanceRepo }
  const { manager, callRecording } = deps

  app.get(
    '/v1/voip',
    {
      websocket: true,
      schema: {
        tags: ['Calls'],
        summary: 'VoIP control WebSocket (signaling)',
        description:
          'Control plane for softphone (softphone style). Auth via `?apiKey=`. ' +
          'Attach an instance, then receive `call:offer` / `call:state` / `call:ended` push events. ' +
          'PCM audio remains on `.../calls/:callId/stream`.',
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: fastify websocket
    async (socket: WebSocket, request: any) => {
      const q = request.query as { apiKey?: string; instance?: string }
      const apiKey =
        q.apiKey || (typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : null)

      if (!apiKey) {
        socket.send(JSON.stringify({ op: 'error', code: 'UNAUTHORIZED', message: 'Missing apiKey' }))
        socket.close()
        return
      }

      const actor = await resolveActor(authDeps, apiKey)
      if (!actor) {
        socket.send(JSON.stringify({ op: 'error', code: 'UNAUTHORIZED', message: 'Invalid apiKey' }))
        socket.close()
        return
      }

      let attached: string | null =
        actor.role === 'instance'
          ? actor.instanceName
          : q.instance && canAccessInstance(actor, q.instance)
            ? q.instance
            : null

      if (attached && !canAccessInstance(actor, attached)) {
        socket.send(JSON.stringify({ op: 'error', code: 'FORBIDDEN', message: 'Forbidden instance' }))
        socket.close()
        return
      }

      let unsub: (() => void) | null = null

      const send = (payload: unknown) => {
        if (socket.readyState === socket.OPEN) {
          try {
            socket.send(JSON.stringify(payload))
          } catch {
            /* closed */
          }
        }
      }

      const ackOk = (id: string | undefined, data?: unknown) => {
        if (!id) return
        send({ op: 'ack', id, ok: true, data })
      }
      const ackErr = (id: string | undefined, code: string, message: string) => {
        if (!id) return
        send({ op: 'ack', id, ok: false, code, message })
      }

      const snapshotCalls = (instanceName: string): SerializedCall[] => {
        try {
          const client = asVoipClient(manager.getClient(instanceName))
          return client.voip.getCalls().map((c) => serializeCallInfo(c))
        } catch {
          return []
        }
      }

      const deviceStatus = async (instanceName: string) => {
        try {
          const inst = await manager.get(instanceName)
          return { status: inst.status, meJid: inst.meJid }
        } catch {
          return { status: 'unknown', meJid: null as string | null }
        }
      }

      const bindBus = (instanceName: string) => {
        unsub?.()
        unsub = realtimeBus.onInstance(instanceName, (payload: RealtimeEvent) => {
          if (payload.event === 'call.incoming') {
            send({ op: 'call:offer', call: payload.data, eventId: payload.eventId })
            return
          }
          if (payload.event === 'call.state') {
            // biome-ignore lint/suspicious/noExplicitAny: call payload
            const call = payload.data as any
            const state = String(call?.state ?? '')
            if (state === 'ringing' || call?.isRinging) {
              send({ op: 'call:ringing', call, eventId: payload.eventId })
            } else if (state === 'connecting' || state === 'active' || call?.isActive) {
              send({ op: 'call:accepted', call, eventId: payload.eventId })
            }
            send({ op: 'call:state', call, eventId: payload.eventId })
            return
          }
          if (payload.event === 'call.ended') {
            send({ op: 'call:ended', call: payload.data, eventId: payload.eventId })
            return
          }
          if (payload.event === 'instance.connection' || payload.event === 'instance.paired') {
            // biome-ignore lint/suspicious/noExplicitAny: connection payload
            const d = payload.data as any
            send({
              op: 'device:status',
              status: (d?.status ?? d?.registered) ? 'open' : 'close',
              meJid: d?.meJid ?? null,
              eventId: payload.eventId,
            })
          }
        })
      }

      const doAttach = async (instanceName: string) => {
        if (!canAccessInstance(actor, instanceName) && !isAdmin(actor)) {
          throw new Error('FORBIDDEN')
        }
        // Instance-key actors can only attach their own instance
        if (actor.role === 'instance' && actor.instanceName !== instanceName) {
          throw new Error('FORBIDDEN')
        }
        await manager.get(instanceName) // ensures exists
        attached = instanceName
        bindBus(instanceName)
        const calls = snapshotCalls(instanceName)
        const device = await deviceStatus(instanceName)
        send({ op: 'ready', instance: instanceName, role: actor.role })
        send({ op: 'device:status', ...device })
        send({ op: 'calls:snapshot', calls })
      }

      // Auto-attach if instance known from query / instance key
      if (attached) {
        try {
          await doAttach(attached)
        } catch (err) {
          send({
            op: 'error',
            code: 'ATTACH_FAILED',
            message: err instanceof Error ? err.message : 'attach failed',
          })
        }
      } else {
        send({ op: 'ready', instance: null, role: actor.role })
      }

      socket.on('message', (raw) => {
        void (async () => {
          let msg: ClientMsg
          try {
            msg = JSON.parse(String(raw)) as ClientMsg
          } catch {
            return
          }
          const op = msg.op
          const id = msg.id

          try {
            if (op === 'ping') {
              send({ op: 'pong', id, ts: Date.now() })
              return
            }

            if (op === 'instance:attach') {
              const inst = msg.instance
              if (!inst) {
                ackErr(id, 'INVALID_PAYLOAD', 'instance required')
                return
              }
              await doAttach(inst)
              ackOk(id, { instance: inst })
              return
            }

            if (!attached) {
              ackErr(id, 'NO_INSTANCE', 'attach an instance first')
              return
            }

            if (op === 'calls:list') {
              ackOk(id, { calls: snapshotCalls(attached) })
              return
            }

            if (op === 'call:start') {
              const phone = msg.phone?.trim()
              if (!phone || phone.length < 3) {
                ackErr(id, 'INVALID_PAYLOAD', 'phone required')
                return
              }
              const client = asVoipClient(manager.requireRegisteredClient(attached))
              const peerJid = await resolveRecipientJid(client, phone, cache)
              const callId = await client.voip.startCall({ peerJid })
              // Live mic path — enable before media_connected so capture never
              // starts in "file/silence" mode while waiting for the PCM stream WS.
              try {
                client.voip.setExternalAudioMode(callId, true)
              } catch {
                /* */
              }
              if (callRecording) {
                await callRecording.onCallStarted(attached, {
                  callId,
                  peerJid,
                  direction: 'outbound',
                  mediaType: 'audio',
                  state: 'calling',
                })
              }
              const call = client.voip.getCall(callId)
              // WA may flip peer to @lid immediately — keep dialed PN as display via mappedPn
              const serialized = call
                ? serializeCallInfo(call, { mappedPn: peerJid })
                : {
                    callId,
                    peerJid,
                    peerJidRaw: peerJid,
                    peerLid: null,
                    callerPn: null,
                    direction: 'outgoing' as const,
                    state: 'ringing',
                    isActive: false,
                    isRinging: true,
                    isEnded: false,
                    canAccept: false,
                    acceptBlocked: false,
                    mediaType: 'audio',
                    createdAt: null,
                    audioMuted: undefined,
                    durationSecs: null,
                    endReason: null,
                  }
              ackOk(id, { callId, peerJid: serialized.peerJid ?? peerJid, call: serialized })
              send({ op: 'call:ringing', call: serialized })
              return
            }

            if (op === 'call:accept') {
              const callId = msg.callId
              if (!callId) {
                ackErr(id, 'INVALID_PAYLOAD', 'callId required')
                return
              }
              const client = asVoipClient(manager.requireRegisteredClient(attached))
              const resolved = resolveLiveCall(client, callId)
              if (!resolved) {
                ackErr(id, 'CALL_NOT_FOUND', 'call not found')
                return
              }
              if (!resolved.canAccept) {
                ackErr(
                  id,
                  'CALL_NOT_ACCEPTABLE',
                  `cannot accept in state ${resolved.stateData?.state ?? resolved.state} (direction=${resolved.direction})`,
                )
                return
              }
              // Enable live PCM feed before accept so media_connected starts external capture
              try {
                client.voip.setExternalAudioMode(resolved.callId, true)
              } catch {
                /* */
              }
              await client.voip.acceptCall(resolved.callId)
              const after = client.voip.getCall(resolved.callId)
              const serialized = after ? serializeCallInfo(after) : serializeCallInfo(resolved)
              ackOk(id, { callId: resolved.callId, call: serialized })
              send({ op: 'call:accepted', call: serialized })
              return
            }

            if (op === 'call:reject') {
              const callId = msg.callId
              if (!callId) {
                ackErr(id, 'INVALID_PAYLOAD', 'callId required')
                return
              }
              const client = asVoipClient(manager.requireRegisteredClient(attached))
              const resolved = resolveLiveCall(client, callId)
              if (!resolved) {
                ackErr(id, 'CALL_NOT_FOUND', 'call not found')
                return
              }
              await client.voip.rejectCall(resolved.callId)
              ackOk(id, { callId: resolved.callId })
              send({
                op: 'call:ended',
                call: { ...serializeCallInfo(resolved), state: 'ended', isEnded: true },
              })
              return
            }

            if (op === 'call:end') {
              const callId = msg.callId
              if (!callId) {
                ackErr(id, 'INVALID_PAYLOAD', 'callId required')
                return
              }
              const client = asVoipClient(manager.requireRegisteredClient(attached))
              const resolved = resolveLiveCall(client, callId)
              if (!resolved) {
                // already gone — treat as success
                ackOk(id, { callId })
                return
              }
              await client.voip.endCall(resolved.callId)
              ackOk(id, { callId: resolved.callId })
              return
            }

            if (op === 'call:mute') {
              const callId = msg.callId
              if (!callId || typeof msg.muted !== 'boolean') {
                ackErr(id, 'INVALID_PAYLOAD', 'callId + muted required')
                return
              }
              const client = asVoipClient(manager.requireRegisteredClient(attached))
              const resolved = resolveLiveCall(client, callId)
              if (!resolved) {
                ackErr(id, 'CALL_NOT_FOUND', 'call not found')
                return
              }
              client.voip.setMute(resolved.callId, msg.muted)
              ackOk(id, { callId: resolved.callId, muted: msg.muted })
              return
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : 'internal error'
            log.warn({ err, op, instance: attached }, 'voip-ws command failed')
            if (message === 'FORBIDDEN') {
              ackErr(id, 'FORBIDDEN', 'forbidden')
            } else {
              ackErr(id, 'CALL_FAILED', message)
            }
          }
        })
      })

      socket.on('close', () => {
        unsub?.()
      })
      socket.on('error', () => {
        unsub?.()
      })

      const ping = setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          try {
            socket.ping()
          } catch {
            /* */
          }
        }
      }, 30_000)
      ping.unref?.()
      socket.on('close', () => clearInterval(ping))
    },
  )
}
