/** 试玩页 AI 桥的输入校验与限额。与 iframe 通信解耦，便于单测。 */

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export const AI_MAX_MESSAGES = 40
export const AI_MAX_TOTAL_CHARS = 60_000
export const AI_MAX_PER_MINUTE = 10
export const AI_MAX_PER_DAY = 100

export function normalizeAiMessages(input: unknown): AiChatMessage[] {
  if (!Array.isArray(input)) throw new Error('messages 必须是数组')
  if (!input.length) throw new Error('messages 不能为空')
  if (input.length > AI_MAX_MESSAGES) throw new Error(`messages 最多 ${AI_MAX_MESSAGES} 条`)
  const out: AiChatMessage[] = []
  let total = 0
  for (const item of input) {
    if (!item || typeof item !== 'object') throw new Error('消息格式不正确')
    const role = (item as { role?: unknown }).role
    const content = (item as { content?: unknown }).content
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new Error('消息角色必须是 system / user / assistant')
    }
    if (typeof content !== 'string') throw new Error('消息内容必须是字符串')
    total += content.length
    if (total > AI_MAX_TOTAL_CHARS) throw new Error(`消息总长度超过 ${AI_MAX_TOTAL_CHARS} 字符`)
    out.push({ role, content })
  }
  return out
}

export interface RateLimitResult {
  ok: boolean
  reason?: string
}

export class AiRateLimiter {
  private hits = new Map<string, number[]>()

  allow(sessionId: string, now = Date.now()): RateLimitResult {
    const list = (this.hits.get(sessionId) || []).filter((t) => now - t < 24 * 60 * 60 * 1000)
    const minuteCount = list.filter((t) => now - t < 60 * 1000).length
    if (minuteCount >= AI_MAX_PER_MINUTE) return { ok: false, reason: '请求过于频繁，请稍后再试' }
    if (list.length >= AI_MAX_PER_DAY) return { ok: false, reason: '今天的 AI 请求次数已用完' }
    list.push(now)
    this.hits.set(sessionId, list)
    return { ok: true }
  }

  reset(sessionId: string): void {
    this.hits.delete(sessionId)
  }
}
