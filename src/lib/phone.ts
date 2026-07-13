/**
 * Phone / JID helpers inspired by API `createJid` and E164 rules.
 *
 * Brazil defaults:
 * - If the user omits country code, we assume **55** (configurable via ensureDefaultCountryCode).
 * - 9th digit (nono dígito): national mobile is often DDD + 9 + 8 digits; WhatsApp may
 * register **with or without** the 9. Existence checks try **both**.
 *
 * Example (no 9th digit on WA):
 * input 68981159096 → 5568981159096 (with 9) and 556881159096 (without)
 * WA match → 556881159096@s.whatsapp.net
 */

import { normalizeRecipientJid, parsePhoneJid } from 'zapo-js'

/** Default country code when user types national number only (Brazil). */
export const DEFAULT_COUNTRY_CODE = '55'

export function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, '')
}

/**
 * Prepend DEFAULT_COUNTRY_CODE (55) when missing.
 * Skips empty; does not alter numbers that already start with 55.
 *
 * National BR with DDD is typically 10–11 digits → becomes 12–13 with 55.
 */
export function ensureDefaultCountryCode(digits: string, countryCode: string = DEFAULT_COUNTRY_CODE): string {
  const d = digitsOnly(digits)
  if (!d) return d
  if (d.startsWith(countryCode)) return d
  // Already looks like international with another CC (e.g. 1… US 11+ digits starting with 1)
  // but product rule: bare digits without 55 always get 55 for this deployment.
  if (d.length >= 8) return `${countryCode}${d}`
  return d
}

/** MX (52) / AR (54) — strip the inserted mobile prefix digit when 13 digits. */
function formatMXOrARNumber(jid: string): string {
  const countryCode = jid.substring(0, 2)
  if (Number(countryCode) === 52 || Number(countryCode) === 54) {
    if (jid.length === 13) {
      return countryCode + jid.substring(3)
    }
  }
  return jid
}

/**
 * API `formatBRNumber` — when the number already has the 9th digit
 * (13 digits matching 55DDD9XXXXXXXX), strip the 9 for certain DDD ranges
 * so the JID matches what WhatsApp often uses.
 */
function formatBRNumber(jid: string): string {
  const regexp = /^(\d{2})(\d{2})\d{1}(\d{8})$/
  if (!regexp.test(jid)) return jid
  const match = regexp.exec(jid)
  if (match?.[1] !== '55') return jid

  const local = match[3] ?? ''
  const joker = Number.parseInt(local[0] ?? '0', 10)
  const ddd = Number.parseInt(match[2] ?? '0', 10)
  // Keep full (with 9) for older DDDs / non-mobile-looking locals
  if (joker < 7 || ddd < 31) {
    return match[0] ?? jid
  }
  // Strip the 9th digit: 55 + DDD + 8 local digits
  return `${match[1]}${match[2]}${local}`
}

/** Digits-only user part of a JID / phone string (before @ or device :). */
function phoneUserPart(input: string): string {
  return input.split('@')[0]?.split(':')[0] ?? ''
}

/**
 * Canonical digits for outbound local JID when WA resolve is unavailable:
 * ensure 55 + BR format.
 */
export function normalizePhoneDigits(input: string, countryCode: string = DEFAULT_COUNTRY_CODE): string {
  let d = digitsOnly(input.includes('@') ? phoneUserPart(input) : input)
  d = ensureDefaultCountryCode(d, countryCode)
  if (d.startsWith('55')) {
    d = formatBRNumber(d)
  } else if (d.startsWith('52') || d.startsWith('54')) {
    d = formatMXOrARNumber(d)
  }
  return d
}

/**
 * Build a WhatsApp JID from a free-form number (local createJid + default 55).
 * Groups, lids, and full JIDs pass through.
 */
export function createJid(number: string): string {
  let n = number.replace(/:\d+/, '')

  if (n.includes('@g.us') || n.includes('@s.whatsapp.net') || n.includes('@lid')) {
    return n.includes('@') ? normalizeRecipientJid(n) : n
  }
  if (n.includes('@broadcast')) {
    return n
  }

  n = n.replace(/\s/g, '').replace(/\+/g, '').replace(/\(/g, '').replace(/\)/g, '')
  n = phoneUserPart(n)

  if (n.includes('-') && n.length >= 24) {
    n = n.replace(/[^\d-]/g, '')
    return `${n}@g.us`
  }

  n = n.replace(/\D/g, '')

  if (n.length >= 18) {
    return `${n}@g.us`
  }

  // National BR (and bare mobiles): always assume 55 when omitted
  n = ensureDefaultCountryCode(n)
  n = formatMXOrARNumber(n)
  n = formatBRNumber(n)

  return `${n}@s.whatsapp.net`
}

