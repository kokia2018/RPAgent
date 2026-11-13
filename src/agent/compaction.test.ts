import { describe, expect, it, vi } from 'vitest'
import {
  estimateContextTokens,
  estimateMessageTokens,
  estimateTextTokens,
  findCutIndex,
  isContextOverflow,
  shouldCompact,
  summarizeMessages,
  summaryMessage,
  DEFAULT_COMPACTION_SETTINGS,
} from './compaction'
import { streamChat } from './llm'
import type { ChatMessage } from './types'

vi.mock('./llm', async (original) => ({ ...await original<typeof import('./llm')>(), streamChat: vi.fn() }))

const user = (text: string): ChatMessage => ({ role: 'user', content: text })
const assistant = (text = '', calls: { id: string; name: string; args: string }[] = []): ChatMessage => ({
  role: 'assistant',
  content: text,
  ...(calls.length
    ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args } })) }
    : {}),
})
const tool = (id: string, text: string): ChatMessage => ({ role: 'tool', content: text, tool_call_id: id, name: 'fs_read' })

describe('token 估算', () => {
  it('中文比英文贵：同样的字符数，中文估出来的 token 更多', () => {
    expect(estimateTextTokens('你好世界')).toBeGreaterThan(estimateTextTokens('abcd'))
  })

  it('空内容算 0', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateMessageTokens({ role: 'assistant', content: '' })).toBe(0)
  })

  it('工具参数计入估算', () => {
    const withArgs = estimateMessageTokens(assistant('', [{ id: 'c1', name: 'fs_write', args: '{"path":"/a.html"}' }]))
    expect(withArgs).toBeGreaterThan(estimateMessageTokens(assistant('')))
  })

  it('有真实 usage 时只用它加上后续增量，不重算整段', () => {
    const messages = [user('很长很长的历史'.repeat(100)), assistant('ok'), user('新一句')]
    const anchor = { index: 1, tokens: 1000 }
    const tokens = estimateContextTokens(messages, anchor)
    expect(tokens).toBe(1000 + estimateMessageTokens(messages[2]))
  })

  it('越界锚点退化为全量估算', () => {
    const messages = [user('abc')]
    expect(estimateContextTokens(messages, { index: 9, tokens: 1 })).toBe(estimateMessageTokens(messages[0]))
  })
})

describe('压缩阈值', () => {
  const settings = { ...DEFAULT_COMPACTION_SETTINGS, contextWindow: 1000, reserveTokens: 100 }

  it('占用超过 window - reserve 才压缩', () => {
    expect(shouldCompact(899, settings)).toBe(false)
    expect(shouldCompact(901, settings)).toBe(true)
  })

  it('窗口填 0 等于关掉阈值压缩', () => {
    expect(shouldCompact(999_999, { ...settings, contextWindow: 0 })).toBe(false)
  })
})

describe('切点选择', () => {
  it('绝不切在 tool 上，避免拆散 tool_calls 与结果', () => {
    const messages: ChatMessage[] = [
      user('做一个页面'),
      assistant('', [{ id: 'c1', name: 'fs_write', args: '{}' }]),
      tool('c1', '内容'.repeat(200)),
      assistant('', [{ id: 'c2', name: 'fs_read', args: '{}' }]),
      tool('c2', '内容'.repeat(200)),
      assistant('写好了'),
    ]
    const cut = findCutIndex(messages, 10)
    expect(cut).toBeGreaterThan(0)
    expect(messages[cut].role).not.toBe('tool')
  })

  it('单次长任务里可以切在新一轮 assistant 上', () => {
    const messages: ChatMessage[] = [
      user('任务'),
      assistant('', [{ id: 'c1', name: 'fs_read', args: '{}' }]),
      tool('c1', '结果'.repeat(100)),
      assistant('', [{ id: 'c2', name: 'fs_read', args: '{}' }]),
      tool('c2', '结果'.repeat(100)),
      assistant('收尾'),
    ]
    const cut = findCutIndex(messages, 200)
    expect(cut).toBe(3)
    expect(messages[cut].role).toBe('assistant')
    // 切点后面必须带着这一轮的工具结果，不能只剩调用
    expect(messages[cut + 1].role).toBe('tool')
  })

  it('消息太少或全部在保留预算内就不压缩', () => {
    expect(findCutIndex([user('a'), assistant('b')], 10)).toBe(0)
    expect(findCutIndex([user('a'), assistant('b'), user('c'), assistant('d')], 100_000)).toBe(0)
  })
})

