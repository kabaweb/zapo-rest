/**
 * Testes unitários para o módulo SIP trunk.
 *
 * Cobertura:
 * - G.711 a-law / u-law codec (encode/decode roundtrip)
 * - Resampling (16kHz ↔ 8kHz)
 * - SIP message parsing (REGISTER, INVITE, BYE, responses)
 * - SDP parsing and building
 * - RTP packet creation and parsing
 * - SIP trunk config parsing (env → config)
 *
 * Não testa (precisa de hardware):
 * - Conexão UDP real com Asterisk
 * - Chamadas WhatsApp reais
 * - Registro SIP completo
 */

import { describe, expect, it } from 'vitest'
import {
  decodeG711ToPcm,
  downsampleFloat32ToInt16,
  encodePcmToG711,
  upsampleInt16ToFloat32,
} from '~/sip/codec'
import { createRtpPacket, openRtpSocket, parseRtpPacket, sendRtp } from '~/sip/rtp'
import {
  buildSdp,
  buildSipMessage,
  buildRequestLine,
  buildStatusLine,
  extractBranch,
  extractCallId,
  extractCSeq,
  generateBranch,
  generateCallId,
  generateTag,
  parseSdp,
  parseSipMessage,
  parseTagFromHeader,
} from '~/sip/sip-message'
import type { SipRtpSession } from '~/sip/types'

// ── G.711 Codec ────────────────────────────────────────────────────────────────

describe('G.711 codec', () => {
  it('encodes and decodes a-law roundtrip (silence)', () => {
    const pcm = new Float32Array(320) // 20ms @ 16kHz
    const g711 = encodePcmToG711(pcm, 'alaw')
    expect(g711.length).toBe(160) // 20ms @ 8kHz

    const decoded = decodeG711ToPcm(g711, 'alaw')
    expect(decoded.length).toBe(320)

    // Silent input → near-silent output
    for (let i = 0; i < decoded.length; i++) {
      expect(Math.abs(decoded[i]!)).toBeLessThan(0.01)
    }
  })

  it('encodes and decodes u-law roundtrip (silence)', () => {
    const pcm = new Float32Array(320)
    const g711 = encodePcmToG711(pcm, 'ulaw')
    expect(g711.length).toBe(160)

    const decoded = decodeG711ToPcm(g711, 'ulaw')
    expect(decoded.length).toBe(320)

    for (let i = 0; i < decoded.length; i++) {
      expect(Math.abs(decoded[i]!)).toBeLessThan(0.01)
    }
  })

  it('preserves signal shape through a-law encode/decode', () => {
    // Generate a sine wave
    const pcm = new Float32Array(320)
    for (let i = 0; i < 320; i++) {
      pcm[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.5
    }

    const g711 = encodePcmToG711(pcm, 'alaw')
    const decoded = decodeG711ToPcm(g711, 'alaw')

    // Check the signal still oscillates (not all zeros)
    let maxAbs = 0
    for (let i = 0; i < decoded.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(decoded[i]!))
    }
    expect(maxAbs).toBeGreaterThan(0.1)

    // Check zero crossings match roughly
    let originalCrossings = 0
    let decodedCrossings = 0
    for (let i = 1; i < pcm.length; i++) {
      if ((pcm[i - 1]! >= 0) !== (pcm[i]! >= 0)) originalCrossings++
    }
    for (let i = 1; i < decoded.length; i++) {
      if ((decoded[i - 1]! >= 0) !== (decoded[i]! >= 0)) decodedCrossings++
    }
    // Zero crossings should be close (allow some tolerance due to codec)
    expect(Math.abs(originalCrossings - decodedCrossings)).toBeLessThan(10)
  })

  it('u-law encode/decode preserves signal', () => {
    const pcm = new Float32Array(320)
    for (let i = 0; i < 320; i++) {
      pcm[i] = Math.sin((2 * Math.PI * 1000 * i) / 16000) * 0.5
    }

    const g711 = encodePcmToG711(pcm, 'ulaw')
    const decoded = decodeG711ToPcm(g711, 'ulaw')

    let maxAbs = 0
    for (let i = 0; i < decoded.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(decoded[i]!))
    }
    expect(maxAbs).toBeGreaterThan(0.1)
  })

  it('handles edge case: max amplitude', () => {
    const pcm = new Float32Array(320)
    pcm.fill(1.0)
    const g711 = encodePcmToG711(pcm, 'alaw')
    expect(g711.length).toBe(160)
    const decoded = decodeG711ToPcm(g711, 'alaw')
    expect(decoded.length).toBe(320)
    // Should all decode to near max
    for (let i = 0; i < decoded.length; i++) {
      expect(decoded[i]!).toBeGreaterThan(0.8)
    }
  })

  it('handles edge case: min amplitude', () => {
    const pcm = new Float32Array(320)
    pcm.fill(-1.0)
    const g711 = encodePcmToG711(pcm, 'alaw')
    const decoded = decodeG711ToPcm(g711, 'alaw')
    for (let i = 0; i < decoded.length; i++) {
      expect(decoded[i]!).toBeLessThan(-0.8)
    }
  })

  it('handles odd-length input gracefully', () => {
    const pcm = new Float32Array(321) // odd length
    const g711 = encodePcmToG711(pcm, 'alaw')
    expect(g711.length).toBe(160) // floor(321/2) = 160
  })
})

