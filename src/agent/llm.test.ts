import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeBaseUrl, streamChat } from './llm'

const config = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
  temperature: 0.7,
}

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function data(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAI 兼容流式客户端', () => {
  it('分片保留两种推理字段并按原值回传', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => sse([
      data({ choices: [{ delta: { reasoning_content: 'c1', reasoning_text: 't1' } }] }),
      data({ choices: [{ delta: { reasoning_content: 'c2', reasoning_text: 't2', content: '完成' } }] }),
      'data: [DONE]\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const out = await streamChat([{ role: 'user', content: '测试' }], config)
    expect(out.reasoning).toBe('c1c2'); expect(out.reasoningText).toBe('t1t2')
    await streamChat([{ role: 'assistant', content: out.text, reasoning_content: out.reasoning, reasoning_text: out.reasoningText }], config)
    const body = JSON.parse(fetchMock.mock.calls[1][1]?.body as string)
    expect(body.messages[0].reasoning_text).toBe('t1t2')
    expect(body.messages[0].reasoning_content).toBe('c1c2')
  })
  it('解析文本、分片 tool_calls 与 usage', async () => {
    const args1 = '{"path":"/a.html",'
    const args2 = '"content":"hi"}'
    const response = sse([
      data({ choices: [{ delta: { content: '你' } }] }),
      data({ choices: [{ delta: { content: '好' } }] }),
      data({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'fs_write', arguments: args1 } },
              ],
            },
          },
        ],
      }),
      data({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: args2 } }],
            },
          },
        ],
      }),
      data({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      'data: [DONE]\n\n',
    ])
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response)
    vi.stubGlobal('fetch', fetchMock)

    const texts: string[] = []
    const result = await streamChat(
      [{ role: 'user', content: '写文件' }],
      config,
      {
        tools: [
          {
            type: 'function',
            function: {
              name: 'fs_write',
              description: '写文件',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
        onText: (t) => texts.push(t),
      },
    )

    expect(result.text).toBe('你好')
    expect(texts.join('')).toBe('你好')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('fs_write')
    expect(result.toolCalls[0].args).toEqual({ path: '/a.html', content: 'hi' })
    expect(result.usage).toEqual({ prompt: 10, completion: 5, total: 15 })
    expect(result.finishReason).toBe('tool_calls')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://example.test/v1/chat/completions')
  })

  it('401 归类为 auth 且不重试', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"error":{"message":"invalid token"}}', { status: 401 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(streamChat([{ role: 'user', content: 'hi' }], config)).rejects.toMatchObject({
      code: 'auth',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('已中止的信号直接抛出 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      streamChat([{ role: 'user', content: 'hi' }], config, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('规范化 Base URL', () => {
    expect(normalizeBaseUrl('https://cdn.sta1n.cn/v1/v1/')).toBe('https://cdn.sta1n.cn/v1')
    expect(normalizeBaseUrl('https://x.test/v1/chat/completions')).toBe('https://x.test/v1')
    expect(normalizeBaseUrl('https://x.test/v1/models')).toBe('https://x.test/v1')
  })

  it('usage 归一化四种缓存方言并回调 onUsage', async () => {
    const cases: { usage: Record<string, unknown>; cached: number; cacheWrite: number; reasoning: number }[] = [
      { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } }, cached: 60, cacheWrite: 0, reasoning: 0 },
      { usage: { prompt_tokens: 80, completion_tokens: 10, prompt_cache_hit_tokens: 32 }, cached: 32, cacheWrite: 0, reasoning: 0 },
      { usage: { prompt_tokens: 50, completion_tokens: 8, cache_read_input_tokens: 20, cache_creation_input_tokens: 12 }, cached: 20, cacheWrite: 12, reasoning: 0 },
      { usage: { prompt_tokens: 40, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 18 } }, cached: 0, cacheWrite: 0, reasoning: 18 },
    ]
    for (const item of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => sse([
        data({ choices: [{ delta: { content: 'ok' } }], usage: item.usage }),
        'data: [DONE]\n\n',
      ])))
      const seen: { usage?: { cached?: number; cacheWrite?: number; reasoning?: number }; ok: boolean }[] = []
      await streamChat([{ role: 'user', content: 'hi' }], config, {
        maxRetries: 0,
        onUsage: (usage, outcome) => seen.push({ usage, ok: outcome.ok }),
      })
      expect(seen).toHaveLength(1)
      expect(seen[0].ok).toBe(true)
      expect(seen[0].usage?.cached || 0).toBe(item.cached)
      expect(seen[0].usage?.cacheWrite || 0).toBe(item.cacheWrite)
      expect(seen[0].usage?.reasoning || 0).toBe(item.reasoning)
    }
  })

  it('失败请求也回调一次 onUsage，但用户中止不回调', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"boom"}}', { status: 400 })))
    const failures: unknown[] = []
    await expect(
      streamChat([{ role: 'user', content: 'hi' }], config, {
        maxRetries: 0,
        onUsage: (_usage, outcome) => failures.push(outcome),
      }),
    ).rejects.toMatchObject({ code: 'bad_request' })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ ok: false, errorCode: 'bad_request' })

    const controller = new AbortController()
    controller.abort()
    const aborted: unknown[] = []
    await expect(
      streamChat([{ role: 'user', content: 'hi' }], config, {
        signal: controller.signal,
        onUsage: (_usage, outcome) => aborted.push(outcome),
      }),
    ).rejects.toMatchObject({ code: 'aborted' })
    expect(aborted).toHaveLength(0)
  })
})
