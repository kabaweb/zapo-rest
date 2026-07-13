import { describe, expect, it } from 'vitest'
import {
  coerceLongish,
  prepareMediaDownloadSource,
  reviveBinaryFields,
  reviveBytes,
  sanitizeRawForStorage,
} from '~/media/revive-raw'

describe('reviveBytes', () => {
  it('revives numbered-object Uint8Array JSON (legacy jsonb)', () => {
    const numbered = Object.fromEntries([...Buffer.from('hello')].map((b, i) => [String(i), b]))
    const out = reviveBytes(numbered)
    expect(out).toBeInstanceOf(Uint8Array)
    expect(out && Buffer.from(out).toString()).toBe('hello')
  })

  it('revives Node Buffer JSON', () => {
    const out = reviveBytes({ type: 'Buffer', data: [1, 2, 3] })
    expect(out ? [...out] : null).toEqual([1, 2, 3])
  })

  it('revives preferred base64 form', () => {
    const out = reviveBytes({ _type: 'bytes', base64: Buffer.from([9, 8, 7]).toString('base64') })
    expect(out ? [...out] : null).toEqual([9, 8, 7])
  })
})

describe('coerceLongish', () => {
  it('converts protobuf JSON long shape', () => {
    expect(coerceLongish({ low: 606706, high: 0, unsigned: true })).toBe(606706)
  })
})

describe('prepareMediaDownloadSource', () => {
  it('extracts message proto and revives mediaKey + fileLength from event-shaped raw', () => {
    const mediaKey = new Uint8Array(32).fill(0xab)
    // Simulate what jsonb returns after JSON.stringify(Uint8Array)
    const numberedKey = Object.fromEntries([...mediaKey].map((b, i) => [String(i), b]))
    const raw = {
      key: { id: 'abc', remoteJid: 'x@s.whatsapp.net' },
      message: {
        documentMessage: {
          mimetype: 'application/pdf',
          directPath: '/v/t.pdf',
          mediaKey: numberedKey,
          fileLength: { low: 606706, high: 0, unsigned: true },
          fileSha256: Object.fromEntries([...new Uint8Array(32).fill(1)].map((b, i) => [String(i), b])),
          fileEncSha256: Object.fromEntries([...new Uint8Array(32).fill(2)].map((b, i) => [String(i), b])),
        },
      },
    }
    const source = prepareMediaDownloadSource(raw) as {
      documentMessage: { mediaKey: Uint8Array; fileSha256: Uint8Array; fileLength: number }
    }
    expect(source.documentMessage).toBeTruthy()
    expect(source.documentMessage.mediaKey).toBeInstanceOf(Uint8Array)
    expect(source.documentMessage.mediaKey.byteLength).toBe(32)
    expect(source.documentMessage.mediaKey[0]).toBe(0xab)
    expect(source.documentMessage.fileSha256).toBeInstanceOf(Uint8Array)
    expect(source.documentMessage.fileLength).toBe(606706)
  })

  it('round-trips via sanitizeRawForStorage', () => {
    const mediaKey = new Uint8Array([1, 2, 3, 4])
    const event = {
      key: { id: '1' },
      rawNode: { skip: true },
      message: { imageMessage: { mediaKey, directPath: '/x' } },
    }
    const stored = sanitizeRawForStorage(event) as {
      message: { imageMessage: { mediaKey: { _type: string; base64: string } } }
      rawNode?: unknown
    }
    expect(stored.rawNode).toBeUndefined()
    expect(stored.message.imageMessage.mediaKey._type).toBe('bytes')

    const revived = reviveBinaryFields(stored.message) as {
      imageMessage: { mediaKey: Uint8Array }
    }
    expect([...revived.imageMessage.mediaKey]).toEqual([1, 2, 3, 4])
  })
})
