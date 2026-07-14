/**
 * SIP User Agent client for trunk registration and call handling.
 *
 * Manages REGISTER cycles, INVITE dialogs, and call teardown over a SipTransport.
 */

import type { RemoteInfo } from 'node:dgram'
import {
  buildRequestLine,
  buildSipMessage,
  buildStatusLine,
  extractBranch,
  extractCallId,
  extractCSeq,
  generateBranch,
  generateCallId,
  generateTag,
  parseSdp,
  parseTagFromHeader,
  type Sdp,
  type SipMessage,
} from './sip-message'
import type { SipTransport } from './sip-transport'
import type { SipCodec, SipRegistrationState, SipTrunkConfig } from './types'

export type SipClientEvents = {
  onRegisterState: (state: SipRegistrationState) => void
  onIncomingCall: (call: IncomingSipCall) => Promise<boolean>
  onCallRinging: (callId: string) => void
  onCallAnswered: (callId: string, sdp: Sdp) => void
  onCallEnded: (callId: string) => void
  onCallFailed: (callId: string, reason: string) => void
}

export type IncomingSipCall = {
  callId: string
  fromUri: string
  toUri: string
  fromTag: string
  branch: string
  cseq: number
  sdp: Sdp
}

type PendingCall = {
  callId: string
  destUri: string
  localTag: string
  remoteTag: string | null
  branch: string
  cseq: number
  sdp: string | null
  codec: SipCodec
  contactUri: string
}

type SipResponseHandler = (msg: SipMessage) => void

export class SipClient {
  private config: SipTrunkConfig
  private transport: SipTransport
  private events: SipClientEvents
  private pendingCalls = new Map<string, PendingCall>()
  private responseHandlers = new Map<string, SipResponseHandler>()
  private registerTimer: ReturnType<typeof setInterval> | null = null
  private cseqBase = Math.floor(Math.random() * 10000) + 1
  private localTag = generateTag()
  private _registrationState: SipRegistrationState = 'unregistered'

  get registrationState(): SipRegistrationState {
    return this._registrationState
  }

  get localHost(): string {
    return this.config.localHost
  }

  get localPort(): number {
    return this.config.localPort
  }

  constructor(config: SipTrunkConfig, transport: SipTransport, events: SipClientEvents) {
    this.config = config
    this.transport = transport
    this.events = events
  }

  start(): void {
    this.transport.onEvent((event) => {
      if (event.type === 'message') {
        this.handleMessage(event.msg, event.rinfo)
      }
      if (event.type === 'close') {
        this.stopRegister()
      }
    })
    this.startRegister()
  }

  stop(): void {
    this.stopRegister()
    this.unregister().catch(() => {})
    this.transport.close()
    this.responseHandlers.clear()
    this.pendingCalls.clear()
  }

  // ── Registration ──────────────────────────────────────────────────────────

  private startRegister(): void {
    this.register().catch(() => {})
    const interval = (this.config.registerExpirySecs * 1000) / 2
    this.registerTimer = setInterval(() => {
      this.register().catch(() => {})
    }, interval)
    this.registerTimer.unref?.()
  }

  private stopRegister(): void {
    if (this.registerTimer) {
      clearInterval(this.registerTimer)
      this.registerTimer = null
    }
  }

  private setRegisterState(state: SipRegistrationState): void {
    this._registrationState = state
    this.events.onRegisterState(state)
  }

  async register(): Promise<void> {
    this.setRegisterState('registering')
    const branch = generateBranch()
    const callId = generateCallId(this.config.localHost)
    const cseq = this.nextCseq()
    const fromUri = `sip:${this.config.username}@${this.config.realm}`
    const toUri = fromUri
    const contactUri = `sip:${this.config.username}@${this.config.localHost}:${this.config.localPort}`
    const proxyUri = `${this.config.proxyHost}:${this.config.proxyPort}`

    const msg = buildSipMessage({
      startLine: buildRequestLine('REGISTER', `sip:${this.config.realm}`),
      headers: {
        Via: `SIP/2.0/UDP ${this.config.localHost}:${this.config.localPort};branch=${branch}`,
        'Max-Forwards': '70',
        From: `"${this.config.displayName}" <${fromUri}>;tag=${this.localTag}`,
        To: `"${this.config.displayName}" <${toUri}>`,
        'Call-ID': callId,
        CSeq: `${cseq} REGISTER`,
        Contact: `<${contactUri}>`,
        Expires: String(this.config.registerExpirySecs),
        Allow: 'INVITE,ACK,BYE,CANCEL',
        'User-Agent': 'zapo-rest-sip/1.0',
      },
    })

    await this.sendWithResponse(msg, proxyUri, (response) => {
      if (response.statusCode === 200 || response.statusCode === 401 || response.statusCode === 407) {
        this.setRegisterState('registered')
        return
      }
      this.setRegisterState('failed')
    })
  }

