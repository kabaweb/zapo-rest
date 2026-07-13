import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChatStore, toPublicChat } from '~/store/chats'
import { seedInstance, tryCreateTestPool, uniqueName, wipeInstance } from '../helpers/pg'

// SKIPPED (not silently green) when Postgres is unavailable — resolved at collection time.
const pool = await tryCreateTestPool()

describe.skipIf(!pool)('ChatStore (Postgres)', () => {
  const db = pool as pg.Pool
  let chats: ChatStore
  const inst = uniqueName('chat')

  beforeAll(async () => {
    chats = new ChatStore(db)
    await seedInstance(db, inst)
  })

  afterAll(async () => {
    await wipeInstance(db, inst)
  })

  it('upsert + list + archive + unread + delete', async () => {
    await chats.upsert({
      instanceName: inst,
      chatJid: '5511888888888@s.whatsapp.net',
      name: 'Cliente',
      lastMessageId: 'm1',
      lastMessagePreview: 'oi',
      lastMessageTs: 1_000,
    })
    await chats.upsert({
      instanceName: inst,
      chatJid: '5511888888888@s.whatsapp.net',
      lastMessageId: 'm2',
      lastMessagePreview: 'tchau',
      lastMessageTs: 2_000,
    })

    const got = await chats.get(inst, '5511888888888@s.whatsapp.net')
    expect(got?.lastMessageId).toBe('m2')
    expect(got?.lastMessagePreview).toBe('tchau')
    expect(got?.name).toBe('Cliente')

    const listed = await chats.list(inst, { limit: 20, merge: false })
    expect(listed.some((c) => c.chatJid.includes('5511888888888'))).toBe(true)

    const arch = await chats.setArchived(inst, '5511888888888@s.whatsapp.net', true)
    expect(arch?.archived).toBe(true)

    await chats.setUnread(inst, '5511888888888@s.whatsapp.net', 3)
    expect((await chats.get(inst, '5511888888888@s.whatsapp.net'))?.unreadCount).toBe(3)

    const afterUnread = await chats.get(inst, '5511888888888@s.whatsapp.net')
    expect(afterUnread).toBeTruthy()
    if (!afterUnread) throw new Error('expected chat')
    const pub = toPublicChat(afterUnread)
    expect(pub.id).toBe('5511888888888@s.whatsapp.net')
    expect(pub.lastMessage?.id).toBe('m2')

    expect(await chats.delete(inst, '5511888888888@s.whatsapp.net')).toBe(true)
    expect(await chats.get(inst, '5511888888888@s.whatsapp.net')).toBeNull()
  })

  it('mergeLidIntoPn renames or merges rows', async () => {
    await chats.upsert({
      instanceName: inst,
      chatJid: '111@lid',
      name: 'LID ghost',
      lastMessageId: 'x',
      lastMessageTs: 50,
      lastMessagePreview: 'lid',
      unreadCount: 1,
    })
    await chats.mergeLidIntoPn(inst, '111@lid', '5511666666666@s.whatsapp.net')
    expect(await chats.get(inst, '111@lid')).toBeNull()
    expect((await chats.get(inst, '5511666666666@s.whatsapp.net'))?.name).toBe('LID ghost')

    // second LID into existing PN
    await chats.upsert({
      instanceName: inst,
      chatJid: '222@lid',
      name: 'other',
      lastMessageId: 'y',
      lastMessageTs: 99,
      lastMessagePreview: 'newer',
      unreadCount: 2,
    })
    await chats.mergeLidIntoPn(inst, '222@lid', '5511666666666@s.whatsapp.net')
    const merged = await chats.get(inst, '5511666666666@s.whatsapp.net')
    expect(merged?.lastMessageId).toBe('y')
    expect(merged?.unreadCount).toBeGreaterThanOrEqual(3)
    expect(await chats.get(inst, '222@lid')).toBeNull()
  })
})
