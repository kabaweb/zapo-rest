import { createRequire } from 'node:module'
import pino, { type Logger } from 'pino'
import type { Env } from '~/config/env'

const require = createRequire(import.meta.url)

let root: Logger | null = null
/** Pretty stream keeps a FD open — must be ended on shutdown or tsx watch hangs. */
let prettyStream: NodeJS.WritableStream | null = null

export function createRootLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  // Avoid pino.transport() worker threads — they keep the process alive after SIGTERM
  // and break `tsx watch` restarts ("Process didn't exit in 5s").
  if (env.NODE_ENV === 'development') {
    const pretty = require('pino-pretty') as (opts: object) => NodeJS.WritableStream
    prettyStream = pretty({
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
      sync: true,
    })
    root = pino({ level: env.LOG_LEVEL }, prettyStream)
  } else {
    root = pino({ level: env.LOG_LEVEL })
  }
  return root
}

export function getLogger(bindings?: Record<string, unknown>): Logger {
  if (!root) {
    root = pino({ level: 'info' })
  }
  return bindings ? root.child(bindings) : root
}

/** Flush and release logger streams so the process can exit (hot reload / SIGTERM). */
export async function closeLogger(): Promise<void> {
  const logger = root
  root = null
  const stream = prettyStream
  prettyStream = null
  if (!logger && !stream) return

  await new Promise<void>((resolve) => {
    const done = () => resolve()
    const t = setTimeout(done, 150)
    try {
      logger?.flush(() => {
        clearTimeout(t)
        if (stream && 'end' in stream && typeof stream.end === 'function') {
          stream.end(() => resolve())
          setTimeout(done, 150)
        } else {
          resolve()
        }
      })
    } catch {
      clearTimeout(t)
      try {
        if (stream && 'end' in stream && typeof (stream as { end: (cb?: () => void) => void }).end === 'function') {
          ;(stream as { end: (cb?: () => void) => void }).end()
        }
      } catch {
        /* */
      }
      resolve()
    }
  })
}