describe('摘要消息', () => {
  it('用 summary 标签包住，并提示不要假设状态', () => {
    const message = summaryMessage('## 目标\n做页面')
    expect(message.role).toBe('user')
    expect(message.content).toContain('<summary>')
    expect(message.content).toContain('</summary>')
    expect(message.content).toContain('做页面')
    expect(message.content).toContain('不要假设')
  })
})

describe('超窗错误识别', () => {
  it('识别常见网关的报错文案', () => {
    expect(isContextOverflow('prompt is too long: 213462 tokens > 200000 maximum')).toBe(true)
    expect(isContextOverflow("This model's maximum context length is 131072 tokens")).toBe(true)
    expect(isContextOverflow('Range of input length should be [1, 6144]')).toBe(true)
    expect(isContextOverflow('413 Request Entity Too Large')).toBe(true)
  })

  it('普通错误不误判', () => {
    expect(isContextOverflow('401 Unauthorized')).toBe(false)
    expect(isContextOverflow('network timeout')).toBe(false)
    expect(isContextOverflow('')).toBe(false)
  })
})

describe('摘要生成', () => {
  it('把历史渲染成转录并请求摘要', async () => {
    vi.mocked(streamChat).mockReset()
    vi.mocked(streamChat).mockResolvedValueOnce({ text: '## 目标\n做一个能改的页面\n## 进展\n### 已完成\n- [x] 写好 index.html\n## 下一步\n1. 打开试玩并观察真实交互', reasoning: '', toolCalls: [] })
    const summary = await summarizeMessages([user('做一个页面'), assistant('好')], {
      config: { baseUrl: 'http://model.invalid/v1', apiKey: 'k', model: 'm', temperature: 0.7 },
    })
    expect(summary).toContain('## 目标')
    const sent = vi.mocked(streamChat).mock.calls[0][0]
    expect(sent[0].role).toBe('system')
    expect(sent[1].content).toContain('[用户] 做一个页面')
    expect(sent[1].content).toContain('保留确切的文件路径')
  })

  it('带旧摘要时走合并规则', async () => {
    vi.mocked(streamChat).mockReset()
    vi.mocked(streamChat).mockResolvedValueOnce({ text: '## 目标\n继续把页面做完\n## 已完成\n- [x] 旧摘要里的工作全部保留\n## 下一步\n1. 打开试玩验证关键交互', reasoning: '', toolCalls: [] })
    await summarizeMessages([user('继续')], {
      config: { baseUrl: 'http://model.invalid/v1', apiKey: 'k', model: 'm', temperature: 0.7 },
      previousSummary: '旧摘要内容',
    })
    const prompt = String(vi.mocked(streamChat).mock.calls[0][0][1].content)
    expect(prompt).toContain('旧摘要内容')
    expect(prompt).toContain('合并进已有的摘要')
  })

  it('摘要为空或过短时报错，交给调用方决定是否继续', async () => {
    vi.mocked(streamChat).mockReset()
    vi.mocked(streamChat).mockResolvedValueOnce({ text: '   ', reasoning: '', toolCalls: [] })
    await expect(summarizeMessages([user('a')], {
      config: { baseUrl: 'http://model.invalid/v1', apiKey: 'k', model: 'm', temperature: 0.7 },
    })).rejects.toThrow(/空内容/)
  })
})
