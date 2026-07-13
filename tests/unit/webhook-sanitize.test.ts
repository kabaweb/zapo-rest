import { describe, expect, it } from 'vitest'
import { sanitizeForWebhook } from '~/webhooks/dispatcher'

describe('sanitizeForWebhook', () => {
  it('strips binary and rawNode', () => {
    const out = sanitizeForWebhook({
      text: 'hi',
      rawNode: { huge: true },
      blob: Buffer.from('abc'),
      nested: { ok: 1 },
    }) as Record<string, unknown>
    expect(out.text).toBe('hi')
    expect(out.rawNode).toBeUndefined()
    expect(out.blob).toEqual({ _type: 'binary', length: 3 })
    expect(out.nested).toEqual({ ok: 1 })
  })
})
