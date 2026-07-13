import { describe, expect, it } from 'vitest'
import { assertPublicUrl, isPrivateIp } from '~/lib/ssrf-guard'

describe('isPrivateIp', () => {
  it('classifies loopback and RFC1918 as private', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true)
    expect(isPrivateIp('10.0.0.1')).toBe(true)
    expect(isPrivateIp('192.168.1.1')).toBe(true)
    expect(isPrivateIp('172.16.0.1')).toBe(true)
    expect(isPrivateIp('169.254.169.254')).toBe(true)
    expect(isPrivateIp('100.64.0.1')).toBe(true)
    expect(isPrivateIp('0.0.0.0')).toBe(true)
  })

  it('classifies public IPv4 as public', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false)
    expect(isPrivateIp('1.1.1.1')).toBe(false)
  })

  it('classifies IPv6 loopback / ULA / link-local', () => {
    expect(isPrivateIp('::1')).toBe(true)
    expect(isPrivateIp('fe80::1')).toBe(true)
    expect(isPrivateIp('fd00::1')).toBe(true)
  })
})

describe('assertPublicUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/scheme/)
    await expect(assertPublicUrl('ftp://example.com/a')).rejects.toThrow(/scheme/)
  })

  it('rejects http by default', async () => {
    await expect(assertPublicUrl('http://example.com/a')).rejects.toThrow(/scheme/)
  })

  it('allows http when allowHttp', async () => {
    // example.com resolves publicly; if DNS fails the test still documents the scheme path
    await expect(assertPublicUrl('http://example.com/a', { allowHttp: true })).resolves.toBeInstanceOf(URL)
  })

  it('rejects localhost hostname', async () => {
    await expect(assertPublicUrl('https://localhost/hook')).rejects.toThrow(/loopback/)
    await expect(assertPublicUrl('https://127.0.0.1/hook')).rejects.toThrow(/non-public/)
  })

  it('rejects cloud metadata IP', async () => {
    await expect(assertPublicUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/non-public/)
  })

  it('rejects invalid absolute URL', async () => {
    await expect(assertPublicUrl('not-a-url')).rejects.toThrow(/invalid URL/)
  })

  it('rejects private literal IPs even with https', async () => {
    await expect(assertPublicUrl('https://10.0.0.5/hook')).rejects.toThrow(/non-public/)
    await expect(assertPublicUrl('https://192.168.0.2/hook')).rejects.toThrow(/non-public/)
    await expect(assertPublicUrl('https://[::1]/hook')).rejects.toThrow(/non-public|loopback/)
  })
})
