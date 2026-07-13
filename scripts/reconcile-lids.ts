import { parseEnv } from '../src/config/env'
import { migrate } from '../src/db/migrate'
import { closePool, createPool } from '../src/db/pool'
import { InstanceRepo } from '../src/instances/repo'
import { createRootLogger, getLogger } from '../src/lib/logger'
import { reconcileLidChats } from '../src/store/chat-reconcile'
import { ChatStore } from '../src/store/chats'
import { LidMapStore } from '../src/store/lid-map'
import { MessageStore } from '../src/store/messages'

async function main() {
  const env = parseEnv()
  createRootLogger(env)
  const log = getLogger({ component: 'reconcile-lids' })
  const pool = createPool(env)
  await migrate(pool)

  const lidMap = new LidMapStore(pool)
  const chats = new ChatStore(pool)
  const messages = new MessageStore(pool)
  const repo = new InstanceRepo(pool)

  for (const inst of await repo.list()) {
    const r = await reconcileLidChats(pool, inst.name, { lidMap, chats, messages })
    log.info({ instance: inst.name, ...r }, 'reconciled')
  }

  const stats = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE chat_jid LIKE '%@lid') AS lids,
      COUNT(*) FILTER (WHERE chat_jid LIKE '%@s.whatsapp.net') AS pns,
      COUNT(*) AS total
    FROM app_chats
  `)
  const lm = await pool.query('SELECT COUNT(*)::int AS c FROM lid_map')
  console.log('app_chats:', stats.rows[0])
  console.log('lid_map:', lm.rows[0])
  await closePool()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
