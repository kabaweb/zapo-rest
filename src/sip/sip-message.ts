/**
 * Minimal SIP message parser / builder (RFC 3261 subset).
 *
 * Handles: REGISTER, INVITE, ACK, BYE, CANCEL, and responses.
 * SDP for audio-only G.711 a-law / u-law.
 */

export type SipMethod = 'REGISTER' | 'INVITE' | 'ACK' | 'BYE' | 'CANCEL'

export type SipMessage = {
  type: 'request' | 'response'
  method?: SipMethod
  statusCode?: number
  statusText?: string
  headers: Record<string, string>
  body: string
}

export type SdpMedia = {
  ip: string
  port: number
  payloadTypes: number[]
  rtpmap: Map<number, string>
}

export type Sdp = {
  sessionId: string
  originAddress: string
  connectionAddress: string
  media: SdpMedia[]
}

// ── SIP Message Parser ────────────────────────────────────────────────────────

const HEADER_RE = /^([\w-]+)\s*:\s*(.*)$/

export function parseSipMessage(raw: string): SipMessage | null {
  const lines = raw.split('\r\n')
  if (lines.length < 2) return null

  const firstLine = lines[0] ?? ''

  // Response: SIP/2.0 200 OK
  if (firstLine.startsWith('SIP/2.0 ')) {
    const parts = firstLine.split(' ')
    const statusCode = Number.parseInt(parts[1] ?? '0', 10)
    const statusText = parts.slice(2).join(' ')
    const { headers, body } = parseHeadersAndBody(lines.slice(1))
    return { type: 'response', statusCode, statusText, headers, body }
  }

  // Request: INVITE sip:... SIP/2.0
  const reqParts = firstLine.split(' ')
  const method = (reqParts[0] ?? '').toUpperCase() as SipMethod
  if (!['REGISTER', 'INVITE', 'ACK', 'BYE', 'CANCEL'].includes(method)) return null

  const { headers, body } = parseHeadersAndBody(lines.slice(1))
  return { type: 'request', method, headers, body }
}

function parseHeadersAndBody(headerLines: string[]): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {}
  let bodyStart = -1
  let prevKey = ''

  for (let i = 0; i < headerLines.length; i++) {
    const line = headerLines[i] ?? ''
    if (line === '') {
      bodyStart = i + 1
      break
    }
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (prevKey) {
        headers[prevKey] += ` ${line.trim()}`
      }
      continue
    }
    const m = HEADER_RE.exec(line)
    if (m) {
      prevKey = (m[1] ?? '').toLowerCase()
      headers[prevKey] = (m[2] ?? '').trim()
    }
  }

  const body = bodyStart >= 0 ? headerLines.slice(bodyStart).join('\r\n') : ''
  return { headers, body }
}

// ── SIP Message Builder ────────────────────────────────────────────────────────

export function buildRequestLine(method: SipMethod, uri: string): string {
  return `${method} ${uri} SIP/2.0`
}

export function buildStatusLine(code: number, text: string): string {
  return `SIP/2.0 ${code} ${text}`
}

export function buildSipMessage(opts: { startLine: string; headers: Record<string, string>; body?: string }): string {
  const lines = [opts.startLine]
  for (const [k, v] of Object.entries(opts.headers)) {
    lines.push(`${k}: ${v}`)
  }
  if (opts.body) {
    lines.push(`Content-Length: ${Buffer.byteLength(opts.body)}`)
    lines.push('')
    lines.push(opts.body)
  } else {
    lines.push('Content-Length: 0')
    lines.push('')
    lines.push('')
  }
  return lines.join('\r\n')
}

// ── SDP Parser ─────────────────────────────────────────────────────────────────

