/** Agent / LLM 共用类型。 */

export interface ChatToolCall {
  id: string
  name: string
  args: unknown
  argsRaw: string
  argsError?: string
}

export interface ToolFunctionDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatToolDef {
  type: 'function'
  function: ToolFunctionDef
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  reasoning_content?: string
  reasoning_text?: string
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
  tool_call_id?: string
  name?: string
}

export interface UsageInfo {
  prompt: number
  completion: number
  total: number
  /** 命中缓存的输入 token（各家叫法不同，已在 llm 层归一）。 */
  cached?: number
  /** 写入缓存的输入 token（Anthropic 风格）。 */
  cacheWrite?: number
  /** completion 里属于推理的部分（DeepSeek/OpenAI reasoning）。 */
  reasoning?: number
}

/** 一次请求的结局，用于用量统计（失败也记，方便算请求数）。 */
export interface UsageOutcome {
  ok: boolean
  ms: number
  errorCode?: string
}

export interface StreamResult {
  text: string
  reasoning: string
  reasoningText?: string
  toolCalls: ChatToolCall[]
  usage?: UsageInfo
  finishReason?: string
}

export interface StreamOptions {
  signal?: AbortSignal
  onText?: (chunk: string) => void
  onReasoning?: (chunk: string) => void
  tools?: ChatToolDef[]
  toolChoice?: 'auto' | 'required' | 'none'
  timeoutMs?: number
  maxRetries?: number
  temperature?: number
  maxTokens?: number
  /**
   * 每次请求结束回调一次（含重试产生的每一次）。
   * 成功拿到 usage 时带 usage；失败只带 outcome，供用量统计记请求数与耗时。
   */
  onUsage?: (usage: UsageInfo | undefined, outcome: UsageOutcome) => void
}

export type LLMErrorCode =
  | 'auth'
  | 'rate'
  | 'network'
  | 'bad_request'
  | 'aborted'
  | 'timeout'
  | 'server'
  | 'unknown'

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: { code: string; message: string; recoverable: boolean }
  warnings?: string[]
}

export type AgentEvent =
  | { type: 'run_start'; taskId: string; runId: string }
  | { type: 'round'; round: number; maxRounds?: number }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  | { type: 'tool_end'; id: string; name: string; result: ToolResult; durationMs: number }
  | { type: 'todo'; todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'compaction'; tokensBefore: number; tokensAfter: number; summarized: number }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; fatal?: boolean }
  | {
      type: 'run_end'
      status: 'done' | 'aborted' | 'error' | 'budget'
      summary: string
      rounds: number
      tools: number
    }

export class LLMError extends Error {
  code: LLMErrorCode
  status?: number
  retryable: boolean
  partial: boolean

  constructor(
    message: string,
    opts: { code: LLMErrorCode; status?: number; retryable?: boolean; partial?: boolean },
  ) {
    super(message)
    this.name = 'LLMError'
    this.code = opts.code
    this.status = opts.status
    this.retryable = opts.retryable ?? false
    this.partial = opts.partial ?? false
  }
}
