import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { badRequest } from '~/lib/errors'

/**
 * SSRF guard for server-side fetches of user-controlled URLs (media downloads,
 * webhook delivery). Rejects non-public destinations before any network call.
 *
 * Best-effort against DNS rebinding: every resolved address is validated, and
 * callers should pass `redirect: 'error'` (or re-validate each hop). It does not
 * pin the socket to the vetted IP, so a TOCTOU rebind between check and connect
 * remains theoretically possible; combine with an egress allowlist for hard
 * guarantees.
 *
 * @example
 *   await assertPublicUrl(body.mediaUrl)          // throws 400 on localhost/169.254.x
 *   const res = await fetch(body.mediaUrl, { redirect: 'error' })
 */
export type PublicUrlOptions = {
  /** Allow plain `http://` (default false — only `https:` passes). */
  allowHttp?: boolean
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])

export async function assertPublicUrl(rawUrl: string, opts: PublicUrlOptions = {}): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw badRequest(`invalid URL: expected an absolute http(s) URL, got ${JSON.stringify(rawUrl)}`)
  }

  const allowed = opts.allowHttp ? ['http:', 'https:'] : ['https:']
  if (!allowed.includes(url.protocol)) {
    throw badRequest(`blocked URL scheme ${url.protocol} for ${url.hostname}: expected ${allowed.join(' or ')}`)
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw badRequest(`blocked URL host ${host}: points to loopback`)
  }

  // Literal IP in the URL — validate directly, no DNS.
  if (isIP(host)) {
    if (isPrivateIp(host)) throw badRequest(`blocked URL host ${host}: non-public IP address`)
    return url
  }

  const records = await lookup(host, { all: true }).catch(() => {
    throw badRequest(`blocked URL host ${host}: DNS resolution failed`)
  })
  if (records.length === 0) throw badRequest(`blocked URL host ${host}: no DNS records`)
  for (const { address } of records) {
    if (isPrivateIp(address)) throw badRequest(`blocked URL host ${host}: resolves to non-public IP ${address}`)
  }
  return url
}

/**
 * Classifies an IPv4/IPv6 literal as non-public (loopback, private, link-local,
 * unique-local, CGNAT, or the cloud metadata address 169.254.169.254).
 */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isPrivateIpv4(ip)
  if (version === 6) return isPrivateIpv6(ip)
  return true // unparseable → fail closed
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // loopback
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true // link-local + metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 192 && b === 0) return true // 192.0.0.0/24 (incl. 192.0.0.0/29)
  if (a >= 224) return true // multicast + reserved
  return false
}

function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0] ?? ip
  if (addr === '::' || addr === '::1') return true // unspecified + loopback
  if (addr.startsWith('fe80')) return true // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true // unique-local fc00::/7
  if (addr.startsWith('ff')) return true // multicast
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4.
  const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped?.[1]) return isPrivateIpv4(mapped[1])
  return false
}
