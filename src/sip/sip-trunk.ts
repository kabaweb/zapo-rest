/**
 * SIP trunk manager.
 *
 * Owns the SipTransport + SipClient lifecycle.
 * Manages inbound/outbound SIP ↔ WhatsApp call coordination.
 * Talks to InstanceManager for WhatsApp call control.
 */

import { createSocket } from 'node:dgram'
import type { InstanceManager } from '~/instances/manager'
import { asVoipClient } from '~/instances/wa-client'
import { getLogger } from '~/lib/logger'
import type { CallStore } from '~/store/calls'
import { type IncomingSipCall, SipClient } from './sip-client'
import { buildSdp } from './sip-message'
import { SipTransport } from './sip-transport'
import type { SipBridgedCall, SipCodec, SipRegistrationState, SipTrunkConfig } from './types'

export type SipTrunkDeps = {
  config: SipTrunkConfig
  manager: InstanceManager
  calls?: CallStore
  bridgeAudio: (bridgedCall: SipBridgedCall) => Promise<void>
  teardownBridge: (callId: string) => Promise<void>
}

export class SipTrunk {
  private config: SipTrunkConfig
  private transport: SipTransport
  private client: SipClient
  private manager: InstanceManager
  private calls?: CallStore
  private bridgeAudio: (bridgedCall: SipBridgedCall) => Promise<void>
  private teardownBridge: (callId: string) => Promise<void>
  private bridgedCalls = new Map<string, SipBridgedCall>()
  private log = getLogger({ component: 'sip-trunk' })

  constructor(deps: SipTrunkDeps) {
    this.config = deps.config
    this.transport = new SipTransport()
    this.manager = deps.manager
    this.calls = deps.calls
    this.bridgeAudio = deps.bridgeAudio
    this.teardownBridge = deps.teardownBridge

    this.client = new SipClient(this.config, this.transport, {
      onRegisterState: (state) => {
        this.log.info({ state }, 'sip registration state')
      },
      onIncomingCall: (call) => this.handleIncomingCall(call),
      onCallRinging: (callId) => {
        this.log.info({ callId }, 'sip call ringing')
      },
      onCallAnswered: (callId, sdp) => {
        this.log.info({ callId }, 'sip call answered')
        void this.handleSipAnswered(callId, sdp)
      },
      onCallEnded: (callId) => {
        this.log.info({ callId }, 'sip call ended')
        void this.handleSipEnded(callId)
      },
      onCallFailed: (callId, reason) => {
        this.log.warn({ callId, reason }, 'sip call failed')
        void this.handleSipFailed(callId, reason)
      },
    })
  }

  get registrationState(): SipRegistrationState {
    return this.client.registrationState
  }

  get localHost(): string {
    return this.client.localHost
  }

  get localPort(): number {
    return this.client.localPort
  }

  async start(): Promise<void> {
    await this.transport.bind(this.config.localHost, this.config.localPort)
    this.client.start()
    this.log.info(
      { host: this.config.localHost, port: this.config.localPort, proxy: this.config.proxyHost },
      'sip trunk started',
    )
  }

  async stop(): Promise<void> {
    for (const [callId] of this.bridgedCalls) {
      void this.teardownBridge(callId)
    }
    this.bridgedCalls.clear()
    this.client.stop()
    this.log.info('sip trunk stopped')
  }

