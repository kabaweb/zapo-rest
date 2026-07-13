import { EventEmitter } from 'node:events'

/**
 * In-process realtime bus for dashboard SSE (`GET /v1/events`) + internal listeners.
 * Cross-process fanout can also use Redis pub/sub when configured.
 */
export type RealtimeEvent = {
  instance: string
  event: string
  eventId: string
  timestamp: string
  data: unknown
}

class RealtimeBus extends EventEmitter {
  emitInstance(payload: RealtimeEvent): void {
    this.emit('event', payload)
    this.emit(`instance:${payload.instance}`, payload)
  }

  onInstance(instance: string, listener: (payload: RealtimeEvent) => void): () => void {
    const channel = `instance:${instance}`
    this.on(channel, listener)
    return () => this.off(channel, listener)
  }

  onAny(listener: (payload: RealtimeEvent) => void): () => void {
    this.on('event', listener)
    return () => this.off('event', listener)
  }
}

export const realtimeBus = new RealtimeBus()
// Prevent MaxListenersWarning when many SSE clients attach
realtimeBus.setMaxListeners(0)
