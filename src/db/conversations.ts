import { db } from './db'
import { randomId } from '../lib/hash'
import type { Conversation, MessageRecord } from './types'

export async function ensureConversations(): Promise<void> {
  await db.transaction('rw', db.tasks, db.conversations, db.messages, async () => {
    for (const space of await db.tasks.toArray()) {
      const legacy = await db.messages.where('taskId').equals(space.id).filter(m => !m.conversationId).toArray()
      const existing = await db.conversations.where('workspaceId').equals(space.id).first()
      const id = `conversation:${space.id}`
      if (!existing || legacy.length) {
        if (!(await db.conversations.get(id))) {
          await db.conversations.put({ id, title: space.title, workspaceId: space.id, createdAt: space.createdAt, updatedAt: space.updatedAt })
        }
        await db.messages.where('taskId').equals(space.id).filter(m => !m.conversationId).modify({ conversationId: id })
      }
    }
  })
}

export async function createConversation(workspaceId: string, title = '新对话'): Promise<Conversation> {
  if (!(await db.tasks.get(workspaceId))) throw new Error('工作空间不存在')
  const now = Date.now()
  const row: Conversation = { id: randomId('conversation_'), title: title.trim() || '新对话', workspaceId, createdAt: now, updatedAt: now }
  await db.conversations.add(row)
  return row
}

export async function listConversations(): Promise<Conversation[]> {
  return db.conversations.orderBy('updatedAt').reverse().toArray()
}

export async function bindConversation(id: string, workspaceId: string): Promise<void> {
  if (!(await db.tasks.get(workspaceId))) throw new Error('工作空间不存在')
  if (!(await db.conversations.get(id))) throw new Error('对话不存在')
  await db.conversations.update(id, { workspaceId, updatedAt: Date.now() })
}

export async function listConversationMessages(id: string, limit = 1000): Promise<MessageRecord[]> {
  const rows = await db.messages.where('conversationId').equals(id).toArray()
  rows.sort((a, b) => a.createdAt - b.createdAt || (a.id || 0) - (b.id || 0))
  return rows.slice(-limit)
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await db.conversations.update(id, { title: title.trim() || '未命名对话', updatedAt: Date.now() })
}

/**
 * 记录压缩检查点：`upToId` 之前（含）的消息已被摘要覆盖，不再送进模型。
 * 只写摘要不删消息——历史仍能在界面里翻，模型看到的是摘要 + 之后的原文。
 */
export async function saveConversationSummary(id: string, summary: string, upToId: number): Promise<void> {
  await db.conversations.update(id, { summary, summaryUpToId: upToId, summaryUpdatedAt: Date.now() })
}

/** 用户清空摘要（相当于让模型重新读全文）。 */
export async function clearConversationSummary(id: string): Promise<void> {
  await db.conversations.update(id, { summary: undefined, summaryUpToId: undefined, summaryUpdatedAt: undefined })
}