  /**
   * Bridge an existing WhatsApp call to a SIP destination.
   * Called from REST: POST /v1/instances/:name/calls/sip
   */
  async bridgeWhatsAppToSip(
    instanceName: string,
    whatsAppCallId: string,
    sipDest: string,
  ): Promise<{ bridgeId: string; sipCallId: string }> {
    const client = asVoipClient(this.manager.requireRegisteredClient(instanceName))
    const snap = client.voip.getCall(whatsAppCallId)
    if (!snap) throw new Error(`WhatsApp call ${whatsAppCallId} not found`)

    const bridgeId = whatsAppCallId
    const codec: SipCodec = this.config.codec

    // Open RTP socket + create SDP
    const rtpSocket = createSocket('udp4')
    const rtpPort = await new Promise<number>((resolve, reject) => {
      rtpSocket.on('error', reject)
      rtpSocket.bind(0, () => {
        rtpSocket.removeListener('error', reject)
        resolve(rtpSocket.address().port)
      })
    })

    const sdp = buildSdp({
      localIp: this.config.localHost,
      audioPort: rtpPort,
      codec,
    })

    const sipCallId = this.client.invite(sipDest, sdp, codec)
    rtpSocket.close()

    const bridged: SipBridgedCall = {
      id: bridgeId,
      instanceName,
      whatsAppCallId,
      sipCallId,
      sipDest,
      direction: 'outbound',
      state: 'calling',
      codec,
      startedAt: new Date(),
      localSdp: sdp,
      remoteSdp: null,
      rtpLocalPort: rtpPort,
      rtpRemoteHost: null,
      rtpRemotePort: null,
    }

    this.bridgedCalls.set(sipCallId, bridged)
    this.bridgedCalls.set(whatsAppCallId, bridged)

    // Persist history
    if (this.calls) {
      await this.calls.upsertStart({
        instanceName,
        callId: whatsAppCallId,
        peerJid: sipDest,
        direction: 'outbound',
        mediaType: 'audio',
        state: 'calling',
      })
    }

    return { bridgeId, sipCallId }
  }

  // ── SIP event handlers ───────────────────────────────────────────────────

  private async handleIncomingCall(call: IncomingSipCall): Promise<boolean> {
    // Check DID mapping to find the target WhatsApp instance + number
    const toUser = call.toUri.split('@')[0] ?? ''
    const targetPhone = this.config.didMapping[toUser]

    if (!targetPhone && !this.config.defaultDstDid) {
      this.log.warn({ toUri: call.toUri, toUser }, 'no DID mapping for incoming sip call')
      this.client.sendDecline(call, call.cseq)
      return false
    }

    // Try to find an instance that can make the call
    // Use the first open instance as the gateway
    const rows = await this.manager.list()
    const gateway = rows.find((i) => i.status === 'open')
    if (!gateway) {
      this.log.warn('no open WhatsApp instance for incoming sip call')
      this.client.sendDecline(call, call.cseq)
      return false
    }

    try {
      const dstPhone = targetPhone || this.config.defaultDstDid || ''
      const client = asVoipClient(this.manager.requireRegisteredClient(gateway.name))
      const peerJid = dstPhone.includes('@') ? dstPhone : `${dstPhone}@s.whatsapp.net`

      this.log.info(
        { from: call.fromUri, to: call.toUri, dstPhone, instance: gateway.name },
        'bridging incoming sip to whatsapp',
      )

      // Start WhatsApp call
      const whatsAppCallId = await client.voip.startCall({ peerJid })
      client.voip.setExternalAudioMode(whatsAppCallId, true)

      // Send ringing to SIP caller
      this.client.sendRinging(call, call.cseq)

      // Store the bridged call
      const bridged: SipBridgedCall = {
        id: call.callId,
        instanceName: gateway.name,
        whatsAppCallId,
        sipCallId: call.callId,
        sipDest: call.fromUri,
        direction: 'inbound',
        state: 'ringing',
        codec: this.config.codec,
        startedAt: new Date(),
        localSdp: null,
        remoteSdp: call.sdp.media[0]?.ip
          ? `c=IN IP4 ${call.sdp.media[0].ip} m=audio ${call.sdp.media[0].port} RTP/AVP 8`
          : null,
        rtpLocalPort: 0,
        rtpRemoteHost: call.sdp.media[0]?.ip ?? null,
        rtpRemotePort: call.sdp.media[0]?.port ?? null,
      }

      this.bridgedCalls.set(call.callId, bridged)
      this.bridgedCalls.set(whatsAppCallId, bridged)

      // Wait for WhatsApp to answer, then send 200 OK to SIP
      void this.waitForWhatsAppAnswer(gateway.name, whatsAppCallId, call, bridged)

      return true
    } catch (err) {
      this.log.error({ err }, 'failed to bridge incoming sip to whatsapp')
      this.client.sendDecline(call, call.cseq)
      return false
    }
  }