export function parseSdp(body: string): Sdp | null {
  const lines = body.split('\r\n')
  const sdp: Sdp = {
    sessionId: '',
    originAddress: '',
    connectionAddress: '0.0.0.0',
    media: [],
  }

  let currentMedia: Partial<SdpMedia> | null = null

  for (const line of lines) {
    if (line.startsWith('o=')) {
      const parts = line.slice(2).split(' ')
      sdp.sessionId = parts[1] ?? ''
      sdp.originAddress = parts[4] ?? parts[3] ?? ''
    }
    if (line.startsWith('c=')) {
      const parts = line.slice(2).split(' ')
      const ip = parts[2] ?? parts[1] ?? '0.0.0.0'
      if (currentMedia) {
        currentMedia.ip = ip
      } else {
        sdp.connectionAddress = ip
      }
    }
    if (line.startsWith('m=')) {
      if (currentMedia && currentMedia.port !== undefined) {
        const m = buildSdpMedia(currentMedia)
        if (m) sdp.media.push(m)
      }
      const parts = line.slice(2).split(' ')
      const port = Number.parseInt(parts[1] ?? '0', 10)
      const pts = parts.slice(3).map((p) => Number.parseInt(p, 10))
      currentMedia = { port, payloadTypes: pts, rtpmap: new Map(), ip: sdp.connectionAddress }
    }
    if (line.startsWith('a=rtpmap:') && currentMedia) {
      const parts = line.slice(9).split(' ')
      const pt = Number.parseInt(parts[0] ?? '0', 10)
      const desc = parts.slice(1).join(' ')
      currentMedia.rtpmap?.set(pt, desc)
    }
  }

  if (currentMedia && currentMedia.port !== undefined) {
    const m = buildSdpMedia(currentMedia)
    if (m) sdp.media.push(m)
  }

  return sdp.media.length > 0 ? sdp : null
}

function buildSdpMedia(raw: Partial<SdpMedia>): SdpMedia | null {
  if (raw.port === undefined || !raw.payloadTypes || raw.payloadTypes.length === 0) return null
  return {
    ip: raw.ip ?? '0.0.0.0',
    port: raw.port,
    payloadTypes: raw.payloadTypes,
    rtpmap: raw.rtpmap ?? new Map(),
  }
}

// ── SDP Builder ────────────────────────────────────────────────────────────────

export function buildSdp(opts: {
  localIp: string
  audioPort: number
  codec: 'alaw' | 'ulaw'
  sessionId?: string
}): string {
  const pt = opts.codec === 'alaw' ? 8 : 0
  const codecName = opts.codec === 'alaw' ? 'PCMA' : 'PCMU'
  const sid = opts.sessionId ?? String(Date.now())

  return (
    [
      'v=0',
      `o=- ${sid} 1 IN IP4 ${opts.localIp}`,
      's=zapo-sip-bridge',
      `c=IN IP4 ${opts.localIp}`,
      't=0 0',
      `m=audio ${opts.audioPort} RTP/AVP ${pt}`,
      `a=rtpmap:${pt} ${codecName}/8000`,
      'a=sendrecv',
      'a=ptime:20',
    ].join('\r\n') + '\r\n'
  )
}

// ── SIP Header Helpers ─────────────────────────────────────────────────────────

export function parseTagFromHeader(header: string | undefined, prefix: string): string | null {
  if (!header) return null
  const m = header.match(new RegExp(`${prefix}=([^;\\s]+)`))
  return m?.[1] ?? null
}

export function extractBranch(viaHeader: string | undefined): string | null {
  if (!viaHeader) return null
  const m = viaHeader.match(/branch=([^;]+)/)
  return m?.[1] ?? null
}

export function extractCallId(headers: Record<string, string>): string {
  return headers['call-id'] ?? headers['i'] ?? ''
}

export function extractCSeq(headers: Record<string, string>): { seq: number; method: string } {
  const raw = headers['cseq'] ?? '0 UNKNOWN'
  const [num, ...rest] = raw.split(' ')
  return { seq: Number.parseInt(num ?? '0', 10), method: rest.join(' ') }
}

export function generateBranch(): string {
  const r = Math.random().toString(36).slice(2)
  return `z9hG4bK-${r}`
}

export function generateTag(): string {
  return Math.random().toString(36).slice(2, 12)
}

export function generateCallId(host: string): string {
  return `${Math.random().toString(36).slice(2)}@${host}`
}
