import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { DEFAULT_API_SETTINGS } from '../db/types'
import { appendMessage, createTask, getWorkspaceFile, writeWorkspaceText } from '../db/repo'
import { createConversation, listConversationMessages } from '../db/conversations'
import { runAgent } from './loop'
import { streamChat } from './llm'
import { previewManager } from '../preview/manager'
import { LLMError, type ChatToolCall, type StreamResult } from './types'

vi.mock('./llm', async (original) => ({ ...await original<typeof import('./llm')>(), streamChat: vi.fn() }))
const call = (name: string, args: unknown, id = name): ChatToolCall => ({ id, name, args, argsRaw: JSON.stringify(args) })
const result = (toolCalls: ChatToolCall[], text = ''): StreamResult => ({ toolCalls, text, reasoning: '' })
beforeEach(async () => { await db.open(); await Promise.all(db.tables.map((t) => t.clear())); vi.mocked(streamChat).mockReset() })
afterEach(() => vi.restoreAllMocks())

async function task() {
  const task = await createTask('自动试玩')
  await writeWorkspaceText(task.id, '/index.html', '<h1>v1</h1>')
  return task.id
}
const settings = { ...DEFAULT_API_SETTINGS, baseUrl: 'http://model.invalid/v1', model: 'test', maxRounds: 3 }

