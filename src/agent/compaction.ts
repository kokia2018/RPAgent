/**
 * 上下文压缩（受 pi 的 compaction 设计影响）。
 *
 * 三件事：
 * 1. 估算当前上下文 token：优先用模型自报的 usage，只对 usage 之后的消息做估算。
 * 2. 超过 `contextWindow - reserveTokens` 时，把较早的一段历史交给模型总结成结构化摘要。
 * 3. 摘要作为一条 user 消息插回上下文，并持久化到对话记录，下次运行继续复用。
 *
 * 不追求和某个 tokenizer 完全一致：估算只需要回答"是不是该压缩了"，
 * 真正精确的数字来自模型返回的 usage。
 */

import type { ChatMessage } from './types'
import { streamChat, type LLMConfig } from './llm'
import { usageSink } from '../db/usage'

/** 英文/代码大约 3.5 字符 1 token；中文按 1.5 字符 1 token 估，混排时分别计算。 */
const LATIN_CHARS_PER_TOKEN = 3.5
const CJK_CHARS_PER_TOKEN = 1.5
const CJK_RE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g

export interface CompactionSettings {
  enabled: boolean
  /** 模型上下文窗口；<= 0 表示不压缩（只靠调用方限制）。 */
  contextWindow: number
  /** 留给模型输出的余量，越过 `window - reserve` 就压缩。 */
  reserveTokens: number
  /** 压缩时保留的最近一段上下文（token）。 */
  keepRecentTokens: number
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  contextWindow: 128_000,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK_RE)?.length ?? 0
  const rest = Math.max(0, text.length - cjk)
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + rest / LATIN_CHARS_PER_TOKEN)
}

export function estimateMessageTokens(message: ChatMessage): number {
  let chars = 0
  chars += estimateTextTokens(typeof message.content === 'string' ? message.content : '')
  if (message.reasoning_content) chars += estimateTextTokens(message.reasoning_content)
  if (message.tool_calls?.length) {
    for (const call of message.tool_calls) {
      chars += estimateTextTokens(call.function?.name || '')
      chars += estimateTextTokens(call.function?.arguments || '')
    }
  }
  if (message.name) chars += estimateTextTokens(message.name)
  return chars
}

export interface UsageAnchor {
  /** usage 所属的 assistant 消息在数组里的下标。 */
  index: number
  /** 该次请求的 prompt + completion（ctx 实际占用）。 */
  tokens: number
}

/**
 * 估算整段上下文。
 * 有真实 usage 时只用它 + 之后新增消息的估算，避免估错累积。
 */
export function estimateContextTokens(messages: readonly ChatMessage[], anchor?: UsageAnchor | null): number {
  if (anchor && anchor.index >= 0 && anchor.index < messages.length) {
    let trailing = 0
    for (let i = anchor.index + 1; i < messages.length; i++) trailing += estimateMessageTokens(messages[i])
    return anchor.tokens + trailing
  }
  let total = 0
  for (const message of messages) total += estimateMessageTokens(message)
  return total
}

export function shouldCompact(tokens: number, settings: CompactionSettings): boolean {
  if (!settings.enabled || settings.contextWindow <= 0) return false
  return tokens > settings.contextWindow - settings.reserveTokens
}

/**
 * 选择压缩切点：返回"从这里开始保留"的下标；返回 0 表示没有可压缩的部分。
 *
 * 从最新往回累计到 `keepRecentTokens`，再对齐到一条 user 或 assistant 消息：
 * - 切在 user：一次新的用户输入，最干净的边界；
 * - 切在 assistant：一轮工具循环的开始，单次长任务里唯一能切的地方；
 * - 绝不切在 tool 上：那会把 assistant.tool_calls 和它的结果拆到两边，
 *   下一次请求会被接口直接拒绝。
 */
export function findCutIndex(messages: readonly ChatMessage[], keepRecentTokens: number): number {
  if (messages.length < 4) return 0
  let accumulated = 0
  let target = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateMessageTokens(messages[i])
    if (accumulated >= keepRecentTokens) {
      target = i
      break
    }
  }
  // 全部消息都在保留预算内：不压。
  if (target <= 0) return 0

  const isCutPoint = (index: number) => {
    const role = messages[index].role
    if (index < 1) return false
    return role === 'user' || role === 'assistant'
  }

  // 先向前找最近的安全切点（少留一点，摘要更省）；再向后退（宁可多留）。
  for (let i = target; i < messages.length; i++) if (isCutPoint(i)) return i
  for (let i = target - 1; i >= 1; i--) if (isCutPoint(i)) return i
  return 0
}

export const SUMMARY_PREFIX = `以下内容是本对话更早阶段的压缩摘要（原始消息已被移除，细节可能不全）：

<summary>
`
export const SUMMARY_SUFFIX = `
</summary>

请以摘要为背景继续工作。需要具体内容时用工具重新读取文件或页面，不要假设摘要没提到的状态。`

export function summaryMessage(summary: string): ChatMessage {
  return { role: 'user', content: SUMMARY_PREFIX + summary.trim() + SUMMARY_SUFFIX }
}

const SUMMARIZER_SYSTEM = `你是一个上下文压缩助手。读取用户提供的对话记录，输出结构化的"上下文检查点摘要"，供另一个 AI 继续工作。
不要继续对话、不要回答问题，只输出摘要本身。`

