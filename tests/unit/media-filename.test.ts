import { describe, expect, it } from 'vitest'
import { contentDisposition, resolveDownloadFilename, sanitizeFilename } from '~/media/filename'

describe('media filename (per-message, CAS-independent)', () => {
  it('keeps distinct original names for the same content identity', () => {
    // Same bytes would share storageKey in CAS; filenames stay on each message row.
    const a = resolveDownloadFilename({ mediaFilename: 'APRESENTACAO.xlsx' })
    const b = resolveDownloadFilename({ mediaFilename: 'RELATORIO.xlsx' })
    expect(a).toBe('APRESENTACAO.xlsx')
    expect(b).toBe('RELATORIO.xlsx')
    expect(a).not.toBe(b)
  })

  it('sanitizes path separators and dangerous characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('a:b*.xlsx')).toBe('a_b_.xlsx')
  })

  it('builds RFC 5987 Content-Disposition with both filename and filename*', () => {
    const h = contentDisposition('RELATORIO.xlsx', 'attachment')
    expect(h).toContain('attachment;')
    expect(h).toContain('filename="RELATORIO.xlsx"')
    expect(h).toContain("filename*=UTF-8''RELATORIO.xlsx")
  })

  it('falls back when original name missing', () => {
    expect(
      resolveDownloadFilename({
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        messageId: 'MSG1',
      }),
    ).toBe('MSG1.xlsx')
  })
})
