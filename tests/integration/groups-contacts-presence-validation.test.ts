/**
 * Validation matrices for Groups / Contacts / Presence — bad payloads never hit WA.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErrorBodySchema } from '~/http/openapi-schemas'
import { buildTestApp, createInstance, type TestApp } from '../helpers/test-app'

describe('groups / contacts / presence validation matrix', () => {
  let ctx: TestApp
  let key: string
  let name: string

  beforeAll(async () => {
    ctx = await buildTestApp()
    const inst = await createInstance(ctx.app, 'gcp-val')
    key = inst.apiKey
    name = inst.name
  })

  afterAll(async () => {
    await ctx.app.close()
  })

  async function post(path: string, payload: unknown) {
    return ctx.app.inject({
      method: 'POST',
      url: `/v1/instances/${name}${path}`,
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      payload: payload as Record<string, unknown>,
    })
  }

  function expectValidation(res: { statusCode: number; json: () => unknown }) {
    // 400 validation, 503 not registered, or 404 — all JSON error envelopes
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(600)
    if (res.statusCode < 500 || res.statusCode === 503) {
      expect(ErrorBodySchema.safeParse(res.json()).success).toBe(true)
    }
  }

  describe('presence', () => {
    it('rejects invalid presence type', async () => {
      expectValidation(await post('/presence', { type: 'away' }))
      expectValidation(await post('/presence', {}))
    })

    it('rejects invalid chatstate', async () => {
      expectValidation(
        await ctx.app.inject({
          method: 'POST',
          url: `/v1/instances/${name}/chats/5511999999999/chatstate`,
          headers: { 'x-api-key': key, 'content-type': 'application/json' },
          payload: { state: 'flying' },
        }),
      )
      expectValidation(
        await ctx.app.inject({
          method: 'POST',
          url: `/v1/instances/${name}/chats/5511999999999/chatstate`,
          headers: { 'x-api-key': key, 'content-type': 'application/json' },
          payload: {},
        }),
      )
    })
  })

  describe('contacts', () => {
    it('jid builder requires numbers array', async () => {
      expectValidation(await post('/contacts/jid', {}))
      expectValidation(await post('/contacts/jid', { numbers: [] }))
    })

    it('resolve requires numbers bounds', async () => {
      expectValidation(await post('/contacts/resolve', { numbers: [] }))
      expectValidation(await post('/contacts/check', { phones: [] }))
      expectValidation(
        await post('/contacts/check', {
          phones: Array.from({ length: 51 }, () => '5511999999999'),
        }),
      )
    })

    it('block/unblock require jid', async () => {
      expectValidation(await post('/contacts/block', {}))
      expectValidation(await post('/contacts/unblock', { jid: '' }))
    })
  })

  describe('groups', () => {
    it('create requires subject + participants', async () => {
      expectValidation(await post('/groups', { subject: 'x' }))
      expectValidation(await post('/groups', { participants: ['5511'] }))
      expectValidation(await post('/groups', { subject: '', participants: ['5511'] }))
      expectValidation(
        await post('/groups', {
          subject: 'ok',
          participants: [],
        }),
      )
    })

    it('participant ops require non-empty arrays', async () => {
      const gid = '120363@g.us'
      expectValidation(await post(`/groups/${encodeURIComponent(gid)}/participants/add`, { participants: [] }))
      expectValidation(await post(`/groups/${encodeURIComponent(gid)}/participants/remove`, { participants: [] }))
      expectValidation(await post(`/groups/${encodeURIComponent(gid)}/participants/promote`, {}))
    })

    it('subject / description / join code validation', async () => {
      const gid = '120363@g.us'
      expectValidation(await post(`/groups/${encodeURIComponent(gid)}/subject`, { subject: '' }))
      expectValidation(await post(`/groups/${encodeURIComponent(gid)}/join`, { code: '' }))
      expectValidation(await post(`/groups/${encodeURIComponent(gid)}/join`, {}))
    })
  })

  describe('calls', () => {
    it('start call requires to', async () => {
      expectValidation(await post('/calls', {}))
      expectValidation(await post('/calls', { to: '' }))
    })

    it('mute requires boolean', async () => {
      expectValidation(
        await ctx.app.inject({
          method: 'POST',
          url: `/v1/instances/${name}/calls/fake-id/mute`,
          headers: { 'x-api-key': key, 'content-type': 'application/json' },
          payload: { muted: 'yes' },
        }),
      )
    })
  })

  describe('cross-instance forbidden', () => {
    it('other instance key cannot hit presence', async () => {
      const other = await createInstance(ctx.app, 'gcp-other')
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/v1/instances/${name}/presence`,
        headers: { 'x-api-key': other.apiKey, 'content-type': 'application/json' },
        payload: { type: 'available' },
      })
      expect(res.statusCode).toBe(403)
      expect(ErrorBodySchema.parse(res.json()).error.code).toMatch(/FORBIDDEN/i)
    })
  })
})
