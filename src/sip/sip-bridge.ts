/**
 * Audio bridge: WhatsApp Float32 PCM 16kHz mono ↔ SIP G.711 RTP.
 *
 * Binds WhatsApp VoIP events and RTP socket for bidirectional audio relay.
 * Does not use WebSocket — connects directly to the WaClient VoIP surface.
 */

import type { InstanceManager } from '~/instances/manager'
import { asVoipClient } from '~/instances/wa-client'
import { getLogger } from '~/lib/logger'
import { decodeG711ToPcm, encodePcmToG711 } from './codec'
import { closeRtp, createRtpSession, openRtpSocket, sendRtp } from './rtp'
import type { SipBridgedCall, SipRtpSession } from './types'

export type SipBridgeDeps = {
  manager: InstanceManager
}

type ActiveBridge = {
  bridged: SipBridgedCall
  rtpSession: SipRtpSession
  cleanup: () => void
}

export class SipBridge {
  private manager: InstanceManager
  private activeBridges = new Map<string, ActiveBridge>()
  private log = getLogger({ component: 'sip-bridge' })

  constructor(deps: SipBridgeDeps) {
    this.manager = deps.manager
  }

  /**
   * Start bridging audio between a WhatsApp call and SIP RTP endpoint.
   * Called by SipTrunk when both legs are answered.
   */
  async startBridge(bridged: SipBridgedCall): Promise<void> {
    if (this.activeBridges.has(bridged.id)) {
      this.log.warn({ bridgeId: bridged.id }, 'bridge already active')
      return
    }

    const { instanceName, whatsAppCallId, rtpRemoteHost, rtpRemotePort, codec } = bridged
    if (!rtpRemoteHost || !rtpRemotePort) {
      this.log.error({ bridgeId: bridged.id }, 'missing rtp remote info')
      return
    }

    let client: ReturnType<typeof asVoipClient>
    try {
      client = asVoipClient(this.manager.requireRegisteredClient(instanceName))
    } catch (err) {
      this.log.error({ err, instanceName }, 'instance not available for bridge')
      return
    }

    // Verify WhatsApp call is still alive
    const call = client.voip.getCall(whatsAppCallId)
    if (!call) {
      this.log.error({ whatsAppCallId }, 'whatsapp call not found for bridge')
      return
    }

    // Ensure external audio mode
    client.voip.setExternalAudioMode(whatsAppCallId, true)

    // Open RTP socket
    const rtpSocket = await openRtpSocket()
    const rtpLocalPort = rtpSocket.address().port

    const rtpSession = await createRtpSession(rtpSocket, rtpRemoteHost, rtpRemotePort, codec)

    this.log.info(
      {
        bridgeId: bridged.id,
        whatsAppCallId,
        sipCallId: bridged.sipCallId,
        rtpLocal: rtpLocalPort,
        rtpRemote: `${rtpRemoteHost}:${rtpRemotePort}`,
        codec,
      },
      'sip bridge started',
    )

    // Update bridged call with actual local RTP port
    bridged.rtpLocalPort = rtpLocalPort

    // ── WhatsApp → SIP ──────────────────────────────────────────────────
    const onInbound = ({ call: c, pcm }: { call: { callId?: string }; pcm: Float32Array }) => {
      if (c.callId !== whatsAppCallId) return
      try {
        const payload = encodePcmToG711(pcm, codec)
        sendRtp(rtpSession, payload)
      } catch (err) {
        this.log.warn({ err }, 'encode rtp error')
      }
    }

    // ── SIP → WhatsApp ──────────────────────────────────────────────────
    const onRtpMessage = (buf: Buffer) => {
      if (buf.length < 12) return
      try {
        const samples = decodeG711ToPcm(buf.subarray(12), codec)
        client.voip.feedLiveAudio(whatsAppCallId, samples)
      } catch (err) {
        this.log.warn({ err }, 'decode rtp error')
      }
    }

    // biome-ignore lint/suspicious/noExplicitAny: plugin event map
    ;(client as any).on('voip_call_inbound_audio', onInbound)
    rtpSocket.on('message', onRtpMessage)

    // Watch for WhatsApp call ended
    const onEnded = (c: { callId?: string }) => {
      if (c.callId !== whatsAppCallId) return
      void this.stopBridge(bridged.id)
    }
    // biome-ignore lint/suspicious/noExplicitAny: plugin event map
    ;(client as any).on('voip_call_ended', onEnded)

    const cleanup = () => {
      // biome-ignore lint/suspicious/noExplicitAny: plugin event map
      ;(client as any).off?.('voip_call_inbound_audio', onInbound)
      rtpSocket.removeListener('message', onRtpMessage)
      // biome-ignore lint/suspicious/noExplicitAny: plugin event map
      ;(client as any).off?.('voip_call_ended', onEnded)
      closeRtp(rtpSession)
    }

    this.activeBridges.set(bridged.id, { bridged, rtpSession, cleanup })
  }

  async stopBridge(bridgeId: string): Promise<void> {
    const active = this.activeBridges.get(bridgeId)
    if (!active) return

    active.cleanup()
    this.activeBridges.delete(bridgeId)
    this.log.info({ bridgeId }, 'sip bridge stopped')
  }

  getActiveBridges(): string[] {
    return Array.from(this.activeBridges.keys())
  }

  hasBridge(bridgeId: string): boolean {
    return this.activeBridges.has(bridgeId)
  }
}