const SUMMARY_FORMAT = `严格使用下面的格式，每节保持简洁：

## 目标
[用户想完成什么，可能有多项]

## 约束与偏好
- [用户明确提出的要求或偏好；没有就写 (无)]

## 进展
### 已完成
- [x] [已完成的事，含写入/修改过的文件路径]

### 进行中
- [ ] [当前正在做的事]

### 阻塞
- [尚未解决的问题；没有就写 (无)]

## 关键决定
- **[决定]**：[简短理由]

## 下一步
1. [按顺序列出接下来要做什么]

## 关键上下文
- [继续工作必须知道的数据、路径、报错原文；没有就写 (无)]

保留确切的文件路径、函数名和报错原文，不要把工具输出整段抄进来。`

const UPDATE_RULES = `这是一段新的对话记录，请把它合并进已有的摘要（见 <previous-summary>）。规则：
- 保留旧摘要里的全部重要信息，不要丢掉早期决定
- 新增的进展写进"已完成"或"进行中"，完成的从"进行中"移到"已完成"
- 按最新情况重写"下一步"
- 已解决的"阻塞"要删掉
- 保留确切的文件路径、函数名和报错原文`

/** 单条消息在摘要输入里的截断长度，避免摘要请求本身超窗。 */
const TRANSCRIPT_ITEM_CHARS = 6_000
const TRANSCRIPT_TOTAL_CHARS = 180_000

function renderTranscript(messages: readonly ChatMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    const body = typeof message.content === 'string' ? message.content : ''
    const clipped = body.length > TRANSCRIPT_ITEM_CHARS ? `${body.slice(0, TRANSCRIPT_ITEM_CHARS)}\n…（已截断）` : body
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const calls = message.tool_calls
        .map((call) => `${call.function?.name || 'tool'}(${clipToolArgs(call.function?.arguments || '')})`)
        .join(', ')
      parts.push(`[助手]${clipped ? ` ${clipped}` : ''}\n[调用工具] ${calls}`)
      continue
    }
    if (message.role === 'tool') parts.push(`[工具结果 ${message.name || ''}] ${clipped}`)
    else if (message.role === 'system') parts.push(`[系统提示] ${clipped}`)
    else if (message.role === 'user') parts.push(`[用户] ${clipped}`)
    else parts.push(`[助手] ${clipped}`)
  }
  // 超长时丢最早的：最新的进展比最早的需求更影响"下一步"。
  let total = 0
  const kept: string[] = []
  for (let i = parts.length - 1; i >= 0; i--) {
    total += parts[i].length
    if (total > TRANSCRIPT_TOTAL_CHARS) break
    kept.unshift(parts[i])
  }
  return kept.join('\n\n')
}

function clipToolArgs(raw: string): string {
  const text = raw.trim()
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

export interface SummarizeOptions {
  config: LLMConfig
  signal?: AbortSignal
  previousSummary?: string
  /** 覆盖率诊断用；不传就不写。 */
  label?: string
  /** 用量统计归属；摘要请求也算钱，不能漏记。 */
  usage?: { taskId?: string; conversationId?: string; runId?: string }
}

export class CompactionError extends Error {}

/**
 * 把一段历史压成结构化摘要。失败时抛 CompactionError，由调用方决定是否继续原样发请求。
 */
export async function summarizeMessages(
  messages: readonly ChatMessage[],
  options: SummarizeOptions,
): Promise<string> {
  if (!messages.length) throw new CompactionError('没有可压缩的消息')
  const transcript = renderTranscript(messages)
  const previous = options.previousSummary?.trim()
  const instruction = previous
    ? `${UPDATE_RULES}\n\n<previous-summary>\n${previous}\n</previous-summary>\n\n${SUMMARY_FORMAT}`
    : `${SUMMARY_FORMAT}`

  const result = await streamChat(
    [
      { role: 'system', content: SUMMARIZER_SYSTEM },
      { role: 'user', content: `以下是对话记录：\n\n${transcript}\n\n${instruction}` },
    ],
    options.config,
    {
      signal: options.signal,
      maxRetries: 1,
      timeoutMs: 120_000,
      temperature: 0.2,
      onUsage: usageSink({
        source: 'compaction',
        model: options.config.model,
        baseUrl: options.config.baseUrl,
        ...options.usage,
      }),
    },
  )
  const text = (result.text || '').trim()
  if (!text) throw new CompactionError('摘要模型返回了空内容')
  if (text.length < 40) throw new CompactionError('摘要过短，可能没有正常生成')
  return text
}

/**
 * 上下文档位溢出错误的识别。覆盖常见 OpenAI 兼容网关的报错文案。
 * 命中后应该压缩一次再重试；不命中就当普通错误处理。
 */
const OVERFLOW_PATTERNS: RegExp[] = [
  /prompt (?:is )?too long/i,
  /prompt exceeds max length/i,
  /request_too_large/i,
  /exceeds (?:the )?context (?:window|length)/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /context window exceeded/i,
  /maximum context length is \d+ tokens/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /input token count.*exceeds the maximum/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /exceeded model token limit/i,
  /input \(\d+ tokens\) is longer than/i,
  /range of input length should be/i,
  /^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i,
]

export function isContextOverflow(message: string): boolean {
  const text = String(message || '')
  if (!text) return false
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))
}
