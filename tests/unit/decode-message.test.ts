import { describe, expect, it } from 'vitest'
import { decodeIncomingMessage, previewFromDecoded } from '~/events/decode-message'

describe('decodeIncomingMessage', () => {
  it('decodes text conversation', () => {
    const decoded = decodeIncomingMessage({
      key: { id: 'ABC123', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      message: { conversation: 'hello' },
      timestampSeconds: 1_700_000_000,
      pushName: 'Rafa',
    })
    expect(decoded).toMatchObject({
      messageId: 'ABC123',
      type: 'text',
      body: 'hello',
      pushName: 'Rafa',
      fromMe: false,
      timestampMs: 1_700_000_000_000,
    })
    expect(decoded).toBeTruthy()
    if (decoded) expect(previewFromDecoded(decoded)).toBe('hello')
  })

  it('rewrites lid remoteJid to pn alt as chatJid', () => {
    const decoded = decodeIncomingMessage({
      key: {
        id: 'LID1',
        remoteJid: '999888777@lid',
        remoteJidAlt: '5511987654321@s.whatsapp.net',
        fromMe: false,
      },
      message: { conversation: 'oi' },
    })
    expect(decoded?.chatJid).toBe('5511987654321@s.whatsapp.net')
    expect(decoded?.lidPnPair).toEqual({
      lid: '999888777@lid',
      pn: '5511987654321@s.whatsapp.net',
    })
  })

  it('returns null without key id', () => {
    expect(decodeIncomingMessage({ key: {}, message: { conversation: 'x' } })).toBeNull()
  })

  it('detects image media', () => {
    const decoded = decodeIncomingMessage({
      key: { id: 'IMG1', remoteJid: 'x@s.whatsapp.net', fromMe: true },
      message: { imageMessage: { mimetype: 'image/jpeg', caption: 'pic' } },
    })
    expect(decoded?.type).toBe('image')
    expect(decoded?.hasMedia).toBe(true)
    expect(decoded?.caption).toBe('pic')
  })
})
