export type SipCodec = 'alaw' | 'ulaw'

export type SipTransport = 'udp' | 'tcp'

export type SipTrunkConfig = {
  enabled: boolean
  transport: SipTransport
  localHost: string
  localPort: number
  proxyHost: string
  proxyPort: number
  username: string
  password: string
  displayName: string
  realm: string
  codec: SipCodec
  registerExpirySecs: number
  didMapping: Record<string, string>
  defaultDstDid: string | null
}

export type SipRegistrationState = 'unregistered' | 'registering' | 'registered' | 'failed'

export type SipTrunkCallState = 'calling' | 'ringing' | 'answered' | 'ended' | 'failed'

export type SipBridgedCall = {
  id: string
  instanceName: string
  whatsAppCallId: string
  sipCallId: string
  sipDest: string
  direction: 'inbound' | 'outbound'
  state: SipTrunkCallState
  codec: SipCodec
  startedAt: Date
  localSdp: string | null
  remoteSdp: string | null
  rtpLocalPort: number
  rtpRemoteHost: string | null
  rtpRemotePort: number | null
}

export type SipInviteOptions = {
  to: string
  fromDisplayName?: string
  fromUser?: string
  callId?: string
}

export type SipRtpSession = {
  localPort: number
  remoteHost: string
  remotePort: number
  ssrc: number
  seq: number
  timestamp: number
  payloadType: number
  socket: import('node:dgram').Socket
}
