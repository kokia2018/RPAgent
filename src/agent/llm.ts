import type { ApiSettings } from '../db/types'
import { apiEndpoint, normalizeBaseUrl } from '../lib/url'
import { LLMError, type ChatMessage, type StreamOptions, type StreamResult, type UsageInfo } from './types'

export { normalizeBaseUrl }

export interface LLMConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
}

export function configFromSettings(api: ApiSettings): LLMConfig {
  return {
    baseUrl: normalizeBaseUrl(api.baseUrl),
    apiKey: String(api.apiKey || '').trim().replace(/^Bearer\s+/i, ''),
    model: String(api.model || '').trim(),
    temperature: Number.isFinite(api.temperature) ? api.temperature : 0.7,
  }
}

function endpoint(config: LLMConfig, path: string): string {
  return apiEndpoint(config.baseUrl, path)
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .join('')
  }
  return ''
}

function errorMessageFromBody(text: string): string {
  const raw = String(text || '').trim()
  if (!raw) return ''
  try {
    const j = JSON.parse(raw) as {
      error?: { message?: string; type?: string } | string
      message?: string
    }
    if (typeof j.error === 'string') return j.error
    if (j.error?.message) return j.error.message
    if (j.message) return j.message
  } catch {
    // ignore
  }
  return raw.slice(0, 500)
}

function classifyHttpError(status: number, body: string): LLMError {
  const message = errorMessageFromBody(body) || `HTTP ${status}`
  const suffix = `HTTP ${status}: ${message}`
  if (status === 401 || status === 403) {
    return new LLMError(suffix, { code: 'auth', status, retryable: false })
  }
  if (status === 429) {
    return new LLMError(suffix, { code: 'rate', status, retryable: true })
  }
  if (status >= 500) {
    return new LLMError(suffix, { code: 'server', status, retryable: true })
  }
  return new LLMError(suffix, { code: 'bad_request', status, retryable: false })
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 各家 usage 的缓存字段不一样，统一成 cached（命中缓存）与 cacheWrite（写入缓存）：
 * - OpenAI：`prompt_tokens_details.cached_tokens`
 * - DeepSeek：`prompt_cache_hit_tokens`
 * - Anthropic / OpenRouter：`cache_read_input_tokens` / `cache_creation_input_tokens`
 * - 推理 token：`completion_tokens_details.reasoning_tokens` 或 `reasoning_tokens`
 */
function normalizeUsage(raw: unknown): UsageInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  if (u.prompt_tokens == null && u.completion_tokens == null && u.total_tokens == null) return undefined
  const promptDetails = (u.prompt_tokens_details || {}) as Record<string, unknown>
  const completionDetails = (u.completion_tokens_details || {}) as Record<string, unknown>
  const prompt = num(u.prompt_tokens)
  const completion = num(u.completion_tokens)
  const cached = num(u.cached_tokens) || num(promptDetails.cached_tokens) || num(u.prompt_cache_hit_tokens) || num(u.cache_read_input_tokens)
  const cacheWrite = num(u.cache_creation_input_tokens) || num(promptDetails.cache_write_tokens)
  const reasoning = num(u.reasoning_tokens) || num(completionDetails.reasoning_tokens)
  return {
    prompt,
    completion,
    total: num(u.total_tokens) || prompt + completion,
    ...(cached ? { cached: Math.min(cached, prompt || cached) } : {}),
    ...(cacheWrite ? { cacheWrite } : {}),
    ...(reasoning ? { reasoning } : {}),
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LLMError('已中止', { code: 'aborted' }))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new LLMError('已中止', { code: 'aborted' }))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const RETRYABLE_NETWORK = /Failed to fetch|fetch failed|network|ECONNRESET|ETIMEDOUT|socket|terminated|other side closed|Load failed/i

