/**
 * SIP transport over UDP.
 *
 * Manages a single UDP socket for sending and receiving SIP messages.
 */

import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import { parseSipMessage, type SipMessage } from './sip-message'

export type SipTransportEvent =
  | { type: 'message'; msg: SipMessage; raw: string; rinfo: RemoteInfo }
  | { type: 'error'; error: Error }
  | { type: 'close' }

export type SipTransportHandler = (event: SipTransportEvent) => void

export class SipTransport {
  private socket: Socket | null = null
  private handler: SipTransportHandler | null = null
  private bound = false

  get port(): number {
    return this.socket?.address().port ?? 0
  }

  async bind(localHost: string, localPort: number): Promise<void> {
    if (this.bound) return

    this.socket = createSocket('udp4')

    await new Promise<void>((resolve, reject) => {
      const sock = this.socket
      if (!sock) {
        reject(new Error('socket not created'))
        return
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const cleanup = () => {
        sock.removeListener('error', onError)
      }

      sock.on('error', onError)
      sock.on('message', (buf, rinfo) => {
        this.onMessage(buf, rinfo)
      })

      sock.bind(localPort, localHost, () => {
        cleanup()
        this.bound = true
        resolve()
      })
    })
  }

  onEvent(handler: SipTransportHandler): void {
    this.handler = handler
  }

  send(data: string, host: string, port: number): void {
    if (!this.socket) return
    const buf = Buffer.from(data, 'utf-8')
    this.socket.send(buf, 0, buf.length, port, host)
  }

  close(): void {
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        /* ignore */
      }
      this.socket = null
      this.bound = false
    }
    if (this.handler) {
      this.handler({ type: 'close' })
    }
  }

  private onMessage(buf: Buffer, rinfo: RemoteInfo): void {
    if (!this.handler) return
    const raw = buf.toString('utf-8')
    const msg = parseSipMessage(raw)
    if (!msg) return
    this.handler({ type: 'message', msg, raw, rinfo })
  }
}