/** Local-only JID (no WA round-trip) — same as createJid but via parsePhoneJid when pure digits. */
export function toRecipientJid(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('empty recipient')
  }
  // Groups / LID / broadcast: never rewrite user part with BR rules
  if (trimmed.includes('@g.us') || trimmed.includes('@lid') || trimmed.includes('@broadcast')) {
    return normalizeRecipientJid(trimmed)
  }
  // Phone JID may arrive without 55 or with wrong nono dígito — re-run createJid on user
  if (trimmed.includes('@s.whatsapp.net') || trimmed.includes('@c.us')) {
    const user = phoneUserPart(trimmed)
    if (/^\d+$/.test(user) && user.length >= 8) {
      const jid = createJid(user)
      return parsePhoneJid(phoneUserPart(jid))
    }
    return normalizeRecipientJid(trimmed)
  }
  if (trimmed.includes('@')) {
    return normalizeRecipientJid(trimmed)
  }
  const digits = digitsOnly(trimmed)
  if (digits.length < 8) {
    throw new Error(`invalid phone number: ${input}`)
  }
  // Prefer local createJid for BR/MX/AR 9th-digit rules (+ default 55)
  const jid = createJid(digits)
  // Ensure valid PN shape via zapo when not a group
  if (jid.endsWith('@s.whatsapp.net')) {
    return parsePhoneJid(phoneUserPart(jid))
  }
  return jid
}

/**
 * BR: return both forms (with and without 9th digit) for WA existence checks.
 * Always normalizes missing 55 first.
 */
export function brazilianDigitVariants(digits: string): string[] {
  let d = digitsOnly(digits)
  d = ensureDefaultCountryCode(d)
  if (!d.startsWith('55')) return [d]

  const set = new Set<string>([d])

  // With 9: 55 + DDD(2) + 9 + 8 = 13
  // Without: 55 + DDD(2) + 8 = 12
  if (d.length === 13 && d.slice(4, 5) === '9') {
    set.add(d.slice(0, 4) + d.slice(5))
  } else if (d.length === 12) {
    set.add(`${d.slice(0, 4)}9${d.slice(4)}`)
  } else if (d.length === 13) {
    set.add(d.slice(0, 4) + d.slice(5))
    set.add(`${d.slice(0, 4)}9${d.slice(4)}`)
  } else if (d.length === 11 && d.startsWith('55')) {
    // 55 + DDD + 7? rare — still try insert 9 after DDD if looks short
    // treat as 55+DDD+8 without country already handled
  }

  // National 10/11 already expanded via ensureDefaultCountryCode to 12/13

  // preferred form
  const created = phoneUserPart(createJid(d))
  set.add(created)
  // And both sides of that form
  if (created.length === 13 && created.slice(4, 5) === '9') {
    set.add(created.slice(0, 4) + created.slice(5))
  } else if (created.length === 12) {
    set.add(`${created.slice(0, 4)}9${created.slice(4)}`)
  }

  return [...set]
}

/** MX 52 / AR 54 mobile prefix variants. */
export function mxArDigitVariants(digits: string): string[] {
  const d = digitsOnly(digits)
  if (!d.startsWith('52') && !d.startsWith('54')) return [d]

  const prefix = d.startsWith('52') ? '1' : '9'
  const set = new Set<string>([d])

  if (d.length === 13 && d.slice(2, 3) === prefix) {
    set.add(d.slice(0, 2) + d.slice(3))
  } else if (d.length === 12) {
    set.add(`${d.slice(0, 2)}${prefix}${d.slice(2)}`)
  }

  set.add(phoneUserPart(createJid(d)))
  return [...set]
}

/** All phone digit variants to query WhatsApp with (deduped). Always tries 55 + nono dígito pair for BR. */
export function phoneCheckVariants(input: string): string[] {
  let d = digitsOnly(input.includes('@') ? phoneUserPart(input) : input)
  if (d.length < 8) return [d]

  // Bare national → 55 first so BR variant expansion always runs
  d = ensureDefaultCountryCode(d)

  if (d.startsWith('55')) return brazilianDigitVariants(d)
  if (d.startsWith('52') || d.startsWith('54')) return mxArDigitVariants(d)

  // Other: still check raw + createJid form
  return [d, phoneUserPart(createJid(d))].filter((x, i, a) => a.indexOf(x) === i)
}

/** multi-config: JID → E.164 with BR 9 inserted when missing (display form). */
export function jidToE164(jid: string): string | null {
  if (!jid) return null
  const local = jid.split('@')[0]?.split(':')[0]
  if (!local || !/^\d+$/.test(local)) return null
  let number = `+${local}`
  // landline heuristic: do not add 9 when local starts with 2-5
  if (/^\+55(\d{2})([2-5]\d{7})$/.test(number)) {
    return number
  }
  // mobile 8-digit local → add 9
  number = number.replace(/^\+55(\d{2})(\d{8})$/, '+55$19$2')
  return number
}

export type CreateJidInfo = {
  input: string
  digits: string
  /** Digits after ensureDefaultCountryCode */
  normalizedDigits: string
  jid: string
  variants: string[]
  countryHint: 'BR' | 'MX' | 'AR' | 'OTHER'
}

export function inspectPhone(input: string): CreateJidInfo {
  const rawDigits = digitsOnly(input.includes('@') ? phoneUserPart(input) : input)
  const normalizedDigits = ensureDefaultCountryCode(rawDigits)
  const jid = createJid(input)
  const variants = phoneCheckVariants(rawDigits)
  let countryHint: CreateJidInfo['countryHint'] = 'OTHER'
  if (normalizedDigits.startsWith('55')) countryHint = 'BR'
  else if (normalizedDigits.startsWith('52')) countryHint = 'MX'
  else if (normalizedDigits.startsWith('54')) countryHint = 'AR'
  return { input, digits: rawDigits, normalizedDigits, jid, variants, countryHint }
}
