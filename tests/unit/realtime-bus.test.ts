import { describe, expect, it, vi } from 'vitest'
import { type RealtimeEvent, realtimeBus } from '~/events/bus'

describe('realtimeBus', () => {
  it('onInstance only receives matching instance events', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unsubA = realtimeBus.onInstance('a', a)
    const unsubB = realtimeBus.onInstance('b', b)

    const payload: RealtimeEvent = {
      instance: 'a',
      event: 'message',
      eventId: '1',
      timestamp: new Date().toISOString(),
      data: { x: 1 },
    }
    realtimeBus.emitInstance(payload)

    expect(a).toHaveBeenCalledWith(payload)
    expect(b).not.toHaveBeenCalled()
    unsubA()
    unsubB()
  })

  it('onAny receives all events and unsub works', () => {
    const any = vi.fn()
    const unsub = realtimeBus.onAny(any)
    realtimeBus.emitInstance({
      instance: 'x',
      event: 'instance.connection',
      eventId: '2',
      timestamp: new Date().toISOString(),
      data: {},
    })
    expect(any).toHaveBeenCalledTimes(1)
    unsub()
    realtimeBus.emitInstance({
      instance: 'x',
      event: 'message',
      eventId: '3',
      timestamp: new Date().toISOString(),
      data: {},
    })
    expect(any).toHaveBeenCalledTimes(1)
  })
})