  private async waitForWhatsAppAnswer(
    instanceName: string,
    whatsAppCallId: string,
    sipCall: IncomingSipCall,
    bridged: SipBridgedCall,
  ): Promise<void> {
    const client = asVoipClient(this.manager.requireRegisteredClient(instanceName))

    // Poll for answered state
    const maxWaitMs = 30_000
    const pollMs = 500
    let waited = 0

    while (waited < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollMs))
      waited += pollMs

      const c = client.voip.getCall(whatsAppCallId)
      if (!c) {
        this.log.warn({ whatsAppCallId }, 'whatsapp call disappeared during wait')
        this.client.sendDecline(sipCall, sipCall.cseq)
        return
      }

      const state = (c as { stateData?: { state?: string } }).stateData?.state
      if (state === 'active' || state === 'connecting') {
        break
      }
      if (state === 'ended' || state === 'failed') {
        this.client.sendDecline(sipCall, sipCall.cseq)
        return
      }
    }

    // Open RTP socket for the bridge
    const rtpSocket = createSocket('udp4')
    const rtpPort = await new Promise<number>((resolve, reject) => {
      rtpSocket.on('error', reject)
      rtpSocket.bind(0, () => {
        rtpSocket.removeListener('error', reject)
        resolve(rtpSocket.address().port)
      })
    })
    rtpSocket.close()

    const sdp = buildSdp({
      localIp: this.config.localHost,
      audioPort: rtpPort,
      codec: this.config.codec,
    })

    bridged.rtpLocalPort = rtpPort
    bridged.localSdp = sdp
    bridged.state = 'answered'

    // Send 200 OK with SDP
    this.client.sendOk(sipCall, sdp, sipCall.cseq)

    // Start audio bridge
    void this.bridgeAudio(bridged)
  }

  private async handleSipAnswered(sipCallId: string, sdp: { media: { ip: string; port: number }[] }): Promise<void> {
    const bridged = this.bridgedCalls.get(sipCallId)
    if (!bridged) return

    bridged.state = 'answered'
    bridged.remoteSdp = sdp.media[0] ? `c=IN IP4 ${sdp.media[0].ip} m=audio ${sdp.media[0].port} RTP/AVP 8` : null
    bridged.rtpRemoteHost = sdp.media[0]?.ip ?? null
    bridged.rtpRemotePort = sdp.media[0]?.port ?? null

    if (bridged.direction === 'outbound') {
      void this.bridgeAudio(bridged)
    }
  }

  private async handleSipEnded(sipCallId: string): Promise<void> {
    const bridged = this.bridgedCalls.get(sipCallId)
    if (!bridged) return

    this.bridgedCalls.delete(sipCallId)
    this.bridgedCalls.delete(bridged.whatsAppCallId)

    void this.teardownBridge(sipCallId)

    // End WhatsApp call too
    try {
      const client = asVoipClient(this.manager.requireRegisteredClient(bridged.instanceName))
      await client.voip.endCall(bridged.whatsAppCallId)
    } catch {
      /* ignore */
    }
  }

  private async handleSipFailed(sipCallId: string, reason: string): Promise<void> {
    const bridged = this.bridgedCalls.get(sipCallId)
    if (!bridged) return

    bridged.state = 'failed'
    this.log.warn({ sipCallId, reason }, 'sip call failed')

    // End WhatsApp call
    try {
      const client = asVoipClient(this.manager.requireRegisteredClient(bridged.instanceName))
      await client.voip.endCall(bridged.whatsAppCallId)
    } catch {
      /* ignore */
    }

    this.bridgedCalls.delete(sipCallId)
    this.bridgedCalls.delete(bridged.whatsAppCallId)
    void this.teardownBridge(sipCallId)
  }

  getBridgedCall(key: string): SipBridgedCall | undefined {
    return this.bridgedCalls.get(key)
  }
}