  async unregister(): Promise<void> {
    const branch = generateBranch()
    const callId = generateCallId(this.config.localHost)
    const cseq = this.nextCseq()
    const contactUri = `sip:${this.config.username}@${this.config.localHost}:${this.config.localPort}`
    const proxyUri = `${this.config.proxyHost}:${this.config.proxyPort}`

    const msg = buildSipMessage({
      startLine: buildRequestLine('REGISTER', `sip:${this.config.realm}`),
      headers: {
        Via: `SIP/2.0/UDP ${this.config.localHost}:${this.config.localPort};branch=${branch}`,
        'Max-Forwards': '70',
        From: `"${this.config.displayName}" <sip:${this.config.username}@${this.config.realm}>;tag=${this.localTag}`,
        To: `"${this.config.displayName}" <sip:${this.config.username}@${this.config.realm}>`,
        'Call-ID': callId,
        CSeq: `${cseq} REGISTER`,
        Contact: `<${contactUri}>;expires=0`,
        Expires: '0',
      },
    })

    this.transport.send(msg, proxyUri.split(':')[0] ?? this.config.proxyHost, this.config.proxyPort)
    this.setRegisterState('unregistered')
  }

  // ── Outbound Call ─────────────────────────────────────────────────────────

  invite(destUri: string, sdpBody: string, codec: SipCodec): string {
    const callId = generateCallId(this.config.localHost)
    const branch = generateBranch()
    const localTag = generateTag()
    const cseq = this.nextCseq()
    const fromUri = `sip:${this.config.username}@${this.config.realm}`
    const contactUri = `sip:${this.config.username}@${this.config.localHost}:${this.config.localPort}`

    this.pendingCalls.set(callId, {
      callId,
      destUri,
      localTag,
      remoteTag: null,
      branch,
      cseq,
      sdp: sdpBody,
      codec,
      contactUri,
    })

    const msg = buildSipMessage({
      startLine: buildRequestLine('INVITE', destUri),
      headers: {
        Via: `SIP/2.0/UDP ${this.config.localHost}:${this.config.localPort};branch=${branch}`,
        'Max-Forwards': '70',
        From: `"${this.config.displayName}" <${fromUri}>;tag=${localTag}`,
        To: `<${destUri}>`,
        'Call-ID': callId,
        CSeq: `${cseq} INVITE`,
        Contact: `<${contactUri}>`,
        'Content-Type': 'application/sdp',
        Allow: 'INVITE,ACK,BYE,CANCEL',
      },
      body: sdpBody,
    })

    this.transport.send(msg, this.config.proxyHost, this.config.proxyPort)
    return callId
  }

  ack(callId: string): void {
    const call = this.pendingCalls.get(callId)
    if (!call || !call.remoteTag) return

    const ackCseq = call.cseq
    const msg = buildSipMessage({
      startLine: buildRequestLine('ACK', call.destUri),
      headers: {
        Via: `SIP/2.0/UDP ${this.config.localHost}:${this.config.localPort};branch=${generateBranch()}`,
        'Max-Forwards': '70',
        From: `"${this.config.displayName}" <sip:${this.config.username}@${this.config.realm}>;tag=${call.localTag}`,
        To: `<${call.destUri}>;tag=${call.remoteTag}`,
        'Call-ID': callId,
        CSeq: `${ackCseq} ACK`,
      },
    })

    this.transport.send(msg, this.config.proxyHost, this.config.proxyPort)
  }

  bye(callId: string): void {
    const call = this.pendingCalls.get(callId)
    if (!call) return

    const cseq = this.nextCseq()
    const msg = buildSipMessage({
      startLine: buildRequestLine('BYE', call.destUri),
      headers: {
        Via: `SIP/2.0/UDP ${this.config.localHost}:${this.config.localPort};branch=${generateBranch()}`,
        'Max-Forwards': '70',
        From: `"${this.config.displayName}" <sip:${this.config.username}@${this.config.realm}>;tag=${call.localTag}`,
        To: `<${call.destUri}>${call.remoteTag ? `;tag=${call.remoteTag}` : ''}`,
        'Call-ID': callId,
        CSeq: `${cseq} BYE`,
      },
    })

    this.transport.send(msg, this.config.proxyHost, this.config.proxyPort)
  }

  cancel(callId: string): void {
    const call = this.pendingCalls.get(callId)
    if (!call) return

    const msg = buildSipMessage({
      startLine: buildRequestLine('CANCEL', call.destUri),
      headers: {
        Via: `SIP/2.0/UDP ${this.config.localHost}:${this.config.localPort};branch=${call.branch}`,
        'Max-Forwards': '70',
        From: `"${this.config.displayName}" <sip:${this.config.username}@${this.config.realm}>;tag=${call.localTag}`,
        To: `<${call.destUri}>`,
        'Call-ID': callId,
        CSeq: `${call.cseq} CANCEL`,
      },
    })

    this.transport.send(msg, this.config.proxyHost, this.config.proxyPort)
  }

