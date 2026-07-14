/**
 * Minimal RTP (RFC 3550) send / receive over UDP.
 *
 * Handles G.711 payloads at 8 kHz clock rate, 20 ms frames (160 bytes).
 */

import { createSocket, type Socket } from 'node:dgram'
import type { SipCodec, SipRtpSession } from './types'

const RTP_VERSION = 0x80
const RTP_HEADER_LEN = 12
const PT_ALAW = 8
const PT_ULAW = 0
const SAMPLE_RATE = 8_000
const FRAME_MS = 20
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000

function payloadType(codec: SipCodec): number {
  return codec === 'alaw' ? PT_ALAW : PT_ULAW
}

/** Build an RTP packet (12-byte header + payload). */
export function createRtpPacket(session: SipRtpSession, payload: Buffer): Buffer {
  const seq = (session.seq + 1) & 0xffff
  const ts = (session.timestamp + SAMPLES_PER_FRAME) & 0xffff_ffff

  const buf = Buffer.allocUnsafe(RTP_HEADER_LEN + payload.length)
  buf[0] = RTP_VERSION
  buf[1] = session.payloadType
  buf.writeUInt16BE(seq, 2)
  buf.writeUInt32BE(ts, 4)
  buf.writeUInt32BE(session.ssrc, 8)
  payload.copy(buf, RTP_HEADER_LEN)

  session.seq = seq
  session.timestamp = ts

  return buf
}

/** Parse RTP packet header. Returns { payload, seq, timestamp, ssrc } or null on error. */
export function parseRtpPacket(buf: Buffer): { payload: Buffer; seq: number; timestamp: number; ssrc: number } | null {
  if (buf.length < RTP_HEADER_LEN) return null
  const version = ((buf[0] ?? 0) >> 6) & 0x03
  if (version !== 2) return null
  const seq = buf.readUInt16BE(2)
  const timestamp = buf.readUInt32BE(4)
  const ssrc = buf.readUInt32BE(8)
  const payload = buf.subarray(RTP_HEADER_LEN)
  return { payload, seq, timestamp, ssrc }
}

/** Open a local UDP socket for RTP and return the auto-assigned port. */
export function openRtpSocket(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createSocket('udp4')
    sock.on('error', reject)
    sock.bind(0, () => {
      sock.removeListener('error', reject)
      resolve(sock)
    })
  })
}

/** Create an RTP session bound to a local socket and remote endpoint. */
export async function createRtpSession(
  localSocket: Socket,
  remoteHost: string,
  remotePort: number,
  codec: SipCodec,
): Promise<SipRtpSession> {
  return {
    localPort: localSocket.address().port,
    remoteHost,
    remotePort,
    ssrc: (Math.random() * 0xffff_ffff) >>> 0,
    seq: Math.floor(Math.random() * 0xffff),
    timestamp: (Math.random() * 0xffff_ffff) >>> 0,
    payloadType: payloadType(codec),
    socket: localSocket,
  }
}

/** Send a G.711 payload over RTP. */
export function sendRtp(session: SipRtpSession, payload: Buffer): void {
  const packet = createRtpPacket(session, payload)
  session.socket.send(packet, 0, packet.length, session.remotePort, session.remoteHost)
}

/** Close the RTP socket and clean up. */
export function closeRtp(session: SipRtpSession): void {
  try {
    session.socket.close()
  } catch {
    /* ignore */
  }
}

export { SAMPLES_PER_FRAME }
