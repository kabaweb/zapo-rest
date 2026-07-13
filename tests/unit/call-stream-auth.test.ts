/**
 * attachCallStream auth / lifecycle without real WebRTC — mock socket + manager.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeEnv } from '../helpers/fixtures'

// Minimal WS stub
function mockSocket() {
  const sent: unknown[] = []
  const closes: { code?: number; reason?: string }[] = []
  const handlers = new Map<string, (...args: unknown[]) => void>()
  return {
    sent,
    closes,
    send: (data: string | Buffer) => sent.push(data),
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
    on: (ev: string, fn: (...args: unknown[]) => void) => {
      handlers.set(ev, fn)
      return undefined
    },
    // test helpers
    emit(ev: string, ...args: unknown[]) {
      handlers.get(ev)?.(...args)
    },
  }
}

describe('attachCallStream authorization', () => {
  it('closes 4403 when instance key mismatches', async () => {
    const { attachCallStream } = await import('~/voip/call-stream')
    const socket = mockSocket()
    const manager = {
      get: vi.fn(async () => ({ apiKey: 'zr_correct', name: 'sales-1' })),
      getClient: vi.fn(),
    }
    await attachCallStream({
      // @ts-expect-error mock socket
      socket,
      // @ts-expect-error mock manager
      manager,
      env: makeEnv(),
      instanceName: 'sales-1',
      callId: 'c1',
      apiKey: 'zr_wrong_key_value!!',
    })
    expect(socket.closes[0]?.code).toBe(4403)
    expect(manager.getClient).not.toHaveBeenCalled()
  })

  it('closes 4404 when instance missing', async () => {
    const { attachCallStream } = await import('~/voip/call-stream')
    const socket = mockSocket()
    const manager = {
      get: vi.fn(async () => {
        throw Object.assign(new Error('not found'), { statusCode: 404 })
      }),
      getClient: vi.fn(),
    }
    await attachCallStream({
      // @ts-expect-error mock
      socket,
      // @ts-expect-error mock
      manager,
      env: makeEnv(),
      instanceName: 'missing',
      callId: 'c1',
      apiKey: 'zr_any_key_min_16xx',
    })
    expect(socket.closes[0]?.code).toBe(4404)
  })

  it('closes 4503 when instance not connected', async () => {
    const { attachCallStream } = await import('~/voip/call-stream')
    const socket = mockSocket()
    const manager = {
      get: vi.fn(async () => ({ apiKey: 'test-admin-api-key-min-16', name: 'sales-1' })),
      getClient: vi.fn(() => {
        throw new Error('not connected')
      }),
    }
    // admin key short-circuits instance check
    await attachCallStream({
      // @ts-expect-error mock
      socket,
      // @ts-expect-error mock
      manager,
      env: makeEnv(),
      instanceName: 'sales-1',
      callId: 'c1',
      apiKey: 'test-admin-api-key-min-16',
    })
    expect(socket.closes[0]?.code).toBe(4503)
  })

  it('closes 4404 when call not found; admin key ok', async () => {
    const { attachCallStream } = await import('~/voip/call-stream')
    const socket = mockSocket()
    const voip = {
      getCall: vi.fn(() => null),
      getCalls: vi.fn(() => []),
      setExternalAudioMode: vi.fn(),
    }
    const manager = {
      getClient: vi.fn(() => ({ voip })),
    }
    await attachCallStream({
      // @ts-expect-error mock
      socket,
      // @ts-expect-error mock
      manager,
      env: makeEnv(),
      instanceName: 'sales-1',
      callId: 'nope',
      apiKey: 'test-admin-api-key-min-16',
    })
    expect(socket.closes[0]?.code).toBe(4404)
  })

  it('sends ready frame when call exists', async () => {
    const { attachCallStream } = await import('~/voip/call-stream')
    const socket = mockSocket()
    const voip = {
      getCall: vi.fn((id: string) => (id === 'Call1' ? { callId: 'Call1', stateData: { state: 'active' } } : null)),
      getCalls: vi.fn(() => [{ callId: 'Call1' }]),
      setExternalAudioMode: vi.fn(),
      getFeedWatermarksMs: vi.fn(() => ({ pauseMs: 200, resumeMs: 50 })),
      getLiveBufferMs: vi.fn(() => 0),
      feedLiveAudio: vi.fn(() => 0),
      endCall: vi.fn(async () => undefined),
    }
    const manager = {
      getClient: vi.fn(() => ({
        voip,
        on: vi.fn(),
        off: vi.fn(),
      })),
    }
    await attachCallStream({
      // @ts-expect-error mock
      socket,
      // @ts-expect-error mock
      manager,
      env: makeEnv(),
      instanceName: 'sales-1',
      callId: 'call1', // case-insensitive resolve
      apiKey: 'test-admin-api-key-min-16',
    })
    expect(voip.setExternalAudioMode).toHaveBeenCalledWith('Call1', true)
    const ready = JSON.parse(String(socket.sent[0]))
    expect(ready).toMatchObject({
      op: 'ready',
      sampleRate: 16_000,
      channels: 1,
      format: 'f32le',
      callId: 'Call1',
    })
  })
})