export async function streamChat(
  messages: ChatMessage[],
  config: LLMConfig,
  options: StreamOptions = {},
): Promise<StreamResult> {
  if (!config.baseUrl) throw new LLMError('未配置 API Base URL', { code: 'bad_request' })
  if (!config.model) throw new LLMError('未配置模型名称', { code: 'bad_request' })

  const maxRetries = options.maxRetries ?? 2
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const startedAt = Date.now()
    try {
      return await streamOnce(messages, config, options)
    } catch (e) {
      lastError = e
      const err =
        e instanceof LLMError
          ? e
          : new LLMError(String((e as Error)?.message || e), {
              code: RETRYABLE_NETWORK.test(String((e as Error)?.message || e)) ? 'network' : 'unknown',
              retryable: RETRYABLE_NETWORK.test(String((e as Error)?.message || e)),
            })
      // 失败的尝试也算一次请求：只记次数与耗时，没有 usage 就不猜 token。
      // 用户主动中止不记，否则统计里全是"中止"。
      if (err.code !== 'aborted') {
        options.onUsage?.(undefined, { ok: false, ms: Date.now() - startedAt, errorCode: err.code })
      }
      if (err.code === 'aborted' || err.partial || !err.retryable || attempt === maxRetries) throw err
      const wait = err.code === 'rate' ? 8000 * (attempt + 1) : 1200 * Math.pow(2, attempt)
      await delay(wait, options.signal)
    }
  }
  throw lastError
}

async function streamOnce(
  messages: ChatMessage[],
  config: LLMConfig,
  options: StreamOptions,
): Promise<StreamResult> {
  const startedAt = Date.now()
  const controller = new AbortController()
  let timedOut = false
  const timeoutMs = options.timeoutMs ?? 180_000
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onExternalAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer)
      throw new LLMError('已中止', { code: 'aborted' })
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  let receivedAny = false
  const cleanup = () => {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }

  try {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: true,
      temperature: options.temperature ?? config.temperature,
    }
    if (options.maxTokens) body.max_tokens = options.maxTokens
    if (options.tools?.length) {
      body.tools = options.tools
      body.tool_choice = options.toolChoice || 'auto'
    }

    let resp: Response
    try {
      resp = await fetch(endpoint(config, 'chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (e) {
      if (options.signal?.aborted) throw new LLMError('已中止', { code: 'aborted' })
      if (timedOut) throw new LLMError(`请求超时（${Math.round(timeoutMs / 1000)}s）`, { code: 'timeout', retryable: true })
      const msg = String((e as Error)?.message || e)
      throw new LLMError(`网络请求失败：${msg}`, {
        code: 'network',
        retryable: true,
      })
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw classifyHttpError(resp.status, text)
    }

    const contentType = resp.headers.get('content-type') || ''
    if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
      const text = await resp.text()
      throw new LLMError(`服务返回了非流式响应：${errorMessageFromBody(text) || text.slice(0, 300)}`, {
        code: 'bad_request',
        retryable: false,
      })
    }
    if (!resp.body) throw new LLMError('服务未返回响应体', { code: 'server', retryable: true })

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    let reasoning = ''
    let reasoningText = ''
    let usage: UsageInfo | undefined
    let finishReason: string | undefined
    const calls: { id: string; name: string; argsRaw: string }[] = []

    const handleData = (payload: string) => {
      if (!payload || payload === '[DONE]') return
      let j: Record<string, unknown>
      try {
        j = JSON.parse(payload) as Record<string, unknown>
      } catch {
        return
      }
      const u = normalizeUsage(j.usage)
      if (u) usage = u
      const choices = j.choices as
        | {
            delta?: Record<string, unknown>
            message?: Record<string, unknown>
            finish_reason?: string | null
          }[]
        | undefined
      const choice = choices?.[0]
      if (!choice) return
      if (choice.finish_reason) finishReason = choice.finish_reason
      const delta = (choice.delta || choice.message || {}) as Record<string, unknown>
      const content = textOfContent(delta.content)
      if (content) {
        receivedAny = true
        text += content
        options.onText?.(content)
      }
      const r = delta.reasoning_content ?? delta.reasoning
      if (typeof r === 'string' && r) {
        receivedAny = true
        reasoning += r
        options.onReasoning?.(r)
      }
      if (typeof delta.reasoning_text === 'string') {
        reasoningText += delta.reasoning_text
        receivedAny = true
        options.onReasoning?.(delta.reasoning_text)
      }
      const toolCalls = delta.tool_calls as
        | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
        | undefined
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          receivedAny = true
          const i = Number.isFinite(tc.index) ? Number(tc.index) : 0
          const cur = calls[i] || (calls[i] = { id: '', name: '', argsRaw: '' })
          if (tc.id) cur.id = tc.id
          const nameChunk = tc.function?.name
          if (nameChunk && !cur.name.includes(nameChunk)) cur.name += nameChunk
          if (tc.function?.arguments) cur.argsRaw += tc.function.arguments
        }
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '')
        if (!line || line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:')) continue
        if (!line.startsWith('data:')) continue
        handleData(line.slice(5).trim())
      }
    }
    if (buffer.trim().startsWith('data:')) handleData(buffer.trim().slice(5).trim())

    const toolCalls = calls
      .filter((c) => c && c.name)
      .map((c, i) => {
        let args: unknown = {}
        let argsError: string | undefined
        try {
          args = c.argsRaw ? JSON.parse(c.argsRaw) : {}
        } catch (e) {
          args = {}
          argsError = String((e as Error)?.message || e)
        }
        return {
          id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
          name: c.name,
          args,
          argsRaw: c.argsRaw,
          argsError,
        }
      })

    options.onUsage?.(usage, { ok: true, ms: Date.now() - startedAt })
    return { text, reasoning, reasoningText, toolCalls, usage, finishReason }
  } catch (e) {
    if (e instanceof LLMError) {
      if (!e.partial) e.partial = receivedAny
      throw e
    }
    if (options.signal?.aborted) throw new LLMError('已中止', { code: 'aborted' })
    if (timedOut) {
      throw new LLMError(`请求超时（${Math.round(timeoutMs / 1000)}s）`, {
        code: 'timeout',
        retryable: !receivedAny,
        partial: receivedAny,
      })
    }
    const msg = String((e as Error)?.message || e)
    throw new LLMError(`模型请求失败：${msg}`, {
      code: 'unknown',
      retryable: !receivedAny,
      partial: receivedAny,
    })
  } finally {
    cleanup()
  }
}

