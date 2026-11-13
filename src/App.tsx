import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ApiSettings, Conversation, Task, TaskApiOverride, UiSettings } from './db/types'
import { DEFAULT_API_SETTINGS, DEFAULT_UI_SETTINGS } from './db/types'
import { db, clearTaskApiOverride, getApiSettings, getSetting, getTaskApiOverride, getUiSettings, mergeApiSettings, saveApiSettings, saveTaskApiOverride, saveUiSettings, setSetting } from './db/db'
import { createTask, deleteTask, listTasks, markInterruptedTasks, updateTask } from './db/repo'
import { bindConversation, createConversation, ensureConversations, listConversations, renameConversation } from './db/conversations'
import { useLiveQueryValue } from './ui/hooks'
import { useToast } from './ui/toast'
import { TopBar, type Layout, type Pane } from './ui/TopBar'
import { TaskDrawer } from './ui/tasks/TaskDrawer'
import { AgentLayer, PreviewLayer, Workbench, type DocRequest, type RunRequest } from './ui/Workbench'
import { SettingsPage } from './ui/settings/SettingsPage'
import { LibraryPage } from './ui/library/LibraryPage'
import type { AgentSeed } from './ui/agent/AgentPanel'
import { Modal } from './ui/Modal'
import { previewManager } from './preview/manager'
import { getPreviewFocus, subscribePreviewFocus } from './preview/focus'
import { PreviewTabs } from './ui/preview/PreviewTabs'

// 同时序列化两个新标签页打开空库的情况。
async function initialConversationId(): Promise<string> {
  await ensureConversations()
  return db.transaction('rw', db.tasks, db.conversations, db.settings, async () => {
    const last = await getSetting<string>('lastConversationId', '')
    if (last && await db.conversations.get(last)) return last
    const latest = await db.conversations.orderBy('updatedAt').last()
    if (latest) return latest.id
    const space = await createTask('新工作空间')
    return (await createConversation(space.id, '新对话')).id
  })
}

/** 每个空间的有效模型配置：全局设置 + 该空间的覆盖。 */
function useSpaceSettings(spaceIds: string[], base: ApiSettings): Record<string, ApiSettings> {
  const key = spaceIds.join('|')
  const overrides = useLiveQueryValue(
    async () => Object.fromEntries(await Promise.all(spaceIds.map(async (id) => [id, await getTaskApiOverride(id)] as const))),
    [key],
    null as Record<string, TaskApiOverride> | null,
  )
  return useMemo(() => {
    const out: Record<string, ApiSettings> = {}
    if (!overrides) return out
    for (const id of spaceIds) if (overrides[id]) out[id] = mergeApiSettings(base, overrides[id])
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, base, key])
}