describe('边聊边改的真实工具循环', () => {
  it('回传推理字段，并把完整工具链保存在所属对话', async () => {
    const id = await task(), c = await createConversation(id)
    vi.mocked(streamChat).mockResolvedValueOnce({ ...result([call('fs_list', {})]), reasoning: 'provider continuation token', reasoningText: 'provider text token' }).mockResolvedValueOnce(result([], '完成'))
    expect((await runAgent({ taskId: id, conversationId: c.id, userText: '列出文件', settings, signal: new AbortController().signal })).status).toBe('done')
    expect(vi.mocked(streamChat).mock.calls[1][0].find(m => m.role === 'assistant')?.reasoning_content).toBe('provider continuation token')
    expect(vi.mocked(streamChat).mock.calls[1][0].find(m => m.role === 'assistant')?.reasoning_text).toBe('provider text token')
    const rows = await listConversationMessages(c.id)
    expect(rows.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    vi.mocked(streamChat).mockReset().mockResolvedValueOnce(result([], '继续完成'))
    await runAgent({ taskId: id, conversationId: c.id, userText: '继续', settings, signal: new AbortController().signal })
    expect(vi.mocked(streamChat).mock.calls[0][0].find(m => m.tool_calls)?.reasoning_content).toBe('provider continuation token')
  })
  it('一批写入只更新一次试玩，下一轮模型拿到自动更新提示', async () => {
    const id = await task()
    await db.previewSessions.add({ id: 'pv', taskId: id, name: 'page', entryPath: '/index.html', status: 'ready', mode: 'inline', buildVersion: 1, capabilities: {} as any, limitations: [], createdAt: 1, updatedAt: 1 })
    previewManager.setActiveSession(id, 'pv')
    const refresh = vi.spyOn(previewManager, 'refreshTaskSession').mockResolvedValue({ sessionId: 'pv', mode: 'inline', ready: true, buildVersion: 7, warnings: [], capabilities: {} as any, limitations: [] })
    vi.mocked(streamChat).mockResolvedValueOnce(result([
      call('fs_write', { path: '/style.css', content: 'body{color:green}' }),
      call('fs_edit', { path: '/index.html', oldString: 'v1', newString: 'v2' }),
    ])).mockResolvedValueOnce(result([], '已改好'))
    const out = await runAgent({ taskId: id, userText: '修改当前页面', settings, signal: new AbortController().signal })
    expect(refresh).toHaveBeenCalledExactlyOnceWith(id, 'pv')
    previewManager.setActiveSession(id, null)
    expect((await getWorkspaceFile(id, '/index.html'))?.text).toContain('v2')
    expect(vi.mocked(streamChat).mock.calls[1][0].some((m) => m.role === 'system' && m.content?.includes('build 7'))).toBe(true)
    expect(out.summary).toContain('尚未完成有效试玩观察')
    expect(out.status).toBe('done')
  })

  it('显式 refresh 不重复自动刷新', async () => {
    const id = await task()
    await db.previewSessions.add({ id: 'pv', taskId: id, name: 'page', entryPath: '/index.html', status: 'ready', mode: 'inline', buildVersion: 1, capabilities: {} as any, limitations: [], createdAt: 1, updatedAt: 1 })
    const automatic = vi.spyOn(previewManager, 'refreshActiveTask').mockResolvedValue(null)
    const refresh = vi.spyOn(previewManager, 'refresh').mockResolvedValue({ sessionId: 'pv', mode: 'inline', ready: true, buildVersion: 2, warnings: [], capabilities: {} as any, limitations: [] })
    vi.mocked(streamChat).mockResolvedValueOnce(result([
      call('fs_edit', { path: '/index.html', oldString: 'v1', newString: 'v2' }),
      call('preview', { action: 'refresh', sessionId: 'pv' }),
    ])).mockResolvedValueOnce(result([], '已改好'))
    await runAgent({ taskId: id, userText: '改页面', settings, signal: new AbortController().signal })
    expect(refresh).toHaveBeenCalledOnce()
    expect(automatic).not.toHaveBeenCalled()
  })

  it('刷新失败保存文件并报告未验证，不吞掉最终回答', async () => {
    const id = await task()
    await db.previewSessions.add({ id: 'pv', taskId: id, name: 'page', entryPath: '/index.html', status: 'ready', mode: 'inline', buildVersion: 1, capabilities: {} as any, limitations: [], createdAt: 1, updatedAt: 1 })
    previewManager.setActiveSession(id, 'pv')
    vi.spyOn(previewManager, 'refreshTaskSession').mockRejectedValue(new Error('缺少依赖'))
    vi.mocked(streamChat).mockResolvedValueOnce(result([call('fs_edit', { path: '/index.html', oldString: 'v1', newString: 'v2' })])).mockResolvedValueOnce(result([], '修改已保存'))
    const events: any[] = []
    const out = await runAgent({ taskId: id, userText: '修改', settings, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
    expect(out.summary).toContain('修改已保存')
    expect(events.some((e) => e.message?.includes('自动更新试玩失败'))).toBe(true)
    previewManager.setActiveSession(id, null)
    expect((await getWorkspaceFile(id, '/index.html'))?.text).toContain('v2')
  })

  it('最后一轮正常问答不是预算耗尽', async () => {
    const id = await task()
    vi.mocked(streamChat).mockResolvedValueOnce(result([], '你好'))
    const out = await runAgent({ taskId: id, userText: '你好', settings: { ...settings, maxRounds: 1 }, signal: new AbortController().signal })
    expect(out.status).toBe('done')
    expect(out.summary).toBe('你好')
  })

  it('每次请求的 usage 都记进用量表，带模型、网关、对话与轮次', async () => {
    const id = await task(), c = await createConversation(id)
    vi.mocked(streamChat).mockResolvedValueOnce(result([], '完成'))
    await runAgent({ taskId: id, conversationId: c.id, userText: '随便说点', settings, signal: new AbortController().signal })

    const options = vi.mocked(streamChat).mock.calls[0][2]
    expect(typeof options?.onUsage).toBe('function')
    options!.onUsage!({ prompt: 100, completion: 20, total: 120, cached: 30 }, { ok: true, ms: 42 })
    await new Promise((r) => setTimeout(r, 0))

    const rows = await db.usageEvents.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'agent',
      model: 'test',
      host: 'model.invalid',
      prompt: 100,
      completion: 20,
      cached: 30,
      total: 120,
      ok: true,
      ms: 42,
      taskId: id,
      conversationId: c.id,
      round: 1,
    })
  })
})

describe('不限轮数与上下文压缩', () => {
  const signal = () => new AbortController().signal

  it('maxRounds=0 时不因轮数停下，靠模型不再调工具结束', async () => {
    const id = await task()
    // 每轮参数不同，避免命中卡死看门狗
    for (let i = 0; i < 6; i++) vi.mocked(streamChat).mockResolvedValueOnce(result([call('fs_list', { path: `/p${i}` })]))
    vi.mocked(streamChat).mockResolvedValueOnce(result([], '全部完成'))
    const out = await runAgent({ taskId: id, userText: '一直改页面', settings: { ...settings, maxRounds: 0 }, signal: signal() })
    expect(out.status).toBe('done')
    expect(out.rounds).toBe(7)
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(7)
  })

  it('到阈值时把较早历史压成摘要，写进对话记录并在下次运行复用', async () => {
    const id = await task(), c = await createConversation(id)
    const compacting = { ...settings, maxRounds: 0, contextWindow: 20, reserveTokens: 0, keepRecentTokens: 1 }
    vi.mocked(streamChat)
      .mockResolvedValueOnce(result([call('fs_list', {}), call('fs_read', { path: '/index.html' }, 'c2')]))
      .mockResolvedValueOnce({ text: '## 目标\n一直改页面\n## 已完成\n- [x] 读过 index.html\n## 下一步\n1. 继续改', reasoning: '', toolCalls: [] })
      .mockResolvedValueOnce(result([], '读完了'))
    const events: any[] = []
    const out = await runAgent({ taskId: id, conversationId: c.id, userText: '一直改页面', settings: compacting, signal: signal(), onEvent: (e) => events.push(e) })
    expect(out.status).toBe('done')
    expect(events.some((e) => e.type === 'compaction')).toBe(true)
    // 压缩后那次请求带着摘要
    const afterCompaction = vi.mocked(streamChat).mock.calls[2][0]
    expect(afterCompaction.some((m) => m.content?.includes('<summary>'))).toBe(true)
    const saved = await db.conversations.get(c.id)
    expect(saved?.summary).toContain('## 目标')
    expect(saved?.summaryUpToId).toBeGreaterThan(0)

    // 下一次运行不再重复压缩，直接用已存的摘要 + 之后的消息
    // 换个正常窗口的配置：这次不该再压（摘要已经存下来了）
    vi.mocked(streamChat).mockReset().mockResolvedValueOnce(result([], '接着做完了'))
    await runAgent({ taskId: id, conversationId: c.id, userText: '继续', settings: { ...settings, maxRounds: 0 }, signal: signal() })
    const first = vi.mocked(streamChat).mock.calls[0][0]
    expect(first.some((m) => m.content?.includes('<summary>'))).toBe(true)
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(1)
  })

  it('接口报上下文超限时压一次再重试', async () => {
    const id = await task(), c = await createConversation(id)
    const conversationId = c.id
    await appendMessage({ taskId: id, conversationId, role: 'user', content: '旧需求：做一个角色卡页面', status: 'done' })
    await appendMessage({ taskId: id, conversationId, role: 'assistant', content: '好，先看看文件', status: 'done' })
    await appendMessage({ taskId: id, conversationId, role: 'user', content: '顺便加个按钮', status: 'done' })
    await appendMessage({ taskId: id, conversationId, role: 'assistant', content: '加好了', status: 'done' })
    vi.mocked(streamChat)
      .mockRejectedValueOnce(new LLMError('prompt is too long: 213462 tokens > 200000 maximum', { code: 'bad_request' }))
      .mockResolvedValueOnce({ text: '## 目标\n做角色卡页面\n## 已完成\n- [x] 加了按钮\n## 下一步\n1. 继续验证', reasoning: '', toolCalls: [] })
      .mockResolvedValueOnce(result([], '压缩后继续完成'))
    const out = await runAgent({ taskId: id, conversationId, userText: '继续', settings: { ...settings, maxRounds: 0, contextWindow: 0, reserveTokens: 0, keepRecentTokens: 1 }, signal: signal() })
    expect(out.status).toBe('done')
    expect(out.summary).toBe('压缩后继续完成')
    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(3)
    expect(String(vi.mocked(streamChat).mock.calls[1][0][1].content)).toContain('旧需求')
  })
})

describe('卡死看门狗', () => {
  it('同一工具同一参数同一结果连续 6 次就停下，不用等轮数上限', async () => {
    const id = await task()
    for (let i = 0; i < 8; i++) vi.mocked(streamChat).mockResolvedValueOnce(result([call('fs_list', {})]))
    const out = await runAgent({ taskId: id, userText: '看看文件', settings: { ...settings, maxRounds: 0 }, signal: new AbortController().signal })
    expect(out.status).toBe('budget')
    expect(out.rounds).toBe(6)
    expect(out.summary).toContain('原地打转')
  })
})