  // ── Inbound Call Response ─────────────────────────────────────────────────

  sendRinging(incoming: IncomingSipCall, cseq: number): void {
    const msg = buildSipMessage({
      startLine: buildStatusLine(180, 'Ringing'),
      headers: this.responseHeaders(incoming, cseq),
    })
    this.transport.send(msg, this.config.proxyHost, this.config.proxyPort)
  }

  sendOk(incoming: IncomingSipCall, sdpBody: string, cseq: number): void {
    const contactUri = `sip:${this.config.username}@${this.config.localHost}:${this.config.localPort}`
    const msg = buildSipMessage({
      startLine: buildStatusLine(200, 'OK'),
      headers: {
        ...this.responseHeaders(incoming, cseq),
        Contact: `<${contactUri}>`,
        'Content-Type': 'application/sdp',
      },
      body: sdpBody,
    })
    this.transport.send(msg, this.config.proxyHost, this.config.proxyPort)
  }

  sendBusyHere(incoming: IncomingSipCall, cseq: number): void {
    const msg = buildSipMessage({
      startLine: buildStatusLine(486, 'Busy Here'),
      headers: this.responseHeaders(incoming, cseq),
    })
    this.transport.send(msg, this.config.proxyHost, this.config.proxyPort)
  }

  sendDecline(incoming: IncomingSipCall, cseq: number): void {
    const msg = buildSipMessage({
      startLine: buildStatusLine(603, 'Decline'),
      headers: this.responseHeaders(incoming, cseq),
    })
    this.transport.send(msg, this.config.proxyHost, this.config.proxyPort)
  }