async function withFetchTimeout(ms: number, run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export async function testConnection(config: LLMConfig): Promise<{
  ok: boolean
  status: number
  ms: number
  sample: string
  error?: string
}> {
  const started = Date.now()
  if (!config.baseUrl) return { ok: false, status: 0, ms: 0, sample: '', error: '先填 Base URL' }
  try {
    const resp = await withFetchTimeout(20_000, (signal) => fetch(endpoint(config, 'chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: '只回一个字：好' }],
        max_tokens: 8,
        stream: false,
      }),
      signal,
    }))
    const text = await resp.text()
    const ms = Date.now() - started
    if (!resp.ok) {
      return { ok: false, status: resp.status, ms, sample: text.slice(0, 500), error: errorMessageFromBody(text) }
    }
    return { ok: true, status: resp.status, ms, sample: text.slice(0, 500) }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      sample: '',
      error: String((e as Error)?.message || e),
    }
  }
}

export async function fetchModels(config: LLMConfig): Promise<string[]> {
  if (!config.baseUrl) throw new Error('先填 Base URL')
  const resp = await withFetchTimeout(20_000, (signal) =>
    fetch(endpoint(config, 'models'), {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      signal,
    }),
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status} ${errorMessageFromBody(text) || text.slice(0, 200)}`)
  }
  const data = (await resp.json()) as { data?: unknown[]; models?: unknown[] } | unknown[]
  const list = Array.isArray(data) ? data : data.data || data.models || []
  return list
    .map((m) => {
      if (typeof m === 'string') return m
      const o = m as { id?: string; name?: string }
      return o.id || o.name || ''
    })
    .filter(Boolean)
}