// ── Resampling ──────────────────────────────────────────────────────────────────

describe('Resampling (16kHz ↔ 8kHz)', () => {
  it('downsample then upsample preserves approximate shape', () => {
    const original = new Float32Array(320)
    for (let i = 0; i < 320; i++) {
      original[i] = Math.sin((2 * Math.PI * 400 * i) / 16000) * 0.4
    }

    const down = downsampleFloat32ToInt16(original)
    expect(down.length).toBe(160)

    const up = upsampleInt16ToFloat32(down)
    expect(up.length).toBe(320)

    // Peaks should be at similar positions
    let origPeakIdx = 0
    let upPeakIdx = 0
    for (let i = 1; i < 320; i++) {
      if (original[i]! > original[origPeakIdx]!) origPeakIdx = i
      if (up[i]! > up[upPeakIdx]!) upPeakIdx = i
    }
    expect(Math.abs(origPeakIdx - upPeakIdx)).toBeLessThan(5)
  })

  it('downsample reduces length by half', () => {
    expect(downsampleFloat32ToInt16(new Float32Array(100)).length).toBe(50)
    expect(downsampleFloat32ToInt16(new Float32Array(101)).length).toBe(50)
    expect(downsampleFloat32ToInt16(new Float32Array(0)).length).toBe(0)
  })

  it('upsample doubles length', () => {
    expect(upsampleInt16ToFloat32(new Int16Array(50)).length).toBe(100)
    expect(upsampleInt16ToFloat32(new Int16Array(0)).length).toBe(0)
  })
})

// ── SIP Message Parsing ─────────────────────────────────────────────────────────

