/**
 * LID ↔ PN addressing helpers.
 *
 * WhatsApp multi-device often delivers 1:1 chats as `@lid` with optional
 * `remoteJidAlt` = `@s.whatsapp.net` (or the reverse). PN preference rewrites
 * storage to the PN form when available; keeps a `lid_map` and merges
 * chat/message queries by primary PN. We do both: persist mappings + prefer PN.
 */

export function bareUserJid(jid: string): string {
  const trimmed = jid.trim()
  if (!trimmed) return trimmed
  const [userPart, domain = 's.whatsapp.net'] = trimmed.split('@')
  const user = (userPart ?? '').split(':')[0] ?? ''
  return `${user}@${domain}`
}

export function isLidJid(jid: string | null | undefined): boolean {
  return Boolean(jid?.includes('@lid'))
}

export function isPnJid(jid: string | null | undefined): boolean {
  return Boolean(jid && (jid.includes('@s.whatsapp.net') || jid.endsWith('@c.us')))
}

export function isGroupJid(jid: string | null | undefined): boolean {
  return Boolean(jid?.endsWith('@g.us'))
}

export function isBroadcastJid(jid: string | null | undefined): boolean {
  return Boolean(jid && (jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid === 'status@broadcast'))
}

/** Normalize @c.us → @s.whatsapp.net */
export function toPnJid(jid: string): string {
  const bare = bareUserJid(jid)
  if (bare.endsWith('@c.us')) {
    return `${bare.split('@')[0]}@s.whatsapp.net`
  }
  return bare
}

export type LidPnPair = {
  lid: string
  pn: string
}

/**
 * Extract LID↔PN pair from a message key (or similar).
 * other multi-session APIs both pull these from remoteJid + remoteJidAlt.
 */
export function extractLidPnPair(remoteJid?: string | null, remoteJidAlt?: string | null): LidPnPair | null {
  if (!remoteJid && !remoteJidAlt) return null
  const a = remoteJid ? bareUserJid(remoteJid) : null
  const b = remoteJidAlt ? bareUserJid(remoteJidAlt) : null

  if (a && b) {
    if (isLidJid(a) && isPnJid(b)) return { lid: a, pn: toPnJid(b) }
    if (isPnJid(a) && isLidJid(b)) return { lid: b, pn: toPnJid(a) }
  }
  return null
}

/**
 * Canonical chat JID for storage (PN preference rewrite rule):
 * prefer PN (`@s.whatsapp.net`) over LID when both are known.
 */
export function preferPnChatJid(remoteJid?: string | null, remoteJidAlt?: string | null): string | null {
  if (!remoteJid && !remoteJidAlt) return null

  // Groups / broadcast: never rewrite
  if (remoteJid && (isGroupJid(remoteJid) || isBroadcastJid(remoteJid))) {
    return bareUserJid(remoteJid)
  }

  const pair = extractLidPnPair(remoteJid, remoteJidAlt)
  if (pair) return pair.pn

  if (remoteJid && isPnJid(remoteJid)) return toPnJid(remoteJid)
  if (remoteJidAlt && isPnJid(remoteJidAlt)) return toPnJid(remoteJidAlt)
  if (remoteJid) return bareUserJid(remoteJid)
  return remoteJidAlt ? bareUserJid(remoteJidAlt) : null
}

/** Skip system / noise threads from conversation lists (broadcast filter). */
export function isNoiseChatJid(jid: string): boolean {
  if (isBroadcastJid(jid)) return true
  if (jid === 'status@broadcast') return true
  // bare "0@s.whatsapp.net" / server system jids
  if (/^0@/.test(jid)) return true
  return false
}
