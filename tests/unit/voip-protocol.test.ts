import { describe, expect, it, vi } from 'vitest'
import { asPhoneJid, pickDisplayPeerJid, resolveLiveCall, serializeCallInfo } from '~/voip/call-serialize'

describe('VoIP call serialization contract', () => {
  it('serializeCallInfo ready-shape fields for REST/WS clients', () => {
    const snap = serializeCallInfo({
      callId: 'AbC123',
      peerJid: '999@lid',
      callerPn: '5511888888888',
      direction: 'outgoing',
      mediaType: 'audio',
      createdAt: 1_700_000_000,
      stateData: {
        state: 'active',
        audioMuted: true,
        durationSecs: 12,
        endReason: null,
        acceptBlocked: false,
      },
      isActive: true,
      isRinging: false,
      isEnded: false,
      canAccept: false,
    })

    expect(snap).toMatchObject({
      callId: 'AbC123',
      peerJid: '5511888888888@s.whatsapp.net',
      peerLid: '999@lid',
      direction: 'outgoing',
      mediaType: 'audio',
      state: 'active',
      isActive: true,
      audioMuted: true,
      durationSecs: 12,
    })
    // stable keys for dashboard softphone
    for (const k of [
      'callId',
      'peerJid',
      'peerJidRaw',
      'peerLid',
      'callerPn',
      'direction',
      'state',
      'isActive',
      'isRinging',
      'isEnded',
      'canAccept',
    ]) {
      expect(snap).toHaveProperty(k)
    }
  })

  it('serializeCallInfo ended call with endReason', () => {
    const snap = serializeCallInfo({
      callId: 'end1',
      peerJid: '5511999999999@s.whatsapp.net',
      direction: 'incoming',
      stateData: { state: 'ended', endReason: 'rejected' },
      isActive: false,
      isRinging: false,
      isEnded: true,
      canAccept: false,
    })
    expect(snap.endReason).toBe('rejected')
    expect(snap.peerJid).toBe('5511999999999@s.whatsapp.net')
    expect(snap.peerLid).toBeNull()
  })

  it('resolveLiveCall is case-insensitive', () => {
    const calls = [{ callId: 'AbCdEf' }, { callId: 'other' }]
    const client = {
      voip: {
        getCall: vi.fn((id: string) => calls.find((c) => c.callId === id) ?? null),
        getCalls: () => calls,
      },
    }
    expect(resolveLiveCall(client, 'abcdef')?.callId).toBe('AbCdEf')
    expect(resolveLiveCall(client, 'missing')).toBeNull()
    expect(client.voip.getCall).toHaveBeenCalled()
  })
})

describe('PCM stream protocol constants (contract)', () => {
  /** Documented ready frame for dashboard Softphone / integrators */
  it('ready op shape matches dashboard expectations', () => {
    const ready = {
      op: 'ready' as const,
      sampleRate: 16_000,
      channels: 1,
      format: 'f32le',
      callId: 'c1',
    }
    expect(ready.sampleRate).toBe(16_000)
    expect(ready.format).toBe('f32le')
    expect(ready.channels).toBe(1)
  })

  it('backpressure / ended ops are well-formed JSON', () => {
    expect(JSON.parse(JSON.stringify({ op: 'backpressure', pause: true, bufferedMs: 120 }))).toEqual({
      op: 'backpressure',
      pause: true,
      bufferedMs: 120,
    })
    expect(JSON.parse(JSON.stringify({ op: 'ended', callId: 'c1' }))).toEqual({
      op: 'ended',
      callId: 'c1',
    })
  })
})

describe('asPhoneJid / pickDisplayPeerJid edge cases', () => {
  it('handles +prefix and empty', () => {
    expect(asPhoneJid('+55 11 98888-8888')).toBe('5511988888888@s.whatsapp.net')
    expect(asPhoneJid('')).toBeNull()
    expect(asPhoneJid(null)).toBeNull()
    expect(asPhoneJid('123')).toBeNull()
  })

  it('prefers mapped PN over raw PN peer when both set is N/A — caller first', () => {
    expect(
      pickDisplayPeerJid({
        peerJid: '5511000000000@s.whatsapp.net',
        callerPn: '5511888888888',
        mappedPn: '5511999999999@s.whatsapp.net',
      }),
    ).toBe('5511888888888@s.whatsapp.net')
  })
})
