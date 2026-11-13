import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ApiSettings, Task } from '../../db/types'
import { listEntryHtmlFiles, listPreviewSessions, updateTask } from '../../db/repo'
import { useLiveQueryValue } from '../hooks'
import { useToast } from '../toast'
import { Icon } from '../icons'
import { Modal } from '../Modal'
import { previewManager } from '../../preview/manager'
import { getPreviewFocus, setPreviewFocus, subscribePreviewFocus } from '../../preview/focus'
import { createPreviewHtml, importPreviewHtml, NEW_PREVIEW_HTML } from '../../preview/importHtml'
import { deliveryLevelText, downloadText, type PreparedExport } from '../../export/exportHtml'
import { createSaveBundle, readSaveBundle } from '../../export/saves'
import { listAppSaves, mergeAppSaves } from '../../db/repo'
import { sanitizeFileName } from '../../lib/path'
import { byteSize } from '../../lib/text'
import { PreviewFrame } from './PreviewFrame'
import { LogDrawer } from './LogDrawer'
import { DocViewer } from '../docs/DocViewer'
import type { DocRequest, RunRequest } from '../Workbench'

export function PreviewPanel({
  task,
  settings,
  onSendToAgent,
  docRequest,
  onCloseDoc,
  runRequest,
  onConsumeRunRequest,
}: {
  task: Task
  settings: ApiSettings
  onSendToAgent: (text: string) => void
  docRequest: DocRequest | null
  onCloseDoc: () => void
  runRequest: RunRequest | null
  onConsumeRunRequest: () => void
}) {
  const { toast } = useToast()
  const sessions = useLiveQueryValue(() => listPreviewSessions(task.id), [task.id], [])
  const htmlFiles = useLiveQueryValue(() => listEntryHtmlFiles(task.id), [task.id], [])
  const [activeId, setActiveId] = useState('')
  const [entryChoice, setEntryChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const [docActive, setDocActive] = useState(false)
  const [aiModalOpen, setAiModalOpen] = useState(false)
  const [aiProfileId, setAiProfileId] = useState('default')
  const [preparedExport, setPreparedExport] = useState<(PreparedExport & { taskId: string }) | null>(null)
  const exportResult = preparedExport?.taskId === task.id ? preparedExport.report : null
  const [savesOpen, setSavesOpen] = useState(false)
  const [saves, setSaves] = useState<{ key: string; value: unknown; updatedAt: number }[]>([])
  const [savesNote, setSavesNote] = useState('')
  const savesInputRef = useRef<HTMLInputElement>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('page.html')
  const [newContent, setNewContent] = useState('')
  const [creating, setCreating] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)
  const importDirRef = useRef<HTMLInputElement>(null)

  const refreshSaves = async () => {
    try {
      setSaves(await listAppSaves(task.id, 'preview'))
      setSavesNote('')
    } catch (e) {
      setSavesNote('读取存档失败：' + String((e as Error)?.message || e))
    }
  }

  const openSaves = async () => {
    setSavesNote('读取中…')
    setSavesOpen(true)
    await refreshSaves()
  }

  const exportSaves = () => {
    const entries: Record<string, unknown> = {}
    for (const row of saves) entries[row.key] = row.value
    downloadText(
      `${sanitizeFileName(task.title, 'app')}-saves.json`,
      JSON.stringify(createSaveBundle(entries, { source: 'preview', app: task.entryPath }), null, 2),
      'application/json',
    )
    setSavesNote(`已导出 ${saves.length} 条存档`)
  }

  const importSaves = async (file?: File | null) => {
    if (!file) return
    try {
      const parsed = readSaveBundle(JSON.parse(await file.text()))
      const result = await mergeAppSaves(task.id, 'preview', parsed.entries, { replace: false })
      await refreshSaves()
      setSavesNote(`已导入 ${result.written} 条${parsed.skipped.length ? `，跳过 ${parsed.skipped.length} 条` : ''}`)
    } catch (e) {
      setSavesNote('导入失败：' + String((e as Error)?.message || e))
    }
  }
  useSyncExternalStore(previewManager.subscribe, previewManager.getVersion)
  const focus = useSyncExternalStore(subscribePreviewFocus, getPreviewFocus, getPreviewFocus)

  const openSessions = useMemo(
    () => sessions.filter((s) => s.status !== 'closed'),
    [sessions],
  )
  const active = openSessions.find((s) => s.id === activeId) || null
  useEffect(() => {
    // 查看文档时保留上一个试玩窗口作为 Agent 默认目标，而不是清空。
    if (!docActive) previewManager.setActiveSession(task.id, active?.id ?? null)
  }, [task.id, active?.id, docActive])
  useEffect(() => () => previewManager.setActiveSession(task.id, null), [task.id])
  const aiAuthorized = active ? previewManager.isAiAuthorized(active.id, aiProfileId) : false
  const aiProfiles = active ? previewManager.getPublicAiProfiles(task.id) : []
  const trusted = active ? previewManager.getTrustedComponent(active.id) : null
  const autoAi = active ? previewManager.isAutoAiAuthorized(active.id) : false
  const componentPaused = active ? previewManager.isComponentAiPaused(task.id, active.entryPath) : false
  const activeLogs = active ? previewManager.getLogs(active.id) : []
  const errorCount = active
    ? activeLogs.filter((l) => l.type === 'error' || l.level === 'error').length
    : 0

  // 标签栏/Agent 打开别的窗口时，这里跟着把前台切到那个会话（同一工作空间内）。
  useEffect(() => {
    if (!focus || focus.taskId !== task.id || focus.sessionId === activeId) return
    const target = openSessions.find((s) => s.id === focus.sessionId)
    if (!target) return
    setActiveId(target.id)
    setEntryChoice(target.entryPath)
    setDocActive(false)
  }, [focus?.sessionId, focus?.taskId, activeId, openSessions, task.id])

  const knownSessions = useRef<Set<string>>(new Set())

  useEffect(() => {
    setActiveId('')
    setEntryChoice('')
    setError('')
    setPreparedExport(null)
    setLogOpen(false)
    setDocActive(false)
    setNewOpen(false)
    setNewName('page.html')
    setNewContent('')
    knownSessions.current.clear()
  }, [task.id])

  useEffect(() => {
    // 目录选择是非标准属性，React 不直接支持，挂载后补齐。
    importDirRef.current?.setAttribute('webkitdirectory', '')
    importDirRef.current?.setAttribute('directory', '')
  }, [])

  useEffect(() => {
    if (entryChoice && (htmlFiles.some((f) => f.path === entryChoice) || active?.entryPath === entryChoice)) return
    const preferred = htmlFiles.find((f) => f.path === task.entryPath)
    setEntryChoice(preferred?.path || htmlFiles[0]?.path || '')
  }, [entryChoice, htmlFiles, task.entryPath, active?.entryPath])

  useEffect(() => {
    const ids = new Set(openSessions.map((s) => s.id))
    for (const id of Array.from(knownSessions.current)) {
      if (!ids.has(id)) knownSessions.current.delete(id)
    }
    const newOnes = openSessions.filter((s) => !knownSessions.current.has(s.id))
    for (const s of openSessions) knownSessions.current.add(s.id)
    if (newOnes.length) {
      // Agent 新建的会话自动切到前台，保证它的 iframe 被激活并加载。
      const next = newOnes[newOnes.length - 1]
      setActiveId(next.id)
      setEntryChoice(next.entryPath)
      void updateTask(task.id, { entryPath: next.entryPath })
      setDocActive(false)
    } else if (!ids.has(activeId) && openSessions.length) {
      const next = openSessions[openSessions.length - 1]
      setActiveId(next.id)
      setEntryChoice(next.entryPath)
    }
  }, [activeId, openSessions])

  useEffect(() => {
    if (!docRequest) return
    setDocActive(true)
  }, [docRequest?.id])

  useEffect(() => {
    if (!runRequest || busy) return
    const path = runRequest.path
    onConsumeRunRequest()
    void startPreview(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequest?.id, busy])

  const run = async () => {
    if (busy) return
    if (!entryChoice) {
      setError('工作区里还没有 HTML 文件。让 Agent 先创建入口文件。')
      return
    }
    await startPreview(entryChoice)
  }

  const startPreview = async (path: string) => {
    if (busy) return
    setBusy(true)
    setError('')
    setDocActive(false)
    try {
      await updateTask(task.id, { entryPath: path })
      const result =
        active && active.entryPath === path
          ? await previewManager.refresh(active.id)
          : await previewManager.open(task.id, path)
      setActiveId(result.sessionId)
      setEntryChoice(path)
      if (!result.ready) {
        setError('预览没有在预期时间内就绪。打开日志查看原因，或让 Agent 检查入口文件。')
      }
      if (result.warnings.length) {
        toast(result.warnings[0], 'warning')
      }
    } catch (e) {
      const message = String((e as Error)?.message || e)
      setError(message)
      toast('试玩启动失败：' + message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const closeSession = async (id: string) => {
    try {
      await previewManager.close(id)
      if (activeId === id) setActiveId('')
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error')
    }
  }

  const createHtml = async () => {
    if (creating) return
    setCreating(true)
    setError('')
    try {
      const path = await createPreviewHtml(task.id, newName, newContent.trim() || NEW_PREVIEW_HTML)
      setNewOpen(false)
      setNewName('page.html')
      setNewContent('')
      setEntryChoice(path)
      toast(`已新建 ${path}`, 'success')
      await startPreview(path)
    } catch (e) {
      toast('新建失败：' + String((e as Error)?.message || e), 'error')
    } finally {
      setCreating(false)
    }
  }

  const importHtml = async (files: readonly File[]) => {
    if (!files.length || creating) return
    setCreating(true)
    setError('')
    try {
      const result = await importPreviewHtml(task.id, files)
      setEntryChoice(result.entryPath)
      toast(`已导入 ${result.paths.length} 个文件，入口 ${result.entryPath}`, 'success')
      await startPreview(result.entryPath)
    } catch (e) {
      toast('导入失败：' + String((e as Error)?.message || e), 'error')
    } finally {
      setCreating(false)
    }
  }

  const doExport = async () => {
    if (!active) {
      setError('没有正在展示的试玩会话，无法导出当前展示版本。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const prepared = await previewManager.prepareDisplayedExport(active.id, undefined, task.title)
      setPreparedExport({ ...prepared, taskId: task.id })
    } catch (e) {
      const message = '导出当前展示版本失败：' + String((e as Error)?.message || e)
      setError(message)
      toast(message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const sendToAgent = () => {
    if (!active) {
      onSendToAgent('请检查当前工作区并在试玩区打开入口 HTML，读取运行结果后修复问题。')
      return
    }
    const lines = [
      `请检查试玩会话 ${active.id}（入口 ${active.entryPath}，build ${active.buildVersion}）的运行结果。`,
      '先调用 preview({action:"observe"}) 获取当前构建的异常、console 和网络失败；不要使用旧构建日志。',
      errorCount ? `当前界面记录到 ${errorCount} 条错误，可用日志面板的“交给 Agent”附带详情。` : '',
    ].filter(Boolean)
    onSendToAgent(lines.join('\n'))
  }

  const hasHtml = htmlFiles.length > 0
  const modeLabel = active
    ? active.allowSameOrigin
      ? '兼容模式（虚拟源）'
      : '严格隔离（内联）'
    : ''

  return (
    <section className="preview-panel">
      <header className="panel-head">
        <div className="panel-title">
          <Icon name="preview" size={15} />
          <span>试玩</span>
          {active ? <span className="panel-sub">build {active.buildVersion}</span> : null}
        </div>
        <div className="panel-actions">
          <select
            className="select select-small"
            value={entryChoice}
            onChange={(e) => setEntryChoice(e.target.value)}
            disabled={!hasHtml}
            title="选择入口 HTML"
          >
            {hasHtml ? (
              htmlFiles.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))
            ) : (
              <option value="">暂无 HTML</option>
            )}
          </select>
          <button className="btn btn-small btn-primary" onClick={() => void run()} disabled={busy || !hasHtml}>
            {busy ? <span className="spinner" /> : <Icon name="play" size={13} />}
            {active && active.entryPath === entryChoice ? '刷新' : '运行'}
          </button>
          {errorCount > 0 ? <button className="btn btn-small" onClick={() => setLogOpen(true)}><Icon name="warning" size={13} /> {errorCount} 个错误</button> : null}
          <button className={`btn btn-small ${aiAuthorized ? 'is-on' : ''}`} onClick={() => { setAiProfileId('default'); setAiModalOpen(true) }} disabled={!active} title={trusted ? `受支持组件「${trusted.name}」自动使用设置里的模型；可在此撤销` : '允许此试玩使用共享模型'}>
            <Icon name="spark" size={13} /> {autoAi ? '组件已接入 AI' : aiAuthorized ? 'AI 已授权' : trusted ? '接入 AI' : 'AI 授权'}
          </button>
          <button className="btn btn-small" onClick={() => void doExport()} disabled={busy || !hasHtml}>
            <Icon name="download" size={13} /> 导出
          </button>
          <details className="secondary-menu panel-menu">
            <summary className="chip" aria-label="试玩工具"><Icon name="more" size={16} /></summary>
            <div className="menu-sheet">
              <button onClick={() => setNewOpen(true)}>新建 HTML</button>
              <button onClick={() => importInputRef.current?.click()}>导入 HTML 文件…</button>
              <button onClick={() => importDirRef.current?.click()}>导入文件夹…</button>
              <button onClick={() => setLogOpen((v) => !v)} disabled={!active}>运行日志</button>
              <button onClick={sendToAgent}>交给 Agent 检查</button>
              <button onClick={() => void openSaves()}>作品存档</button>
            </div>
          </details>
        </div>
      </header>

      {error ? (
        <div className="banner banner-error">
          <Icon name="warning" size={15} />
          <span>{error}</span>
          <button className="btn btn-small btn-ghost" onClick={() => setError('')}>
            关闭
          </button>
        </div>
      ) : null}

      {active?.status === 'error' && active.error ? (
        <div className="banner banner-error">
          <Icon name="warning" size={15} />
          <span>{active.error}</span>
        </div>
      ) : null}

      <div className={`preview-body ${logOpen && active ? 'with-logs' : ''}`}>
        <div className="preview-stage">
          {openSessions.map((s) => (
            <PreviewFrame key={s.id} session={s} active={!docActive && s.id === activeId} />
          ))}
          {!openSessions.length && !docActive ? (
            <div className="preview-empty">
              <div className="preview-empty-mark">
                <Icon name="preview" size={26} />
              </div>
              <h2>{hasHtml ? '把工作区跑起来' : '还没有可试玩的项目'}</h2>
              <p>
                {hasHtml
                  ? '选择一个入口 HTML，点击运行。试玩会加载工作区里的相对脚本、样式、图片和模块。'
                  : '让 Agent 创建一个 index.html。它会真实写入工作区，然后在试玩区运行并读取错误。'}
              </p>
              {hasHtml ? (
                <div className="preview-empty-actions">
                  <select className="select" value={entryChoice} onChange={(e) => setEntryChoice(e.target.value)}>
                    {htmlFiles.map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.path}
                      </option>
                    ))}
                  </select>
                  <button className="btn btn-primary" onClick={() => void run()} disabled={busy || !hasHtml}>
                    <Icon name="play" size={14} /> 运行
                  </button>
                </div>
              ) : (
                <div className="preview-empty-actions">
                  <button className="btn btn-primary" onClick={() => setNewOpen(true)} disabled={creating}>
                    <Icon name="plus" size={14} /> 新建 HTML
                  </button>
                  <button className="btn" onClick={() => importInputRef.current?.click()} disabled={creating}>
                    导入 HTML
                  </button>
                  <button className="btn" onClick={() => importDirRef.current?.click()} disabled={creating}>
                    导入文件夹
                  </button>
                </div>
              )}
            </div>
          ) : null}

          {docActive && docRequest ? (
            <div className="preview-doc">
              <DocViewer
                doc={docRequest.doc}
                onSendToAgent={onSendToAgent}
                onOpenInPreview={(path) => void startPreview(path)}
              />
            </div>
          ) : null}

          {openSessions.length || docRequest ? (
            <div className="preview-tabs">
              {docRequest ? (
                <div className={`preview-tab ${docActive ? 'is-active' : ''}`}>
                  <button className="preview-tab-select" onClick={() => setDocActive(true)} aria-pressed={docActive} title={docRequest.doc.name}>
                    <Icon name="book" size={12} /><span className="preview-tab-name">{docRequest.doc.name}</span>
                  </button>
                  <button className="preview-tab-close" aria-label={`关闭文档 ${docRequest.doc.name}`} onClick={() => { setDocActive(false); onCloseDoc() }}>
                    <Icon name="x" size={12} />
                  </button>
                </div>
              ) : null}
              {openSessions.map((s) => (
                <div key={s.id} className={`preview-tab ${!docActive && s.id === activeId ? 'is-active' : ''}`}>
                  <button className="preview-tab-select" aria-pressed={!docActive && s.id === activeId} title={s.entryPath} onClick={() => {
                    setDocActive(false)
                    setActiveId(s.id)
                    setPreviewFocus(task.id, s.id)
                    setEntryChoice(s.entryPath)
                    void updateTask(task.id, { entryPath: s.entryPath })
                  }}>
                    <span className={`status-dot ${s.status === 'ready' ? 'ok' : s.status === 'error' ? 'warn' : ''}`} />
                    <span className="preview-tab-name">{s.name}</span>
                    <span className="preview-tab-build">#{s.buildVersion.toString().slice(-4)}</span>
                  </button>
                  <button className="preview-tab-close" aria-label={`关闭试玩 ${s.entryPath}`} onClick={() => void closeSession(s.id)}>
                    <Icon name="x" size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {logOpen && active ? (
          <LogDrawer
            session={active}
            onClose={() => setLogOpen(false)}
            onSendToAgent={(text) => {
              onSendToAgent(text)
              toast('已把日志摘要填入 Agent 输入框', 'info')
            }}
          />
        ) : null}
      </div>

      <footer className="preview-foot">
        {active ? (
          <>
            <span className="capability">
              <span className={`status-dot ${active.status === 'ready' ? 'ok' : 'warn'}`} />
              {modeLabel}
            </span>
            <span className="capability">console · DOM · 交互 · 网络元数据</span>
            <span className={`capability ${aiAuthorized ? '' : 'muted'}`}>
              AI {autoAi ? '组件自动接入' : aiAuthorized ? '已授权' : trusted ? (componentPaused ? '已暂停自动接入' : '待配置模型') : '未授权'}
            </span>
            <span className="capability muted">截图不可用</span>
            <details className="preview-limits">
              <summary>限制</summary>
              <ul>
                {active.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          <span className="capability muted">试玩运行在 sandbox iframe 中，无法读取工作台密钥。</span>
        )}
      </footer>

      <Modal
        open={aiModalOpen}
        title={autoAi ? '受支持组件已自动接入 AI' : aiAuthorized ? '共享 AI 已授权' : '允许此试玩使用共享模型？'}
        subtitle={active ? `${active.name} · ${active.entryPath}` : ''}
        onClose={() => setAiModalOpen(false)}
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setAiModalOpen(false)}>
              取消
            </button>
            {aiAuthorized ? (
              <button
                className="btn btn-danger"
                onClick={() => {
                  if (active) previewManager.setAiAuthorized(active.id, false, aiProfileId)
                  setAiModalOpen(false)
                  toast(autoAi ? '已撤销自动接入；这个作品刷新后不会再自动接入，除非你手动授权' : '已撤销此试玩的 AI 授权', 'info')
                }}
              >
                撤销授权
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={!active || !aiProfiles.find((profile) => profile.profileId === aiProfileId)}
                onClick={() => {
                  if (!active) return
                  previewManager.setAiAuthorized(active.id, true, aiProfileId)
                  setAiModalOpen(false)
                  toast('已授权；页面可通过 Workbench.ai.chat 使用所选公开模型', 'success')
                }}
              >
                允许此试玩使用
              </button>
            )}
          </div>
        }
      >
        <div className="ai-auth-body">
          {trusted ? (
            <div className={`export-check ${autoAi ? '' : 'warn'}`}>
              <strong>受支持组件：{trusted.name}</strong>
              <p>
                {autoAi
                  ? '来源、版本和生成代码都与本地固定组件一致，已自动使用设置里的默认模型；API Key 仍只留在工作台，不会传给页面。'
                  : componentPaused
                    ? '你撤销过这个作品的自动接入，刷新后不会自动恢复；需要时可在这里手动授权。'
                    : '已识别为受支持组件，但工作台还没有可用的模型配置；配置后会自动接入，不需要每次手动点授权。'}
              </p>
            </div>
          ) : (
            <p className="muted">
              普通 HTML 不会自动获得工作台模型；需要 AI 时请让 Agent 在作品里实现自己的设置入口。
            </p>
          )}
          <p>
            授权后，这个试玩页可以通过 <code>window.Workbench.ai.chat({'{ messages, onChunk }'})</code>{' '}
            请求当前共享模型，AI 桥只返回回复，不返回 API Key。
            {active?.allowSameOrigin ? '当前是同源兼容模式，不具备严格沙箱的数据隔离；仅用于你信任的作品。' : ''}
          </p>
          <p>
            模型配置：
            <select className="select" value={aiProfileId} onChange={(e) => setAiProfileId(e.target.value)}>
              {aiProfiles.map((profile) => (
                <option key={profile.profileId} value={profile.profileId}>
                  {profile.profileId} · {profile.name} · {profile.model} · {profile.baseUrl}
                </option>
              ))}
            </select>
          </p>
          {aiProfiles.find((profile) => profile.profileId === aiProfileId) ? (
            <p>
              端点：<code>{aiProfiles.find((profile) => profile.profileId === aiProfileId)?.baseUrl}</code>
              <br />
              模型：<code>{aiProfiles.find((profile) => profile.profileId === aiProfileId)?.model}</code>
            </p>
          ) : <p className="banner banner-error">没有可授权的公开模型配置，请先在设置中配置默认模型或 profile。</p>}
          <div className="settings-note">
            <Icon name="warning" size={14} />
            <span>
              只应授权你信任的代码。页面发送的内容会到达模型服务；每个会话每分钟最多 10 次、每天最多 100 次请求。关闭或刷新会话会中止进行中的请求。
            </span>
          </div>
          <p className="muted">
            导出单 HTML 不会继承工作台密钥。若作品调用 <code>Workbench.ai</code>，导出文件会自带「AI 设置」面板，由使用者填写自己的端点与 Key；若只调用{' '}
            <code>Workbench.storage</code>，导出时自动换成 localStorage。
          </p>
        </div>
      </Modal>

      <Modal
        open={Boolean(exportResult)}
        title="下载前检查"
        subtitle={exportResult ? `入口 ${preparedExport?.entryPath} · ${byteSize(exportResult.size)}` : ''}
        onClose={() => setPreparedExport(null)}
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setPreparedExport(null)}>
              关闭
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                if (!exportResult || !preparedExport) return
                downloadText(exportResult.path.split('/').pop()!, preparedExport.html)
                setPreparedExport(null)
              }}
            >
              <Icon name="download" size={14} /> {exportResult?.checks.secrets.length || exportResult?.level === 'incomplete' || exportResult?.level === 'needs-workbench' ? '了解限制，仍然下载' : '下载此版本'}
            </button>
          </div>
        }
      >
        {exportResult ? (
          <div className="export-report">
            <p>文件名：{exportResult.path.split('/').pop()}。以下是静态检查结果，不代表关键交互已验证。</p>
            <div className={`export-level level-${exportResult.level}`}>
              {deliveryLevelText(exportResult.level)}
            </div>
            {exportResult.capabilities.storage || exportResult.capabilities.ai ? (
              <div className="export-check">
                <strong>已注入独立运行时</strong>
                <ul>
                  {exportResult.capabilities.storage ? <li>独立存储：localStorage，命名空间按作品身份固定，重命名文件不会丢档</li> : null}
                  {exportResult.capabilities.ai ? (
                    <li>独立 AI：作品内「AI 设置」面板，直连 OpenAI 兼容端点；需联网，不继承工作台密钥</li>
                  ) : null}
                </ul>
              </div>
            ) : null}
            {exportResult.checks.missing.length ? (
              <div className="export-check">
                <strong>缺失资源</strong>
                <ul>
                  {exportResult.checks.missing.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {exportResult.checks.external.length ? (
              <div className="export-check">
                <strong>外部依赖</strong>
                <ul>
                  {exportResult.checks.external.slice(0, 10).map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {exportResult.checks.workbenchRefs.length || exportResult.checks.blobRefs.length ? (
              <div className="export-check warn">
                <strong>仍依赖工作台能力</strong>
                <p>{[...exportResult.checks.workbenchRefs, ...exportResult.checks.blobRefs].join('、')}</p>
              </div>
            ) : null}
            {exportResult.checks.secrets.length ? (
              <div className="export-check warn">
                <strong>疑似密钥</strong>
                <p>{exportResult.checks.secrets.join('、')}</p>
              </div>
            ) : null}
            {exportResult.warnings.length ? (
              <div className="export-check">
                <strong>提示</strong>
                <ul>
                  {exportResult.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={newOpen}
        title="新建 HTML"
        subtitle={`写入「${task.title}」的工作区，并立即在试玩中运行`}
        onClose={() => setNewOpen(false)}
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setNewOpen(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void createHtml()} disabled={creating || !newName.trim()}>
              {creating ? <span className="spinner" /> : <Icon name="plus" size={14} />} 创建并运行
            </button>
          </div>
        }
      >
        <div className="new-html-body">
          <label className="field">
            <span>文件名</span>
            <input
              className="input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="page.html"
              autoFocus
            />
          </label>
          <label className="field">
            <span>初始内容（留空使用模板）</span>
            <textarea
              className="input textarea"
              rows={10}
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="也可以先创建一个空白页，再回到 Agent 对话描述要加的功能"
            />
          </label>
          <p className="muted">同名文件不会被覆盖；要修改已有作品，请在 Agent 对话里改，或导入新的 HTML。</p>
        </div>
      </Modal>

      <input
        ref={importInputRef}
        type="file"
        multiple
        className="hidden-input"
        accept=".html,.htm,.css,.js,.mjs,.json,.png,.jpg,.jpeg,.gif,.webp,.svg,.txt,.md,image/*"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : []
          e.target.value = ''
          void importHtml(files)
        }}
      />
      <input
        ref={importDirRef}
        type="file"
        multiple
        className="hidden-input"
        accept=".html,.htm,.css,.js,.mjs,.json,.png,.jpg,.jpeg,.gif,.webp,.svg,.txt,.md,image/*"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : []
          e.target.value = ''
          void importHtml(files)
        }}
      />

      <Modal
        open={savesOpen}
        title="试玩存档"
        subtitle={`${task.title} · ${saves.length} 条`}
        onClose={() => setSavesOpen(false)}
        footer={
          <div className="modal-actions">
            <input
              ref={savesInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden-input"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                void importSaves(file)
              }}
            />
            <button className="btn btn-ghost" onClick={() => setSavesOpen(false)}>
              关闭
            </button>
            <button className="btn" onClick={() => savesInputRef.current?.click()}>
              导入存档
            </button>
            <button className="btn btn-primary" onClick={exportSaves} disabled={!saves.length}>
              导出存档
            </button>
          </div>
        }
      >
        <div className="saves-body">
          <p className="muted">
            试玩存档与导出作品使用同一格式。导出 JSON 后，可在导出作品右下角的「存档」面板导入；反向亦可。
            存档包不包含 AI 配置与密钥。
          </p>
          {savesNote ? <p className="saves-note">{savesNote}</p> : null}
          {saves.length ? (
            <ul className="saves-list">
              {saves.map((row) => (
                <li key={row.key}>
                  <code>{row.key}</code>
                  <span>{JSON.stringify(row.value)?.slice(0, 90)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">这个任务还没有试玩存档。作品通过 Workbench.storage 写入后会出现。</p>
          )}
        </div>
      </Modal>
    </section>
  )
}
