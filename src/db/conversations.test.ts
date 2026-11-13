import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { appendMessage, createTask, deleteTask } from './repo'
import { bindConversation, createConversation, ensureConversations, listConversationMessages } from './conversations'

beforeEach(async () => { await db.open(); await Promise.all(db.tables.map(t => t.clear())) })

describe('对话与空间归属', () => {
  it('新空间已有对话时不会补出重复默认对话', async () => {
    const space = await createTask('新空间')
    await createConversation(space.id)
    await ensureConversations()
    await ensureConversations()
    expect(await db.conversations.count()).toBe(1)
  })
  it('旧消息进入明确的迁移对话，不混入新对话', async () => {
    const space = await createTask('旧空间')
    const current = await createConversation(space.id)
    await appendMessage({ taskId: space.id, role: 'assistant', content: '旧消息', status: 'done' })
    await ensureConversations()
    expect(await listConversationMessages(current.id)).toHaveLength(0)
    expect(await listConversationMessages(`conversation:${space.id}`)).toHaveLength(1)
  })
  it('改绑后的历史不随旧空间删除，随当前绑定空间删除', async () => {
    const a = await createTask('A'), b = await createTask('B')
    const conversation = await createConversation(a.id)
    await appendMessage({ taskId: a.id, conversationId: conversation.id, role: 'user', content: '历史', status: 'done' })
    await bindConversation(conversation.id, b.id)
    await deleteTask(a.id)
    expect(await listConversationMessages(conversation.id)).toHaveLength(1)
    await deleteTask(b.id)
    expect(await listConversationMessages(conversation.id)).toHaveLength(0)
  })
})
