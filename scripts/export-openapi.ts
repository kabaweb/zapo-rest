/**
 * Export the live OpenAPI document to openapi.json (for CI / static hosting).
 *
 * Usage (with env loaded):
 *   pnpm openapi:export
 *
 * Builds a dry-run app with a stub pool so no real DB is needed.
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type pg from 'pg'
import { buildApp } from '../src/app'
import { parseEnv, resetEnvCache } from '../src/config/env'
import { InstanceManager } from '../src/instances/manager'
import { InstanceRepo } from '../src/instances/repo'
import { createRootLogger } from '../src/lib/logger'
import { createMediaStorage } from '../src/media/storage'
import { ChatStore } from '../src/store/chats'
import { ContactStore } from '../src/store/contacts'
import { LabelStore } from '../src/store/labels'
import { LidStore } from '../src/store/lids'
import { MessageStore } from '../src/store/messages'
import { WebhookDispatcher } from '../src/webhooks/dispatcher'
import { WebhookConfigRepo } from '../src/webhooks/repo'

async function main() {
  process.env.NODE_ENV ??= 'test'
  process.env.ADMIN_API_KEY ??= 'export-openapi-admin-key'
  process.env.DATABASE_URL ??= 'postgresql://zapo:zapo@127.0.0.1:5432/zapo'
  process.env.AUTO_CONNECT_ON_BOOT ??= 'false'
  process.env.LOG_LEVEL ??= 'fatal'
  process.env.MEDIA_STORAGE ??= 'local'

  resetEnvCache()
  const env = parseEnv()
  createRootLogger(env)

  const pool = {
    query: async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }),
  } as unknown as pg.Pool

  const instanceRepo = new InstanceRepo(pool)
  const messages = new MessageStore(pool)
  const chats = new ChatStore(pool)
  const contacts = new ContactStore(pool)
  const labels = new LabelStore(pool)
  const lids = new LidStore(pool)
  const webhookRepo = new WebhookConfigRepo(pool)
  const mediaStorage = createMediaStorage(env)
  const webhooks = new WebhookDispatcher(env)
  const manager = new InstanceManager({
    env,
    pool,
    repo: instanceRepo,
    webhooks,
    dryRun: true,
  })
  await manager.init()

  const app = await buildApp({
    env,
    pool,
    instanceRepo,
    manager,
    messages,
    chats,
    contacts,
    labels,
    lids,
    webhookRepo,
    mediaStorage,
  })
  await app.ready()

  const spec = app.swagger()
  const out = resolve(process.cwd(), 'openapi.json')
  await writeFile(out, `${JSON.stringify(spec, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${out} (${Object.keys(spec.paths ?? {}).length} paths)`)

  await app.close()
  await manager.shutdown()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