export default function App() {
  const { toast } = useToast()
  const [ready, setReady] = useState(false)
  const [startupError, setStartupError] = useState('')
  const [settings, setSettings] = useState<ApiSettings>(DEFAULT_API_SETTINGS)
  const [uiSettings, setUiSettings] = useState<UiSettings>(DEFAULT_UI_SETTINGS)
  const [conversationId, setConversationId] = useState('')
  const [layout, setLayout] = useState<Layout>('agent')
  const [view, setView] = useState<'workbench' | 'library' | 'settings'>('workbench')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Task | null>(null)
  const [seed, setSeed] = useState<(AgentSeed & { conversationId: string }) | null>(null)
  // 打开过的对话/空间保持挂载，切换时只隐藏：运行中的 Agent 不被中止，iframe 状态不丢。
  const [mountedConversations, setMountedConversations] = useState<string[]>([])
  const [mountedSpaces, setMountedSpaces] = useState<string[]>([])
  // 试玩是独立程序：前台显示哪个空间的窗口，由聚焦状态决定，不跟对话走。
  const [previewSpaceId, setPreviewSpaceId] = useState('')
  const [docRequests, setDocRequests] = useState<Record<string, DocRequest | null>>({})
  const [runRequests, setRunRequests] = useState<Record<string, RunRequest | null>>({})
  const running = useRef(new Set<string>())

  const tasks = useLiveQueryValue(() => listTasks(), [], [])
  const conversations = useLiveQueryValue(() => listConversations(), [], [] as Conversation[])
  const currentConversation = conversations.find((c) => c.id === conversationId)
  const currentTask = tasks.find((t) => t.id === currentConversation?.workspaceId)
  const spaceId = currentTask?.id || ''

  const spaceSettings = useSpaceSettings(mountedSpaces, settings)
  const currentOverride = useLiveQueryValue(async () => ({ id: spaceId, override: spaceId ? await getTaskApiOverride(spaceId) : {} }), [spaceId], null as { id: string; override: TaskApiOverride } | null)
  const override = currentOverride?.id === spaceId ? currentOverride.override : null

  // 每个空间各自登记配置；只有该空间的凭据或端点变化才撤销它自己的试玩授权。
  useLayoutEffect(() => {
    for (const [id, value] of Object.entries(spaceSettings)) previewManager.setTaskApiSettings(id, value)
  }, [spaceSettings])
  useEffect(() => { previewManager.setPreviewMode(uiSettings.previewSecurity) }, [uiSettings.previewSecurity])
  useEffect(() => {
    const onMessage = (event: MessageEvent) => previewManager.handleMessage(event)
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await markInterruptedTasks()
      const [api, ui, id] = await Promise.all([getApiSettings(), getUiSettings(), initialConversationId()])
      if (cancelled) return
      setSettings(api); setUiSettings(ui); setLayout(ui.mobileTab); setConversationId(id); setReady(true)
    })().catch((e) => { if (!cancelled) setStartupError(String(e)) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!conversationId) return
    void setSetting('lastConversationId', conversationId)
    setMountedConversations((list) => (list.includes(conversationId) ? list : [...list, conversationId]))
  }, [conversationId])
  const focus = useSyncExternalStore(subscribePreviewFocus, getPreviewFocus, getPreviewFocus)
  useEffect(() => {
    if (focus?.taskId) setPreviewSpaceId(focus.taskId)
  }, [focus?.taskId, focus?.sessionId])
  useEffect(() => {
    if (!previewSpaceId && spaceId) setPreviewSpaceId(spaceId)
  }, [spaceId, previewSpaceId])
  useEffect(() => {
    if (spaceId) setMountedSpaces((list) => (list.includes(spaceId) ? list : [...list, spaceId]))
  }, [spaceId])
  // 打开过窗口的空间都要保持挂载，切走再切回来 iframe 不会重建。
  const spacesWithWindows = useLiveQueryValue(
    async () => Array.from(new Set((await db.previewSessions.toArray()).filter((s) => s.status !== 'closed').map((s) => s.taskId))),
    [],
    [] as string[],
  )
  const windowSpaceKey = spacesWithWindows.join('|')
  useEffect(() => {
    if (!spacesWithWindows.length) return
    setMountedSpaces((list) => {
      const next = new Set([...list, ...spacesWithWindows])
      return next.size === list.length ? list : Array.from(next)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowSpaceKey])
  // 已删除的对话或空间从常驻层中移除。
  useEffect(() => {
    if (!ready) return
    const liveConversations = new Set(conversations.map((c) => c.id))
    const liveSpaces = new Set(tasks.map((t) => t.id))
    setMountedConversations((list) => list.filter((id) => liveConversations.has(id)))
    setMountedSpaces((list) => list.filter((id) => liveSpaces.has(id)))
    if (conversationId && conversations.length && !liveConversations.has(conversationId)) setConversationId(conversations[0].id)
  }, [conversations, tasks, ready, conversationId])

  const selectConversation = (id: string) => { setConversationId(id); setView('workbench'); setDrawerOpen(false) }
  const handleCreate = async (title = '新对话', workspaceId?: string) => {
    try {
      const target = workspaceId || (await createTask(title === '新对话' ? '新工作空间' : title)).id
      selectConversation((await createConversation(target, title)).id)
    } catch (e) { toast('创建失败：' + String(e), 'error') }
  }
  const handleRebind = async (id: string, workspaceId: string) => {
    // 运行中的 Agent 在启动时已固定自己的目标空间，切换只影响之后的新运行。
    try { await bindConversation(id, workspaceId); toast('已切换工作空间', 'success') } catch (e) { toast('切换失败：' + String(e), 'error') }
  }
  const confirmDelete = async () => {
    if (!pendingDelete) return
    if (conversations.some((c) => c.workspaceId === pendingDelete.id && running.current.has(c.id))) {
      toast('此空间有 Agent 正在运行，请先停止。', 'warning'); return
    }
    try {
      const sessions = await db.previewSessions.where('taskId').equals(pendingDelete.id).toArray()
      for (const session of sessions) await previewManager.close(session.id)
      await deleteTask(pendingDelete.id)
      setPendingDelete(null); setDrawerOpen(false); toast('工作空间已删除', 'info')
    } catch (e) {
      toast('删除未完成：' + String((e as Error)?.message || e), 'error')
    }
  }
  const handleSaveUi = (next: UiSettings) => { setUiSettings(next); void saveUiSettings(next) }
  const showPane = (pane: Pane, focus: boolean) => {
    setView('workbench')
    if (focus || layout !== 'split') setLayout(pane)
    if (uiSettings.mobileTab !== pane) handleSaveUi({ ...uiSettings, mobileTab: pane })
  }
  const revealPreview = () => {
    showPane('preview', false)
    if (window.matchMedia('(min-width: 901px)').matches) setLayout('split')
  }
  const sendToAgent = (text: string) => { setSeed({ id: Date.now(), conversationId, text }); showPane('agent', false) }

  if (!ready) return <div className="splash">{startupError ? `无法打开本地工作区：${startupError}` : '正在打开 RPAgent…'}</div>

  const agentLayers = mountedConversations.map((id) => {
    const c = conversations.find((x) => x.id === id)
    const t = c && tasks.find((x) => x.id === c.workspaceId)
    const s = t ? spaceSettings[t.id] || settings : null
    if (!c || !t || !s) return null
    const visible = id === conversationId
    // key 只跟对话：切换工作空间不重建面板，运行中的 Agent 不会被卸载中止。
    return (
      <div key={id} className="layer" hidden={!visible} inert={!visible}>
        <AgentLayer task={t} conversationId={c.id} conversationTitle={c.title} settings={s}
          seed={seed?.conversationId === id ? seed : null}
          onRevealPreview={revealPreview}
          onRunningChange={(on) => { if (on) running.current.add(id); else running.current.delete(id) }}
          onOpenSettings={() => setView('settings')} onSendToAgent={sendToAgent}
          onOpenDoc={(doc) => setDocRequests((m) => ({ ...m, [t.id]: { id: Date.now(), doc } }))}
          onRequestRun={(path) => setRunRequests((m) => ({ ...m, [t.id]: { id: Date.now(), path } }))} />
      </div>
    )
  })
  const previewLayers = mountedSpaces.map((id) => {
    const t = tasks.find((x) => x.id === id)
    const s = spaceSettings[id] || settings
    if (!t || !s) return null
    const visible = id === (previewSpaceId || spaceId)
    return (
      <div key={id} className="layer" hidden={!visible} inert={!visible}>
        <PreviewLayer task={t} settings={s} onSendToAgent={sendToAgent}
          docRequest={docRequests[id] || null} onCloseDoc={() => setDocRequests((m) => ({ ...m, [id]: null }))}
          runRequest={runRequests[id] || null} onConsumeRunRequest={() => setRunRequests((m) => ({ ...m, [id]: null }))} />
      </div>
    )
  })

  return (
    <div className="app-shell">
      <TopBar task={currentTask} conversationTitle={currentConversation?.title} active={view === 'workbench' ? uiSettings.mobileTab : null} split={layout === 'split'}
        onPane={(pane) => showPane(pane, true)} onSplit={() => { setLayout('split'); setView('workbench') }} onOpenTasks={() => setDrawerOpen(true)}
        onLibrary={() => setView('library')} onSettings={() => setView('settings')} onCreateTask={() => void handleCreate()} />
      <div className={`workspace-layer ${view !== 'workbench' ? 'is-covered' : ''}`} inert={view !== 'workbench'}>
        <Workbench taskId={spaceId} uiSettings={uiSettings} layout={layout} onSaveUi={handleSaveUi}
          agent={agentLayers} preview={<><PreviewTabs />{previewLayers}</>} />
        {!currentTask && <div className="splash">{conversationId ? '正在打开对话…' : <button className="btn btn-primary" onClick={() => void handleCreate()}>开始新对话</button>}</div>}
      </div>
      {view === 'settings' && override && <SettingsPage key={spaceId} settings={settings} taskOverride={override} hasTaskOverride={Object.keys(override).length > 0}
        uiSettings={uiSettings} taskId={currentTask?.id} taskTitle={currentTask?.title}
        onSave={async (next) => { await saveApiSettings(next); setSettings(next) }}
        onSaveOverride={(next) => saveTaskApiOverride(spaceId, next)} onClearOverride={() => clearTaskApiOverride(spaceId)}
        onSaveUi={handleSaveUi} onBack={() => setView('workbench')}
        onImportedTask={async (id) => {
          const c = conversations.find((x) => x.workspaceId === id) || await createConversation(id, '导入的对话')
          selectConversation(c.id)
        }} />}
      {view === 'library' && <LibraryPage taskId={currentTask?.id} onBack={() => setView('workbench')} onSendToAgent={sendToAgent} />}
      <TaskDrawer open={drawerOpen} tasks={tasks} conversations={conversations} currentConversationId={conversationId}
        isRunning={(id) => running.current.has(id)}
        onClose={() => setDrawerOpen(false)} onSelect={selectConversation} onCreate={handleCreate} onRebind={handleRebind}
        onRename={async (id, title) => { await renameConversation(id, title); toast('已重命名', 'success') }}
        onRenameSpace={async (id, title) => { await updateTask(id, { title }); toast('已重命名空间', 'success') }}
        onDelete={(id) => setPendingDelete(tasks.find((t) => t.id === id) || null)} />
      <Modal open={Boolean(pendingDelete)} title="删除工作空间？" subtitle={pendingDelete?.title} onClose={() => setPendingDelete(null)} footer={<div className="modal-actions">
        <button className="btn btn-ghost" onClick={() => setPendingDelete(null)}>取消</button><button className="btn btn-danger" onClick={() => void confirmDelete()}>确认删除</button></div>}>
        <p className="delete-warning">此空间的文件、试玩窗口、日志、快照和作品存档，以及绑定到它的所有对话都会被删除，无法恢复。建议先导出重要作品。</p>
      </Modal>
    </div>
  )
}