  removeCall(callId: string): void {
    this.pendingCalls.delete(callId)
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private handleMessage(msg: SipMessage, rinfo: RemoteInfo): void {
    if (msg.type === 'request') {
      this.handleRequest(msg, rinfo)
    } else {
      this.handleResponse(msg)
    }
  }

  private handleRequest(msg: SipMessage, rinfo: RemoteInfo): void {
    const method = msg.method

    if (method === 'INVITE') {
      this.handleInviteRequest(msg)
      return
    }

    if (method === 'ACK') {
      const callId = extractCallId(msg.headers)
      const call = this.pendingCalls.get(callId)
      if (!call) return
      this.events.onCallAnswered(callId, { sessionId: '', originAddress: '', connectionAddress: '0.0.0.0', media: [] })
      return
    }

    if (method === 'BYE') {
      const callId = extractCallId(msg.headers)
      // Send 200 OK
      const viaHeader = msg.headers['via']
      const branch = extractBranch(viaHeader)
      const toHeader = msg.headers['to'] ?? ''
      const fromHeader = msg.headers['from'] ?? ''
      const cseqHeader = msg.headers['cseq'] ?? '0 BYE'

      const okMsg = buildSipMessage({
        startLine: buildStatusLine(200, 'OK'),
        headers: {
          Via: `SIP/2.0/UDP ${this.config.localHost}:${this.config.localPort};branch=${branch ?? ''}`,
          From: toHeader,
          To: fromHeader,
          'Call-ID': callId,
          CSeq: cseqHeader,
        },
      })
      this.transport.send(okMsg, this.config.proxyHost, this.config.proxyPort)

      this.pendingCalls.delete(callId)
      this.events.onCallEnded(callId)
      return
    }

    if (method === 'CANCEL') {
      const callId = extractCallId(msg.headers)
      // 200 OK for CANCEL
      const okMsg = buildSipMessage({
        startLine: buildStatusLine(200, 'OK'),
        headers: {
          Via: `SIP/2.0/UDP ${this.config.localHost}:${this.config.localPort};branch=${extractBranch(msg.headers['via'])}`,
          From: msg.headers['from'] ?? '',
          To: msg.headers['to'] ?? '',
          'Call-ID': callId,
          CSeq: msg.headers['cseq'] ?? '0 CANCEL',
        },
      })
      this.transport.send(okMsg, this.config.proxyHost, this.config.proxyPort)
      this.pendingCalls.delete(callId)
      this.events.onCallEnded(callId)
      return
    }
  }

  private handleInviteRequest(msg: SipMessage): void {
    const callId = extractCallId(msg.headers)
    const fromHeader = msg.headers['from'] ?? ''
    const toHeader = msg.headers['to'] ?? ''
    const viaHeader = msg.headers['via']
    const branch = extractBranch(viaHeader)
    const fromTag = parseTagFromHeader(fromHeader, 'tag')
    const fromUri = fromHeader.match(/<([^>]+)>|sip:([^\s;>]+)/)?.[1] ?? fromHeader.match(/sip:([^\s;>]+)/)?.[2] ?? ''
    const cseqRaw = extractCSeq(msg.headers)

    if (!branch) return

    let sdp: Sdp | null = null
    if (msg.body) {
      sdp = parseSdp(msg.body)
    }

    if (!sdp || sdp.media.length === 0) {
      // No valid SDP — decline
      const declineMsg = buildSipMessage({
        startLine: buildStatusLine(488, 'Not Acceptable Here'),
        headers: {
          Via: `SIP/2.0/UDP ${this.config.localHost}:${this.config.localPort};branch=${branch}`,
          From: fromHeader,
          To: toHeader,
          'Call-ID': callId,
          CSeq: msg.headers['cseq'] ?? '0 INVITE',
        },
      })
      this.transport.send(declineMsg, this.config.proxyHost, this.config.proxyPort)
      return
    }

    const incoming: IncomingSipCall = {
      callId,
      fromUri,
      toUri: toHeader.match(/<([^>]+)>|sip:([^\s;>]+)/)?.[1] ?? toHeader.match(/sip:([^\s;>]+)/)?.[2] ?? '',
      fromTag: fromTag ?? '',
      branch,
      cseq: cseqRaw.seq,
      sdp,
    }

    void this.events.onIncomingCall(incoming).then((accepted) => {
      if (!accepted) {
        this.sendBusyHere(incoming, incoming.cseq)
      }
    })
  }

  private handleResponse(msg: SipMessage): void {
    const callId = extractCallId(msg.headers)
    const cseqRaw = extractCSeq(msg.headers)
    const statusCode = msg.statusCode ?? 0

    // REGISTER responses handled via sendWithResponse
    const resKey = `${callId}:${cseqRaw.seq}`

    if (cseqRaw.method === 'INVITE') {
      const call = this.pendingCalls.get(callId)
      if (!call) return

      if (statusCode >= 100 && statusCode < 200) {
        if (statusCode === 180) {
          this.events.onCallRinging(callId)
        }
        return
      }

      if (statusCode >= 200 && statusCode < 300) {
        const toTag = parseTagFromHeader(msg.headers['to'], 'tag')
        call.remoteTag = toTag
        this.ack(callId)

        let sdp: Sdp | null = null
        if (msg.body) {
          sdp = parseSdp(msg.body)
        }

        if (sdp && sdp.media.length > 0) {
          this.events.onCallAnswered(callId, sdp)
        } else {
          this.events.onCallAnswered(callId, {
            sessionId: '',
            originAddress: '',
            connectionAddress: '0.0.0.0',
            media: [],
          })
        }
        return
      }

      if (statusCode >= 400) {
        this.ack(callId)
        this.pendingCalls.delete(callId)
        this.events.onCallFailed(callId, `SIP ${statusCode}`)
        return
      }
    }

    if (cseqRaw.method === 'BYE') {
      this.pendingCalls.delete(callId)
      this.events.onCallEnded(callId)
      return
    }
  }

  private responseHeaders(incoming: IncomingSipCall, cseq: number): Record<string, string> {
    return {
      Via: `SIP/2.0/UDP ${this.config.localHost}:${this.config.localPort};branch=${incoming.branch}`,
      From: `<sip:${incoming.fromUri}>;tag=${incoming.fromTag}`,
      To: `<sip:${incoming.toUri}>;tag=${this.localTag}`,
      'Call-ID': incoming.callId,
      CSeq: `${cseq} INVITE`,
    }
  }

  private nextCseq(): number {
    return ++this.cseqBase
  }

  private sendWithResponse(
    msg: string,
    proxyUri: string,
    handler: SipResponseHandler,
    timeoutMs = 5000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Extract call-id + cseq to match response
      const lines = msg.split('\r\n')
      const callId =
        lines
          .find((l) => l.toLowerCase().startsWith('call-id:'))
          ?.split(':')[1]
          ?.trim() ?? ''
      const cseqRaw =
        lines
          .find((l) => l.toLowerCase().startsWith('cseq:'))
          ?.split(':')[1]
          ?.trim() ?? ''
      const cseqNum = Number.parseInt(cseqRaw ?? '0', 10)
      const resKey = `${callId}:${cseqNum}`

      const timer = setTimeout(() => {
        this.responseHandlers.delete(resKey)
        reject(new Error('SIP request timed out'))
      }, timeoutMs)

      this.responseHandlers.set(resKey, (response) => {
        clearTimeout(timer)
        this.responseHandlers.delete(resKey)
        handler(response)
        resolve()
      })

      const [host, portStr] = proxyUri.split(':')
      this.transport.send(
        msg,
        host ?? this.config.proxyHost,
        Number.parseInt(portStr ?? '0', 10) || this.config.proxyPort,
      )
    })
  }
}