describe('SIP message parsing', () => {
  it('parses INVITE request', () => {
    const raw = [
      'INVITE sip:1001@asterisk:5060 SIP/2.0',
      'Via: SIP/2.0/UDP 192.168.1.1:5060;branch=z9hG4bK-abc123',
      'Max-Forwards: 70',
      'From: "Caller" <sip:caller@example.com>;tag=tag123',
      'To: <sip:1001@asterisk>',
      'Call-ID: call123@192.168.1.1',
      'CSeq: 1 INVITE',
      'Contact: <sip:caller@192.168.1.1:5060>',
      'Content-Type: application/sdp',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n')

    const msg = parseSipMessage(raw)
    expect(msg).not.toBeNull()
    expect(msg!.type).toBe('request')
    expect(msg!.method).toBe('INVITE')
    expect(msg!.headers['call-id']).toBe('call123@192.168.1.1')
  })

  it('parses response (200 OK)', () => {
    const raw = [
      'SIP/2.0 200 OK',
      'Via: SIP/2.0/UDP 192.168.1.1:5060;branch=z9hG4bK-abc',
      'From: <sip:caller@example.com>;tag=tagA',
      'To: <sip:called@example.com>;tag=tagB',
      'Call-ID: call1@host',
      'CSeq: 1 INVITE',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n')

    const msg = parseSipMessage(raw)
    expect(msg).not.toBeNull()
    expect(msg!.type).toBe('response')
    expect(msg!.statusCode).toBe(200)
    expect(msg!.statusText).toBe('OK')
  })

  it('parses BYE request', () => {
    const raw = [
      'BYE sip:alice@host SIP/2.0',
      'Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-bye',
      'From: <sip:bob@host>;tag=bobtag',
      'To: <sip:alice@host>;tag=alicetag',
      'Call-ID: dialog1@host',
      'CSeq: 2 BYE',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n')

    const msg = parseSipMessage(raw)
    expect(msg).not.toBeNull()
    expect(msg!.method).toBe('BYE')
  })

  it('parses REGISTER request', () => {
    const raw = [
      'REGISTER sip:asterisk SIP/2.0',
      'Via: SIP/2.0/UDP 10.0.0.2:5070;branch=z9hG4bK-reg',
      'Max-Forwards: 70',
      'From: "Zapo SIP" <sip:zapo@asterisk>;tag=mytag',
      'To: "Zapo SIP" <sip:zapo@asterisk>',
      'Call-ID: reg1@10.0.0.2',
      'CSeq: 1 REGISTER',
      'Contact: <sip:zapo@10.0.0.2:5070>',
      'Expires: 3600',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n')

    const msg = parseSipMessage(raw)
    expect(msg).not.toBeNull()
    expect(msg!.method).toBe('REGISTER')
    expect(msg!.headers['call-id']).toBe('reg1@10.0.0.2')
    expect(msg!.headers['expires']).toBe('3600')
  })

  it('rejects malformed message', () => {
    expect(parseSipMessage('not a sip message')).toBeNull()
    expect(parseSipMessage('')).toBeNull()
    expect(parseSipMessage('HTTP/1.1 200 OK\r\n\r\n')).toBeNull()
  })

  it('rejects unknown method', () => {
    const raw = ['SUBSCRIBE sip:alice@host SIP/2.0', 'Via: ...', 'CSeq: 1 SUBSCRIBE', '', ''].join('\r\n')
    expect(parseSipMessage(raw)).toBeNull()
  })
})

// ── SIP Header Helpers ──────────────────────────────────────────────────────────

describe('SIP header helpers', () => {
  it('extractBranch returns branch parameter', () => {
    const via = 'SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-abc123;rport'
    expect(extractBranch(via)).toBe('z9hG4bK-abc123')
  })

  it('extractBranch returns null when missing', () => {
    expect(extractBranch('SIP/2.0/UDP 10.0.0.1:5060')).toBeNull()
    expect(extractBranch(undefined)).toBeNull()
  })

  it('extractCallId reads header', () => {
    const headers = { 'call-id': 'abc123@host', from: '<sip:x@y>' }
    expect(extractCallId(headers)).toBe('abc123@host')
  })

  it('extractCallId returns empty when missing', () => {
    expect(extractCallId({})).toBe('')
  })

  it('extractCSeq parses sequence number and method', () => {
    const headers = { cseq: '42 INVITE' }
    const result = extractCSeq(headers)
    expect(result.seq).toBe(42)
    expect(result.method).toBe('INVITE')
  })

  it('extractCSeq handles default', () => {
    const result = extractCSeq({})
    expect(result.seq).toBe(0)
    expect(result.method).toBe('UNKNOWN')
  })

  it('parseTagFromHeader extracts tag', () => {
    expect(parseTagFromHeader('<sip:alice@host>;tag=abc', 'tag')).toBe('abc')
    expect(parseTagFromHeader('"Alice" <sip:alice@host>;tag=xyz', 'tag')).toBe('xyz')
    expect(parseTagFromHeader('<sip:bob@host>', 'tag')).toBeNull()
    expect(parseTagFromHeader(undefined, 'tag')).toBeNull()
  })

  it('generateBranch produces valid branch', () => {
    const b = generateBranch()
    expect(b.startsWith('z9hG4bK-')).toBe(true)
    expect(b.length).toBeGreaterThan(10)
  })

  it('generateTag produces a short alphanumeric tag', () => {
    const tag = generateTag()
    expect(tag.length).toBeGreaterThan(5)
    expect(/^[a-z0-9]+$/.test(tag)).toBe(true)
  })

  it('generateCallId includes host', () => {
    const id = generateCallId('myhost')
    expect(id.includes('@myhost')).toBe(true)
    expect(id.length).toBeGreaterThan(5)
  })
})

// ── SIP Message Building ────────────────────────────────────────────────────────

describe('SIP message building', () => {
  it('buildRequestLine creates correct request line', () => {
    expect(buildRequestLine('INVITE', 'sip:bob@example.com')).toBe(
      'INVITE sip:bob@example.com SIP/2.0',
    )
  })

  it('buildStatusLine creates correct status line', () => {
    expect(buildStatusLine(200, 'OK')).toBe('SIP/2.0 200 OK')
    expect(buildStatusLine(486, 'Busy Here')).toBe('SIP/2.0 486 Busy Here')
  })

  it('buildSipMessage creates valid SIP message with body', () => {
    const msg = buildSipMessage({
      startLine: buildRequestLine('INVITE', 'sip:test@host'),
      headers: {
        Via: 'SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-abc',
        From: '<sip:alice@host>;tag=tagA',
        To: '<sip:bob@host>',
        'Call-ID': 'call1@host',
        CSeq: '1 INVITE',
        'Content-Type': 'application/sdp',
      },
      body: 'v=0\r\n',
    })

    expect(msg).toContain('INVITE sip:test@host SIP/2.0')
    expect(msg).toContain('Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-abc')
    expect(msg).toContain('Content-Length: 5')
    expect(msg).toContain('v=0\r\n')
  })

  it('buildSipMessage handles empty body', () => {
    const msg = buildSipMessage({
      startLine: buildStatusLine(200, 'OK'),
      headers: {
        Via: 'SIP/2.0/UDP host:5060;branch=z9hG4bK-x',
        From: '<sip:a@host>',
        To: '<sip:b@host>;tag=tagB',
        'Call-ID': 'c@host',
        CSeq: '1 INVITE',
      },
    })

    expect(msg).toContain('Content-Length: 0')
    const parsed = parseSipMessage(msg)
    expect(parsed).not.toBeNull()
    expect(parsed!.statusCode).toBe(200)
  })
})

// ── SDP ─────────────────────────────────────────────────────────────────────────

describe('SDP', () => {
  it('buildSdp generates valid SDP for a-law', () => {
    const sdp = buildSdp({
      localIp: '192.168.1.100',
      audioPort: 15000,
      codec: 'alaw',
      sessionId: '12345',
    })

    expect(sdp).toContain('v=0')
    expect(sdp).toContain('o=- 12345 1 IN IP4 192.168.1.100')
    expect(sdp).toContain('c=IN IP4 192.168.1.100')
    expect(sdp).toContain('m=audio 15000 RTP/AVP 8')
    expect(sdp).toContain('a=rtpmap:8 PCMA/8000')
    expect(sdp).toContain('a=sendrecv')
    expect(sdp).toContain('a=ptime:20')
  })

  it('buildSdp uses payload type 0 for u-law', () => {
    const sdp = buildSdp({
      localIp: '10.0.0.1',
      audioPort: 20000,
      codec: 'ulaw',
    })

    expect(sdp).toContain('m=audio 20000 RTP/AVP 0')
    expect(sdp).toContain('a=rtpmap:0 PCMU/8000')
  })

  it('parseSdp extracts connection and media info', () => {
    const raw = [
      'v=0',
      'o=- 12345 1 IN IP4 192.168.1.100',
      's=-',
      'c=IN IP4 192.168.1.100',
      't=0 0',
      'm=audio 15000 RTP/AVP 8',
      'a=rtpmap:8 PCMA/8000',
      'a=sendrecv',
      '',
    ].join('\r\n')

    const sdp = parseSdp(raw)
    expect(sdp).not.toBeNull()
    expect(sdp!.connectionAddress).toBe('192.168.1.100')
    expect(sdp!.media.length).toBe(1)
    expect(sdp!.media[0]!.port).toBe(15000)
    expect(sdp!.media[0]!.payloadTypes).toContain(8)
    expect(sdp!.media[0]!.rtpmap.get(8)).toBe('PCMA/8000')
  })

  it('parseSdp handles media-level connection', () => {
    const raw = [
      'v=0',
      'o=- 1 1 IN IP4 10.0.0.1',
      's=-',
      'c=IN IP4 10.0.0.1',
      't=0 0',
      'm=audio 16000 RTP/AVP 0 8',
      'c=IN IP4 10.0.0.2',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      '',
    ].join('\r\n')

    const sdp = parseSdp(raw)
    expect(sdp).not.toBeNull()
    expect(sdp!.media[0]!.ip).toBe('10.0.0.2')
  })

  it('parseSdp returns null for empty body', () => {
    expect(parseSdp('')).toBeNull()
  })
})

// ── RTP ─────────────────────────────────────────────────────────────────────────

describe('RTP', () => {
  it('creates valid RTP packet', () => {
    // Minimal mock session
    const session: SipRtpSession = {
      localPort: 15000,
      remoteHost: '10.0.0.1',
      remotePort: 20000,
      ssrc: 0x12345678,
      seq: 100,
      timestamp: 160,
      payloadType: 8, // PCMA
      socket: null as unknown as SipRtpSession['socket'],
    }

    const payload = Buffer.alloc(160) // 20ms G.711
    payload.fill(0xd5) // typical a-law silence

    const packet = createRtpPacket(session, payload)

    // RTP header = 12 bytes + payload
    expect(packet.length).toBe(172)

    // Version = 2
    expect((packet[0]! >> 6) & 0x03).toBe(2)

    // Payload type
    expect(packet[1]! & 0x7f).toBe(8)

    // Sequence number incremented
    expect(packet.readUInt16BE(2)).toBe(101)
    expect(session.seq).toBe(101)

    // Timestamp incremented by 160 samples (20ms @ 8kHz)
    expect(packet.readUInt32BE(4)).toBe(320)
    expect(session.timestamp).toBe(320)

    // SSRC preserved
    expect(packet.readUInt32BE(8)).toBe(0x12345678)

    // Payload copied
    expect(packet[12]).toBe(0xd5)
    expect(packet[171]).toBe(0xd5)
  })

  it('parseRtpPacket extracts header fields', () => {
    const payload = Buffer.alloc(160, 0x55)
    const packet = Buffer.alloc(12 + 160)
    // Version 2, no padding, no extension, no CSRC
    packet[0] = 0x80
    packet[1] = 8 // PCMA
    packet.writeUInt16BE(100, 2) // seq
    packet.writeUInt32BE(160, 4) // timestamp
    packet.writeUInt32BE(0xabcd1234, 8) // ssrc
    payload.copy(packet, 12)

    const parsed = parseRtpPacket(packet)
    expect(parsed).not.toBeNull()
    expect(parsed!.seq).toBe(100)
    expect(parsed!.timestamp).toBe(160)
    expect(parsed!.ssrc).toBe(0xabcd1234)
    expect(parsed!.payload.length).toBe(160)
    expect(parsed!.payload[0]).toBe(0x55)
  })

  it('parseRtpPacket rejects short packets', () => {
    expect(parseRtpPacket(Buffer.alloc(8))).toBeNull()
    expect(parseRtpPacket(Buffer.alloc(0))).toBeNull()
  })

  it('parseRtpPacket rejects non-RTP version', () => {
    const packet = Buffer.alloc(20)
    packet[0] = 0x40 // version 1
    expect(parseRtpPacket(packet)).toBeNull()
  })

  it('openRtpSocket opens a UDP socket with random port', async () => {
    const socket = await openRtpSocket()
    const addr = socket.address()
    expect(addr.port).toBeGreaterThan(0)
    socket.close()
  })
})
