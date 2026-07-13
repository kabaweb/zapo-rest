import { describe, expect, it } from 'vitest'
import {
  brazilianDigitVariants,
  createJid,
  ensureDefaultCountryCode,
  inspectPhone,
  jidToE164,
  phoneCheckVariants,
  toRecipientJid,
} from '~/lib/phone'

describe('ensureDefaultCountryCode', () => {
  it('prepends 55 when national BR number omits country code', () => {
    expect(ensureDefaultCountryCode('68981159096')).toBe('5568981159096')
    expect(ensureDefaultCountryCode('11987654321')).toBe('5511987654321')
  })

  it('keeps number that already has 55', () => {
    expect(ensureDefaultCountryCode('556881159096')).toBe('556881159096')
    expect(ensureDefaultCountryCode('5568981159096')).toBe('5568981159096')
  })
})

describe('createJid / BR 9th digit', () => {
  it('strips nono dígito for DDD 68 mobile', () => {
    // 55 68 9 81159096 → WhatsApp often uses without 9
    const jid = createJid('5568981159096')
    expect(jid).toBe('556881159096@s.whatsapp.net')
  })

  it('national without 55: 68981159096 → 556881159096@… (no nono on WA side)', () => {
    // User omits 55; local createJid applies 55 + strip for DDD 68
    expect(createJid('68981159096')).toBe('556881159096@s.whatsapp.net')
    expect(toRecipientJid('68981159096')).toBe('556881159096@s.whatsapp.net')
  })

  it('keeps 9 for DDD 11 (ddd < 31)', () => {
    const jid = createJid('5511987654321')
    expect(jid).toBe('5511987654321@s.whatsapp.net')
  })

  it('accepts already-stripped form', () => {
    expect(createJid('556881159096')).toBe('556881159096@s.whatsapp.net')
  })

  it('passes through group and lid jids', () => {
    expect(createJid('120363@g.us')).toContain('@g.us')
    expect(createJid('123@lid')).toContain('@lid')
  })
})

describe('brazilianDigitVariants', () => {
  it('returns both forms for 13-digit BR mobile', () => {
    const v = brazilianDigitVariants('5568981159096')
    expect(v).toContain('5568981159096')
    expect(v).toContain('556881159096')
  })

  it('returns both forms for 12-digit BR mobile', () => {
    const v = brazilianDigitVariants('556881159096')
    expect(v).toContain('556881159096')
    expect(v).toContain('5568981159096')
  })

  it('national without 55 expands both nono forms', () => {
    const v = brazilianDigitVariants('68981159096')
    expect(v).toContain('5568981159096')
    expect(v).toContain('556881159096')
  })
})

describe('phoneCheckVariants', () => {
  it('always includes with/without nono for bare national', () => {
    const v = phoneCheckVariants('68981159096')
    expect(v).toContain('5568981159096')
    expect(v).toContain('556881159096')
  })

  it('accepts formatted input with spaces/dashes', () => {
    const v = phoneCheckVariants('68 98115-9096')
    expect(v).toContain('5568981159096')
    expect(v).toContain('556881159096')
  })
})

describe('toRecipientJid', () => {
  it('normalizes digits with BR rules', () => {
    expect(toRecipientJid('5568981159096')).toBe('556881159096@s.whatsapp.net')
  })

  it('rewrites PN JID missing country code', () => {
    expect(toRecipientJid('68981159096@s.whatsapp.net')).toBe('556881159096@s.whatsapp.net')
  })

  it('keeps full jid that already has 55', () => {
    expect(toRecipientJid('5511999999999@s.whatsapp.net')).toContain('@s.whatsapp.net')
  })
})

describe('jidToE164 (display form)', () => {
  it('adds 9 when displaying 8-digit BR mobile local', () => {
    expect(jidToE164('558591203123@s.whatsapp.net')).toBe('+5585991203123')
  })
})

describe('inspectPhone', () => {
  it('marks BR and lists variants', () => {
    const info = inspectPhone('55 68 98115-9096')
    expect(info.countryHint).toBe('BR')
    expect(info.variants.length).toBeGreaterThanOrEqual(2)
    expect(phoneCheckVariants(info.digits).length).toBeGreaterThanOrEqual(2)
  })

  it('national without 55 is still BR with both variants', () => {
    const info = inspectPhone('68981159096')
    expect(info.countryHint).toBe('BR')
    expect(info.normalizedDigits).toBe('5568981159096')
    expect(info.jid).toBe('556881159096@s.whatsapp.net')
    expect(info.variants).toContain('556881159096')
  })
})
