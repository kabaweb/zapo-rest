import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realtimeBus } from '~/events/bus'
import { ADMIN_KEY, buildTestApp, createInstance, type TestApp } from '../helpers/test-app'

async function collectSse(
  url: string,
  headers: Record<string, string>,
  opts?: { maxDataFrames?: number; timeoutMs?: number },
): Promise<{ status: number; frames: unknown[]; headerStatus?: number }> {
  const maxDataFrames = opts?.maxDataFrames ?? 1
  const timeoutMs = opts?.timeoutMs ?? 4000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream', ...headers },
      signal: controller.signal,
    })

    if (res.status !== 200 || !res.body) {
      clearTimeout(timer)
      // try parse JSON error body
      try {
        await res.text()
      } catch {
        /* */
      }
      return { status: res.status, frames: [] }
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const frames: unknown[] = []

    while (frames.length < maxDataFrames) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const part of parts) {
        const dataLine = part.split('\n').find((l) => l.startsWith('data: '))
        if (dataLine) {
          try {
            frames.push(JSON.parse(dataLine.slice(6)))
          } catch {
            /* ignore non-json data */
          }
        }
      }
    }

    try {
      await reader.cancel()
    } catch {
      /* */
    }
    controller.abort()
    clearTimeout(timer)
    return { status: res.status, frames }
  } catch (err) {
    clearTimeout(timer)
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 0, frames: [] }
    }
    throw err
  }
}

describe('SSE GET /v1/events auth matrix', () => {
  let ctx: TestApp
  let baseUrl: string
  let salesKey: string
  let otherKey: string

  beforeAll(async () => {
    ctx = await buildTestApp()
    await ctx.app.listen({ host: '127.0.0.1', port: 0 })
    const addr = ctx.app.server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`

    salesKey = (await createInstance(ctx.app, 'sales-sse')).apiKey
    otherKey = (await createInstance(ctx.app, 'other-sse')).apiKey
  }, 30_000)

  afterAll(async () => {
    await ctx.app.close()
  })

  it('401 without API key', async () => {
    const res = await fetch(`${baseUrl}/v1/events`, { headers: { Accept: 'text/event-stream' } })
    expect(res.status).toBe(401)
  })

  it('401 with invalid API key', async () => {
    const res = await fetch(`${baseUrl}/v1/events`, {
      headers: { Accept: 'text/event-stream', 'X-Api-Key': 'definitely-not-valid-key!!' },
    })
    expect(res.status).toBe(401)
  })

  it('admin connects and receives connected frame (header auth)', async () => {
    const { status, frames } = await collectSse(`${baseUrl}/v1/events`, {
      'X-Api-Key': ADMIN_KEY,
    })
    expect(status).toBe(200)
    expect(frames[0]).toMatchObject({ event: 'connected', role: 'admin' })
  })

  it('admin can filter by instance query', async () => {
    const { status, frames } = await collectSse(`${baseUrl}/v1/events?instance=sales-sse`, {
      'X-Api-Key': ADMIN_KEY,
    })
    expect(status).toBe(200)
    expect(frames[0]).toMatchObject({
      event: 'connected',
      role: 'admin',
      instance: 'sales-sse',
    })
  })

  it('instance key receives connected scoped to own instance', async () => {
    const { status, frames } = await collectSse(`${baseUrl}/v1/events`, {
      'X-Api-Key': salesKey,
    })
    expect(status).toBe(200)
    expect(frames[0]).toMatchObject({
      event: 'connected',
      role: 'instance',
      instance: 'sales-sse',
    })
  })

  it('instance key cannot filter another instance (403)', async () => {
    const res = await fetch(`${baseUrl}/v1/events?instance=other-sse`, {
      headers: { Accept: 'text/event-stream', 'X-Api-Key': salesKey },
    })
    expect(res.status).toBe(403)
  })

  it('Bearer auth works for SSE', async () => {
    const { status, frames } = await collectSse(`${baseUrl}/v1/events`, {
      Authorization: `Bearer ${salesKey}`,
    })
    expect(status).toBe(200)
    expect(frames.length).toBeGreaterThanOrEqual(1)
    expect(frames[0]).toMatchObject({ event: 'connected', role: 'instance' })
  })

  it('query ?apiKey= fallback works (EventSource compatibility)', async () => {
    const { status, frames } = await collectSse(`${baseUrl}/v1/events?apiKey=${encodeURIComponent(salesKey)}`, {})
    expect(status).toBe(200)
    expect(frames.length).toBeGreaterThanOrEqual(1)
    expect(frames[0]).toMatchObject({ event: 'connected' })
  })

  it('instance key may pass matching instance= query', async () => {
    const { status, frames } = await collectSse(`${baseUrl}/v1/events?instance=sales-sse`, {
      'X-Api-Key': salesKey,
    })
    expect(status).toBe(200)
    expect(frames[0]).toMatchObject({ instance: 'sales-sse' })
  })

  it('instance subscriber only gets own bus events', async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/v1/events`, {
      headers: { Accept: 'text/event-stream', 'X-Api-Key': salesKey },
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    if (!reader) throw new Error('missing SSE body reader')
    const decoder = new TextDecoder()
    let buf = ''

    // drain connected frame
    {
      const { value } = await reader.read()
      if (value) buf += decoder.decode(value, { stream: true })
    }

    realtimeBus.emitInstance({
      instance: 'other-sse',
      event: 'message',
      eventId: 'foreign',
      timestamp: new Date().toISOString(),
      data: { leak: true },
    })
    realtimeBus.emitInstance({
      instance: 'sales-sse',
      event: 'message',
      eventId: 'mine',
      timestamp: new Date().toISOString(),
      data: { body: 'hello' },
    })

    let found: unknown = null
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !found) {
      const readPromise = reader.read()
      const timeout = new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), 200),
      )
      const { value, done } = await Promise.race([readPromise, timeout])
      if (value) buf += decoder.decode(value, { stream: true })
      for (const part of buf.split('\n\n')) {
        const line = part.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        try {
          const json = JSON.parse(line.slice(6)) as { eventId?: string }
          if (json.eventId === 'mine') found = json
          if (json.eventId === 'foreign') {
            controller.abort()
            throw new Error('cross-instance event leaked to instance SSE subscriber')
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('leaked')) throw e
        }
      }
      if (done && !found) break
    }
    controller.abort()
    expect(found).toMatchObject({ eventId: 'mine', instance: 'sales-sse' })
    void otherKey
  })
})
