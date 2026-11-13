import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { DEFAULT_API_SETTINGS, DEFAULT_CAPABILITIES } from '../db/types'
import { createTask, createPreviewSession, getPreviewSession, writeWorkspaceText } from '../db/repo'
import { previewManager } from './manager'

beforeEach(async () => { await db.open(); await Promise.all(db.tables.map((t) => t.clear())) })

async function fixture() {
  const { id } = await createTask('刷新检查')
  const session = { id: `pv:${id}`, taskId: id, name: 'index', entryPath: '/index.html', mode: 'inline' as const, buildVersion: 1, status: 'ready' as const, capabilities: DEFAULT_CAPABILITIES, limitations: [], createdAt: 1, updatedAt: 1 }
  await writeWorkspaceText(id, '/index.html', '<h1>旧页面</h1>')
  await createPreviewSession(session)
  const before = await previewManager.getRenderInfo(session)
  return { id, session, before }
}

describe('当前试玩状态', () => {
  it('失败构建留屏时导出旧成功源码，不取最新文件', async () => {
    const { id, session } = await fixture()
    const frame = document.createElement('iframe'); document.body.append(frame)
    const manager = previewManager as any
    manager.frames.set(session.id, frame)
    previewManager.handleMessage({ source: frame.contentWindow, data: { type: 'ready', sessionId: session.id, buildVersion: 1, capabilities: DEFAULT_CAPABILITIES } } as MessageEvent)
    await writeWorkspaceText(id, '/index.html', '<h1>失败的新版本</h1><img src="missing.png">')
    await expect(previewManager.refresh(session.id)).rejects.toThrow()
    const out = await previewManager.prepareDisplayedExport(session.id)
    expect(out.html).toContain('旧页面')
    expect(out.html).not.toContain('失败的新版本')
    expect(out.report.warnings.join(' ')).toContain('留屏')
    manager.frames.delete(session.id); frame.remove()
  })
  it('取消 AI 请求能匹配带 profile 的请求索引', async () => {
    const { session } = await fixture()
    const frame = document.createElement('iframe'); document.body.append(frame)
    const manager = previewManager as any, controller = new AbortController()
    manager.frames.set(session.id, frame)
    manager.aiControllers.set(`${session.id}:request:profile`, controller)
    previewManager.handleMessage({ source: frame.contentWindow, data: { type: 'ai-cancel', requestId: 'request' } } as MessageEvent)
    expect(controller.signal.aborted).toBe(true)
    manager.aiControllers.delete(`${session.id}:request:profile`); manager.frames.delete(session.id); frame.remove()
  })
  it('新构建缺文件时保留旧页面和构建号，并明确显示失败', async () => {
    const { id, session, before } = await fixture()
    await writeWorkspaceText(id, '/index.html', '<h1>新页面</h1><img src="missing.png">')
    await expect(previewManager.refresh(session.id)).rejects.toThrow('上次成功页面')
    const after = (await getPreviewSession(session.id))!
    expect(after.status).toBe('error')
    expect(after.buildVersion).toBe(1)
    expect((await previewManager.getRenderInfo(after)).srcDoc).toBe(before.srcDoc)
  })

  it('活动 ID 也要校验任务归属才能自动刷新', async () => {
    const { session } = await fixture()
    previewManager.setActiveSession('other-task', session.id)
    const refresh = vi.spyOn(previewManager, 'refresh')
    await expect(previewManager.refreshActiveTask('other-task')).resolves.toBeNull()
    expect(refresh).not.toHaveBeenCalled()
    refresh.mockRestore()
    previewManager.setActiveSession('other-task', null)
  })

  it('只改模型时保留授权、更新后续配置，不取消已开始请求', async () => {
    const { id, session } = await fixture(), manager = previewManager as any
    previewManager.setTaskApiSettings(id, { ...DEFAULT_API_SETTINGS, baseUrl: 'https://a.invalid/v1', model: 'a' })
    previewManager.setAiAuthorized(session.id, true)
    const frozen = manager.aiAuthorized.get(session.id).get('default'), controller = new AbortController()
    manager.aiControllers.set(`${session.id}:running:default`, controller)
    previewManager.setTaskApiSettings(id, { ...DEFAULT_API_SETTINGS, baseUrl: 'https://a.invalid/v1', model: 'b' })
    expect(previewManager.isAiAuthorized(session.id)).toBe(true)
    expect(controller.signal.aborted).toBe(false)
    expect(frozen.model).toBe('a')
    expect(manager.aiAuthorized.get(session.id).get('default').model).toBe('b')
    previewManager.setAiAuthorized(session.id, false)
    expect(controller.signal.aborted).toBe(true)
  })
  it('端点改变只撤销该空间已有的 AI 授权', async () => {
    const { id, session } = await fixture()
    const settings = { ...DEFAULT_API_SETTINGS, baseUrl: 'https://a.invalid/v1', model: 'a' }
    previewManager.setTaskApiSettings(id, settings)
    await previewManager.getRenderInfo(session) // 登记窗口归属
    previewManager.setAiAuthorized(session.id, true)
    expect(previewManager.isAiAuthorized(session.id)).toBe(true)
    previewManager.setTaskApiSettings(id, { ...DEFAULT_API_SETTINGS, baseUrl: 'https://b.invalid/v1', model: 'b' })
    expect(previewManager.isAiAuthorized(session.id)).toBe(false)
  })
})
