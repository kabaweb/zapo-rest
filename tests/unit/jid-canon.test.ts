import { describe, expect, it } from 'vitest'
import { extractLidPnPair, isNoiseChatJid, preferPnChatJid, toPnJid } from '~/lib/jid-canon'

describe('preferPnChatJid', () => {
  it('rewrites lid + pn alt to pn', () => {
    expect(preferPnChatJid('123456789@lid', '5511999999999@s.whatsapp.net')).toBe('5511999999999@s.whatsapp.net')
  })

  it('rewrites when pn is remote and lid is alt', () => {
    expect(preferPnChatJid('5511999999999@s.whatsapp.net', '123456789@lid')).toBe('5511999999999@s.whatsapp.net')
  })

  it('keeps group jid', () => {
    expect(preferPnChatJid('120363@g.us', 'x@lid')).toBe('120363@g.us')
  })

  it('keeps lone lid when no alt', () => {
    expect(preferPnChatJid('999@lid', null)).toBe('999@lid')
  })
})

describe('extractLidPnPair', () => {
  it('extracts pair either order', () => {
    expect(extractLidPnPair('1@lid', '55@s.whatsapp.net')).toEqual({
      lid: '1@lid',
      pn: '55@s.whatsapp.net',
    })
    expect(extractLidPnPair('55@s.whatsapp.net', '1@lid')).toEqual({
      lid: '1@lid',
      pn: '55@s.whatsapp.net',
    })
  })
})

describe('noise filter', () => {
  it('filters broadcast and status', () => {
    expect(isNoiseChatJid('status@broadcast')).toBe(true)
    expect(isNoiseChatJid('x@newsletter')).toBe(true)
    expect(isNoiseChatJid('0@s.whatsapp.net')).toBe(true)
    expect(isNoiseChatJid('5511@s.whatsapp.net')).toBe(false)
  })
})

describe('toPnJid', () => {
  it('normalizes c.us', () => {
    expect(toPnJid('5511999@c.us')).toBe('5511999@s.whatsapp.net')
  })
})
