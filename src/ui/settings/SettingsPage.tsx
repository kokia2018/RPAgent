import { useEffect, useRef, useState } from 'react'
import type { ApiProfile, ApiSettings, TaskApiOverride, UiSettings } from '../../db/types'
import { DEFAULT_API_SETTINGS } from '../../db/types'
import { clearAllData, requestPersistentStorage, storageInfo } from '../../db/repo'
import { configFromSettings, fetchModels, normalizeBaseUrl, testConnection } from '../../agent/llm'
import { describeChatEndpoint } from '../../lib/url'
import { byteSize, formatTime } from '../../lib/text'
import { useToast } from '../toast'
import { Icon } from '../icons'
import { Modal } from '../Modal'
import { downloadText } from '../../export/exportHtml'
import { UsagePanel } from './UsagePanel'
import {
  createBackup,
  exportProject,
  importProject,
  parseBackup,
  parseProject,
  restoreBackup,
  transferFileName,
  type BackupDTO,
  type ProjectDTO,
} from '../../export/transfer'

const PRESETS: { name: string; baseUrl: string; models: string[] }[] = [
  {
    name: 'sta1n 中转',
    baseUrl: 'https://cdn.sta1n.cn/v1',
    models: ['[AN]gemini-3.8-flash', '[特价]DeepSeek-V4.1-Flash', '[次][抗截断]gemini-3.8-flash'],
  },
  {
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4.5-flash'],
  },
  {
    name: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'kimi-latest'],
  },
  {
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
  },
  {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  },
  {
    name: '本机端点',
    baseUrl: 'http://127.0.0.1:8000/v1',
    models: ['deepseek-v4.1-flash'],
  },
]

const BACKUP_COUNT_LABELS: { key: keyof BackupDTO['data']; label: string }[] = [
  { key: 'tasks', label: '任务' },
  { key: 'messages', label: '会话消息' },
  { key: 'workspaceFiles', label: '工作区文件' },
  { key: 'libraryFiles', label: '常用资料' },
  { key: 'libraryFolders', label: '资料文件夹' },
  { key: 'attachments', label: '任务附件' },
  { key: 'taskLibraryRefs', label: '资料引用' },
  { key: 'projectSnapshots', label: '版本快照' },
  { key: 'applicationSaves', label: '作品存档' },
  { key: 'previewSessions', label: '试玩会话' },
  { key: 'executionEvents', label: '运行事件' },
]

function parseConfigText(text: string): Partial<ApiSettings> | null {
  let raw = String(text || '').trim()
  if (!raw) return null
  raw = raw.replace(/^```(?:json|text|env)?\s*/i, '').replace(/\s*```$/, '').trim()
  let baseUrl = ''
  let apiKey = ''
  let model = ''
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    if (j && typeof j === 'object') {
      const src = (j.config && typeof j.config === 'object' ? { ...j, ...(j.config as object) } : j) as Record<string, unknown>
      baseUrl = String(src.url || src.base || src.baseUrl || src.base_url || src.api_url || src.endpoint || '')
      apiKey = String(src.key || src.apiKey || src.api_key || src.token || '')
      model = String(src.model || src.modelName || src.model_name || '')
    }
  } catch {
    /* not json */
  }
  const get = (names: string[]) => {
    const re = new RegExp('(?:^|\\n)\\s*(?:' + names.join('|') + ')\\s*[:=]\\s*["\\\']?([^\\n\\r"\\\']+)', 'i')
    return raw.match(re)?.[1]?.trim() || ''
  }
  if (!baseUrl) baseUrl = get(['API_BASE_URL', 'BASE_URL', 'API_URL', 'URL', 'BASE', 'ENDPOINT'])
  if (!apiKey) apiKey = get(['API_KEY', 'APIKEY', 'KEY', 'TOKEN', 'ACCESS_TOKEN'])
  if (!model) model = get(['MODEL_NAME', 'MODEL', 'DEPLOYMENT'])
  if (!baseUrl) {
    const m = raw.match(/https?:\/\/[^\s"'<>，。；;]+/i)
    if (m) baseUrl = m[0].replace(/[),.]+$/, '')
  }
  if (!apiKey) {
    const m = raw.match(/\bsk-[A-Za-z0-9][A-Za-z0-9._:-]{2,}/)
    if (m) apiKey = m[0]
  }
  if (!baseUrl && !apiKey && !model) return null
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey: apiKey.trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, ''),
    model,
  }
}

export function SettingsPage({
  settings,
  taskOverride,
  hasTaskOverride,
  uiSettings,
  taskId,
  taskTitle,
  onSave,
  onSaveOverride,
  onClearOverride,
  onSaveUi,
  onBack,
  onImportedTask,
}: {
  settings: ApiSettings
  taskOverride: TaskApiOverride
  hasTaskOverride: boolean
  uiSettings: UiSettings
  taskId?: string
  taskTitle?: string
  onSave: (settings: ApiSettings) => Promise<void>
  onSaveOverride: (override: TaskApiOverride) => Promise<void>
  onClearOverride: () => Promise<void>
  onSaveUi: (settings: UiSettings) => void
  onBack: () => void
  onImportedTask: (taskId: string) => void
}) {
  const { toast } = useToast()
  const [draft, setDraft] = useState<ApiSettings>({ ...settings, profiles: [...settings.profiles] })
  const [overrideDraft, setOverrideDraft] = useState<TaskApiOverride>({ ...taskOverride })
  const [overrideBusy, setOverrideBusy] = useState(false)

  useEffect(() => {
    setOverrideDraft({ ...taskOverride })
  }, [taskOverride])
  const [pasteText, setPasteText] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [log, setLog] = useState('')
  const [modelList, setModelList] = useState<string[]>([])
  const [busy, setBusy] = useState<'test' | 'models' | 'save' | ''>('')
  const [storage, setStorage] = useState<{ usage: number; quota: number; persisted: boolean } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [transferBusy, setTransferBusy] = useState<'project' | 'backup' | 'import' | 'restore' | ''>('')
  const [pendingProject, setPendingProject] = useState<ProjectDTO | null>(null)
  const [pendingBackup, setPendingBackup] = useState<BackupDTO | null>(null)
  // 直接把最终会请求的地址显示出来，省得用户靠猜 /v1。
  const resolvedChat = describeChatEndpoint(draft.baseUrl)
  const projectInputRef = useRef<HTMLInputElement>(null)
  const backupInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    storageInfo().then(setStorage).catch(() => undefined)
  }, [])

  const patch = (p: Partial<ApiSettings>) => setDraft((d) => ({ ...d, ...p }))

  const applyPreset = (name: string) => {
    const preset = PRESETS.find((p) => p.name === name)
    if (!preset) return
    patch({ baseUrl: preset.baseUrl })
    setModelList(preset.models)
    if (!draft.model && preset.models[0]) patch({ model: preset.models[0] })
  }

  const applyPaste = () => {
    const parsed = parseConfigText(pasteText)
    if (!parsed) {
      toast('没有识别到 URL / Key / 模型', 'warning')
      return
    }
    patch(parsed)
    toast('已识别并填入', 'success')
  }

  const doTest = async () => {
    setBusy('test')
    setLog('正在发送最小请求…')
    try {
      const result = await testConnection(configFromSettings(draft))
      setLog(
        [
          result.ok ? `连通成功 · HTTP ${result.status} · ${result.ms}ms` : `失败 · HTTP ${result.status} · ${result.ms}ms`,
          result.error ? `错误：${result.error}` : '',
          result.sample ? `返回片段：${result.sample.slice(0, 500)}` : '',
          !result.ok && /Failed to fetch|fetch failed|NetworkError/i.test(result.error || '')
            ? '提示：这通常是 CORS 被拦截，或端点不接受浏览器请求。工作台不能绕过 CORS，请换允许跨域的端点或配置自己的代理。'
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      toast(result.ok ? '连通正常' : '连通失败，查看下方日志', result.ok ? 'success' : 'error')
    } finally {
      setBusy('')
    }
  }

  const doFetchModels = async () => {
    setBusy('models')
    setLog('正在 GET /models …')
    try {
      const ids = await fetchModels(configFromSettings(draft))
      setModelList(ids)
      setLog(`拿到 ${ids.length} 个模型：${ids.slice(0, 20).join(', ')}`)
      toast(`拉取到 ${ids.length} 个模型`, 'success')
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      setLog('拉取失败：' + msg)
      toast('拉取模型失败', 'error')
    } finally {
      setBusy('')
    }
  }

  const save = async () => {
    setBusy('save')
    try {
      const next: ApiSettings = {
        ...draft,
        baseUrl: normalizeBaseUrl(draft.baseUrl),
        apiKey: draft.apiKey.trim().replace(/^Bearer\s+/i, ''),
        model: draft.model.trim(),
      }
      setDraft(next)
      await onSave(next)
      toast('设置已保存', 'success')
    } finally {
      setBusy('')
    }
  }

  const saveOverride = async () => {
    if (!taskId) return
    setOverrideBusy(true)
    try {
      const next: TaskApiOverride = {}
      if (overrideDraft.baseUrl?.trim()) next.baseUrl = normalizeBaseUrl(overrideDraft.baseUrl)
      if (overrideDraft.model?.trim()) next.model = overrideDraft.model.trim()
      if (overrideDraft.apiKey?.trim()) next.apiKey = overrideDraft.apiKey.trim().replace(/^Bearer\s+/i, '')
      if (typeof overrideDraft.temperature === 'number') next.temperature = overrideDraft.temperature
      await onSaveOverride(next)
      toast('已保存任务覆盖', 'success')
    } finally {
      setOverrideBusy(false)
    }
  }

  const clearOverride = async () => {
    if (!taskId) return
    setOverrideBusy(true)
    try {
      await onClearOverride()
      setOverrideDraft({})
      toast('已清除任务覆盖', 'info')
    } finally {
      setOverrideBusy(false)
    }
  }

  const saveProfile = () => {
    if (!draft.baseUrl || !draft.model) {
      toast('先填 Base URL 和模型', 'warning')
      return
    }
    const name = `${draft.model} @ ${draft.baseUrl.replace(/^https?:\/\//, '').slice(0, 32)}`
    const profile: ApiProfile = {
      id: `p_${Date.now()}`,
      name,
      baseUrl: normalizeBaseUrl(draft.baseUrl),
      apiKey: draft.apiKey,
      model: draft.model,
      temperature: draft.temperature,
    }
    const profiles = [profile, ...draft.profiles.filter((p) => !(p.baseUrl === profile.baseUrl && p.model === profile.model))].slice(0, 12)
    patch({ profiles })
    toast('已存为方案，点保存后持久化', 'info')
  }

  const clearAll = async () => {
    await clearAllData()
    location.reload()
  }

  const doExportProject = async () => {
    if (!taskId) {
      toast('先打开一个任务，再导出当前项目', 'warning')
      return
    }
    setTransferBusy('project')
    try {
      const dto = await exportProject(taskId)
      downloadText(
        transferFileName(dto.title, 'project'),
        JSON.stringify(dto, null, 2),
        'application/json;charset=utf-8',
      )
      toast(`项目已导出：${dto.files.length} 个文件`, 'success')
      if (dto.warnings.length) toast(dto.warnings[0], 'warning')
    } catch (e) {
      toast('导出项目失败：' + String((e as Error)?.message || e), 'error')
    } finally {
      setTransferBusy('')
    }
  }

  const readJsonFile = async (file: File): Promise<unknown> => {
    const text = await file.text()
    if (!text.trim()) throw new Error('文件是空的')
    return JSON.parse(text)
  }

  const pickProjectFile = async (file: File | undefined) => {
    if (!file) return
    try {
      setPendingProject(parseProject(await readJsonFile(file)))
    } catch (e) {
      toast('读取项目失败：' + String((e as Error)?.message || e), 'error')
    }
  }

  const confirmImportProject = async () => {
    if (!pendingProject) return
    setTransferBusy('import')
    try {
      const result = await importProject(pendingProject)
      setPendingProject(null)
      toast(`已导入 ${result.imported} 个文件到新任务`, 'success')
      if (result.warnings.length) toast(result.warnings[0], 'warning')
      onImportedTask(result.taskId)
    } catch (e) {
      toast('导入项目失败：' + String((e as Error)?.message || e), 'error')
    } finally {
      setTransferBusy('')
    }
  }

  const doExportBackup = async () => {
    setTransferBusy('backup')
    try {
      const dto = await createBackup()
      downloadText(
        transferFileName('workbench', 'backup'),
        JSON.stringify(dto, null, 2),
        'application/json;charset=utf-8',
      )
      const total = Object.values(dto.counts).reduce((n, v) => n + v, 0)
      toast(`备份已导出：${total} 条记录${dto.incomplete ? '（不完整）' : ''}`, dto.incomplete ? 'warning' : 'success')
      if (dto.warnings.length) toast(dto.warnings[0], 'warning')
    } catch (e) {
      toast('导出备份失败：' + String((e as Error)?.message || e), 'error')
    } finally {
      setTransferBusy('')
    }
  }

  const pickBackupFile = async (file: File | undefined) => {
    if (!file) return
    try {
      setPendingBackup(parseBackup(await readJsonFile(file)))
    } catch (e) {
      toast('读取备份失败：' + String((e as Error)?.message || e), 'error')
    }
  }

  const confirmRestore = async () => {
    if (!pendingBackup) return
    setTransferBusy('restore')
    try {
      await restoreBackup(pendingBackup)
      setPendingBackup(null)
      toast('备份已恢复，正在重新加载…', 'success')
      window.setTimeout(() => location.reload(), 700)
    } catch (e) {
      toast('恢复失败：' + String((e as Error)?.message || e), 'error')
    } finally {
      setTransferBusy('')
    }
  }

  return (
    <div className="settings-page">
      <header className="settings-head">
        <div>
          <h1>设置</h1>
          <p>模型接口、运行预算与本地存储。密钥只保存在当前浏览器。</p>
        </div>
        <div className="settings-actions">
          <button className="btn btn-ghost" onClick={onBack}>
            返回工作台
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy === 'save'}>
            {busy === 'save' ? <span className="spinner" /> : <Icon name="check" size={14} />}
            保存设置
          </button>
        </div>
      </header>

      <div className="settings-grid">
        <section className="settings-card settings-main">
          <h2>模型接口</h2>
          <p className="settings-desc">OpenAI 兼容接口。Agent 的推理、工具调用和流式输出都走这份配置。</p>

          <label className="field">
            <span>服务商预设</span>
            <select className="select" defaultValue="" onChange={(e) => applyPreset(e.target.value)}>
              <option value="">选择预设（只填 Base URL 与模型）</option>
              {PRESETS.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Base URL</span>
            <input
              className="input"
              value={draft.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
              onBlur={() => patch({ baseUrl: normalizeBaseUrl(draft.baseUrl) })}
              placeholder="https://your-endpoint/v1"
              spellCheck={false}
            />
            <small>
              只填到版本段就够：填 <code>https://ai.varud.asia</code> 会自动补成 <code>/v1</code>；多余的
              <code> /chat/completions</code>、重复 <code>/v1/v1</code> 与缺的 <code>https://</code> 都会被清理。
            </small>
            <small className={resolvedChat ? 'settings-resolved' : 'settings-resolved is-empty'}>
              实际请求：<code>{resolvedChat || '先填 Base URL'}</code>
            </small>
          </label>

          <label className="field">
            <span>API Key</span>
            <div className="input-row">
              <input
                className="input"
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={(e) => patch({ apiKey: e.target.value })}
                placeholder="sk-..."
                spellCheck={false}
              />
              <button className="btn btn-ghost" onClick={() => setShowKey((v) => !v)} type="button">
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
            <small>Key 存在本机 IndexedDB，不写入导出作品、日志或项目文件。</small>
          </label>

          <label className="field">
            <span>模型</span>
            <div className="input-row">
              <input
                className="input"
                value={draft.model}
                onChange={(e) => patch({ model: e.target.value })}
                list="model-options"
                placeholder="[AN]gemini-3.8-flash"
                spellCheck={false}
              />
              <button className="btn btn-ghost" onClick={() => void doFetchModels()} disabled={busy === 'models'}>
                {busy === 'models' ? <span className="spinner" /> : null}
                拉取模型
              </button>
            </div>
            <datalist id="model-options">
              {Array.from(new Set([...modelList, ...draft.profiles.map((p) => p.model)])).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>

          <div className="field-row">
            <label className="field">
              <span>温度</span>
              <input
                className="input"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={draft.temperature}
                onChange={(e) => patch({ temperature: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>最大轮数（0 = 不限）</span>
              <input
                className="input"
                type="number"
                min={0}
                max={999}
                value={draft.maxRounds}
                onChange={(e) => patch({ maxRounds: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              />
              <small>一轮 = 一次模型请求。0 = 不设上限，和本地 Agent 一样靠你随时停止；只有填了正数才会在到达时停。</small>
            </label>
            <label className="field">
              <span>最大工具次数（0 = 不限）</span>
              <input
                className="input"
                type="number"
                min={0}
                max={9999}
                value={draft.maxToolCalls}
                onChange={(e) => patch({ maxToolCalls: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              />
              <small>整轮运行累计的工具调用上限，按调用计（一轮可能调多个工具）。0 = 不限。</small>
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>上下文窗口</span>
              <input
                className="input"
                type="number"
                min={0}
                step={1000}
                value={draft.contextWindow}
                onChange={(e) => patch({ contextWindow: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              />
              <small>模型的上下文上限（token）。压缩阈值按它算；填 0 关闭按阈值自动压缩，只靠接口报错时压缩一次。</small>
            </label>
            <label className="field">
              <span>预留输出</span>
              <input
                className="input"
                type="number"
                min={0}
                step={1024}
                value={draft.reserveTokens}
                onChange={(e) => patch({ reserveTokens: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              />
              <small>占用超过「窗口 − 预留」就压缩。默认 16384，给模型留出回答空间。</small>
            </label>
            <label className="field">
              <span>保留最近</span>
              <input
                className="input"
                type="number"
                min={0}
                step={1000}
                value={draft.keepRecentTokens}
                onChange={(e) => patch({ keepRecentTokens: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              />
              <small>压缩时原样保留的最近上下文（token）。太小小模型会忘记刚做的改动，默认 20000。</small>
            </label>
          </div>

          <div className="settings-buttons">
            <button className="btn" onClick={() => void doTest()} disabled={busy === 'test' || !draft.baseUrl}>
              {busy === 'test' ? <span className="spinner" /> : <Icon name="spark" size={14} />}
              测试连通
            </button>
            <button className="btn btn-ghost" onClick={saveProfile}>
              存为新方案
            </button>
          </div>

          {log ? <pre className="settings-log">{log}</pre> : null}

          {draft.profiles.length ? (
            <div className="profile-list">
              <div className="profile-title">本机方案</div>
              <div className="chips">
                {draft.profiles.map((p) => (
                  <span key={p.id} className="profile-chip">
                    <button
                      onClick={() => {
                        patch({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, temperature: p.temperature })
                        setModelList((list) => Array.from(new Set([p.model, ...list])))
                      }}
                    >
                      {p.name}
                    </button>
                    <button
                      className="profile-remove"
                      onClick={() => patch({ profiles: draft.profiles.filter((x) => x.id !== p.id) })}
                      aria-label="删除方案"
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section className="settings-card">
          <h2>API 用量</h2>
          <p className="settings-desc">
            每次模型请求都记一条：输入、输出、缓存命中与合计 token。按时间范围和模型筛选，数据只存在本机。
          </p>
          <UsagePanel />
        </section>

        <section className="settings-card">
          <h2>当前任务覆盖</h2>
          <p className="settings-desc">
            只对当前任务生效：Agent、角色对话与试玩 AI 都用合并后的配置。留空的字段继续使用上面的全局设置。
          </p>
          {!taskId ? (
            <div className="settings-note">
              <Icon name="warning" size={14} />
              <span>还没有选中任务。打开一个任务后再回来设置覆盖。</span>
            </div>
          ) : (
            <>
              <div className="settings-note">
                <Icon name="check" size={14} />
                <span>
                  {taskTitle ? `「${taskTitle}」` : '当前任务'}
                  {hasTaskOverride ? '已覆盖部分配置。' : '当前使用全局配置。'}
                </span>
              </div>
              <label className="field">
                <span>Base URL（留空沿用全局）</span>
                <input
                  className="input"
                  value={overrideDraft.baseUrl || ''}
                  onChange={(e) => setOverrideDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                  placeholder={settings.baseUrl || 'https://your-endpoint/v1'}
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>模型</span>
                <input
                  className="input"
                  value={overrideDraft.model || ''}
                  onChange={(e) => setOverrideDraft((d) => ({ ...d, model: e.target.value }))}
                  placeholder={settings.model || 'gpt-4o-mini'}
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>API Key</span>
                <input
                  className="input"
                  type="password"
                  value={overrideDraft.apiKey || ''}
                  onChange={(e) => setOverrideDraft((d) => ({ ...d, apiKey: e.target.value }))}
                  placeholder="留空沿用全局 Key"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span>温度（留空沿用全局）</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={typeof overrideDraft.temperature === 'number' ? overrideDraft.temperature : ''}
                  onChange={(e) =>
                    setOverrideDraft((d) => ({
                      ...d,
                      temperature: e.target.value === '' ? undefined : Number(e.target.value),
                    }))
                  }
                />
              </label>
              <div className="settings-buttons">
                <button className="btn btn-primary" onClick={() => void saveOverride()} disabled={overrideBusy}>
                  保存覆盖
                </button>
                <button className="btn btn-ghost" onClick={() => void clearOverride()} disabled={overrideBusy || !hasTaskOverride}>
                  清除覆盖
                </button>
              </div>
            </>
          )}
        </section>

        <section className="settings-card">
          <h2>粘贴识别</h2>
          <p className="settings-desc">把任意格式的配置整段贴进来，自动识别 URL、Key 和模型。</p>
          <textarea
            className="textarea"
            rows={7}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={'URL = https://cdn.sta1n.cn/v1\nKey = sk-xxxx\nModel = [AN]gemini-3.8-flash'}
          />
          <button className="btn" onClick={applyPaste} disabled={!pasteText.trim()}>
            识别并填入
          </button>
          <div className="settings-note">
            <Icon name="warning" size={14} />
            <span>
              浏览器直连第三方接口可能被 CORS 拦截。工作台不会绕过浏览器安全限制；失败时请换允许跨域的端点，或配置自己的代理端点。
            </span>
          </div>
        </section>

        <section className="settings-card">
          <h2>数据与存储</h2>
          <p className="settings-desc">
            任务、会话、工作区文件、资料库、附件、快照和试玩事件都保存在本机 IndexedDB。
            项目和备份都不会包含模型 API Key。
          </p>
          <div className="kv-list">
            <div>
              <span>已用空间</span>
              <strong>{storage ? byteSize(storage.usage) : '读取中…'}</strong>
            </div>
            <div>
              <span>浏览器配额</span>
              <strong>{storage ? byteSize(storage.quota) : '读取中…'}</strong>
            </div>
            <div>
              <span>持久化存储</span>
              <strong>{storage?.persisted ? '已授权' : '未授权'}</strong>
            </div>
          </div>

          <div className="transfer-block">
            <div className="transfer-title">项目</div>
            <p className="settings-desc">
              导出当前任务的工作区文件、入口和资料引用信息，用于在另一个浏览器继续编辑；不包含会话和密钥。
            </p>
            <div className="settings-buttons">
              <button className="btn" onClick={() => void doExportProject()} disabled={!taskId || Boolean(transferBusy)}>
                <Icon name="download" size={14} /> 导出当前项目
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => projectInputRef.current?.click()}
                disabled={Boolean(transferBusy)}
              >
                <Icon name="plus" size={14} /> 导入项目
              </button>
            </div>
            <input
              ref={projectInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden-input"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                void pickProjectFile(file)
              }}
            />
          </div>

          <div className="transfer-block">
            <div className="transfer-title">完整备份</div>
            <p className="settings-desc">
              包含任务、会话、工作区、资料库、附件、引用、快照和作品存档。恢复会清空当前数据，但保留当前模型设置与 API Key。
            </p>
            <div className="settings-buttons">
              <button
                className="btn"
                onClick={() => void doExportBackup()}
                disabled={Boolean(transferBusy)}
              >
                <Icon name="download" size={14} /> 导出完整备份
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => backupInputRef.current?.click()}
                disabled={Boolean(transferBusy)}
              >
                <Icon name="refresh" size={14} /> 恢复备份
              </button>
            </div>
            <input
              ref={backupInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden-input"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                void pickBackupFile(file)
              }}
            />
          </div>

          <div className="settings-buttons">
            <button
              className="btn"
              onClick={async () => {
                const ok = await requestPersistentStorage()
                toast(ok ? '已获得持久化存储授权' : '浏览器未授予持久化存储', ok ? 'success' : 'warning')
                setStorage(await storageInfo())
              }}
            >
              请求持久化存储
            </button>
            <button className="btn btn-danger" onClick={() => setConfirmClear(true)}>
              <Icon name="trash" size={14} /> 清空所有本机数据
            </button>
          </div>
          <div className="settings-note">
            <Icon name="warning" size={14} />
            <span>浏览器清理站点数据后无法恢复。重要项目请导出项目或完整备份。</span>
          </div>
        </section>

        <section className="settings-card">
          <h2>试玩隔离</h2>
          <p className="settings-desc">
            严格隔离是默认值：预览页没有工作台同源权限。兼容模式使用 Service Worker 虚拟源，但必须启用
            allow-same-origin，只应运行你信任的代码。
          </p>
          <label className="radio-row">
            <input
              type="radio"
              name="preview-security"
              checked={uiSettings.previewSecurity === 'strict'}
              onChange={() => onSaveUi({ ...uiSettings, previewSecurity: 'strict' })}
            />
            <span>
              <strong>严格隔离（推荐）</strong>
              <small>内联多文件 + sandbox iframe，无 allow-same-origin；相对 fetch 与页面跳转受限。</small>
            </span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="preview-security"
              checked={uiSettings.previewSecurity === 'compat'}
              onChange={() => onSaveUi({ ...uiSettings, previewSecurity: 'compat' })}
            />
            <span>
              <strong>兼容模式</strong>
              <small>
                支持多文件、module、相对 fetch 与页面跳转；预览页与工作台同源，能访问同源存储，只应运行可信代码。
              </small>
            </span>
          </label>
          {uiSettings.previewSecurity === 'compat' ? (
            <div className="settings-note">
              <Icon name="warning" size={14} />
              <span>兼容模式会降低运行隔离。不要用它打开来源不明的 HTML。</span>
            </div>
          ) : null}
        </section>

        <section className="settings-card">
          <h2>能力边界</h2>
          <ul className="limit-list">
            <li>不能执行 shell、Node.js、Python、原生二进制。</li>
            <li>不能访问用户磁盘或绕过 CORS。</li>
            <li>试玩运行在 sandbox iframe，页面内 localStorage 不可用，存档走 Workbench.storage 桥。</li>
            <li>普通 iframe 无法可靠截图；模拟点击 isTrusted=false。</li>
            <li>已支持常用资料、任务附件与文档阅读；PDF/Word 正文提取与角色卡运行时不在当前阶段。</li>
          </ul>
        </section>
      </div>

      <Modal
        open={Boolean(pendingProject)}
        title="导入项目"
        subtitle={pendingProject ? `${pendingProject.title} · ${pendingProject.files.length} 个文件` : ''}
        onClose={() => setPendingProject(null)}
        wide
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setPendingProject(null)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void confirmImportProject()} disabled={transferBusy === 'import'}>
              {transferBusy === 'import' ? <span className="spinner" /> : <Icon name="plus" size={14} />}
              导入为新任务
            </button>
          </div>
        }
      >
        {pendingProject ? (
          <div className="transfer-summary">
            <p>
              入口：<code>{pendingProject.entryPath}</code> · 导出时间：
              {pendingProject.exportedAt ? formatTime(pendingProject.exportedAt) : '未知'}
            </p>
            <p>会创建一个新任务并写入 {pendingProject.files.length} 个文件，不会覆盖当前任务。</p>
            {pendingProject.libraryRefs.length ? (
              <div className="settings-note">
                <Icon name="warning" size={14} />
                <span>
                  项目包含 {pendingProject.libraryRefs.length} 项常用资料引用信息；资料内容不会随项目导入，导入后需重新引用。
                </span>
              </div>
            ) : null}
            {pendingProject.warnings.length ? (
              <div className="transfer-warnings">
                {pendingProject.warnings.slice(0, 8).map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(pendingBackup)}
        title="恢复备份"
        subtitle={pendingBackup ? `导出于 ${formatTime(pendingBackup.exportedAt)}` : ''}
        onClose={() => setPendingBackup(null)}
        wide
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setPendingBackup(null)}>
              取消
            </button>
            <button className="btn btn-danger" onClick={() => void confirmRestore()} disabled={transferBusy === 'restore'}>
              {transferBusy === 'restore' ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
              清空并恢复
            </button>
          </div>
        }
      >
        {pendingBackup ? (
          <div className="transfer-summary">
            <p className="delete-warning">
              恢复会清空当前所有任务、工作区、资料库、附件、引用、快照和作品存档，然后写入备份内容。当前模型设置与 API Key
              会保留。
            </p>
            {pendingBackup.incomplete ? (
              <div className="settings-note">
                <Icon name="warning" size={14} />
                <span>这是一个不完整备份：部分二进制文件未包含，恢复后可能缺少图片或素材内容。</span>
              </div>
            ) : null}
            <div className="transfer-counts">
              {BACKUP_COUNT_LABELS.map(({ key, label }) => (
                <div key={key}>
                  <span>{label}</span>
                  <strong>{pendingBackup.counts[key] ?? 0}</strong>
                </div>
              ))}
            </div>
            {pendingBackup.warnings.length ? (
              <div className="transfer-warnings">
                {pendingBackup.warnings.slice(0, 8).map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={confirmClear}
        title="清空所有本机数据？"
        subtitle="任务、文件、会话、快照、设置和密钥都会被删除，且无法恢复。"
        onClose={() => setConfirmClear(false)}
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmClear(false)}>
              取消
            </button>
            <button className="btn btn-danger" onClick={() => void clearAll()}>
              确认清空
            </button>
          </div>
        }
      >
        <p>如果只是想换模型，不需要清空数据。建议先导出重要项目。</p>
      </Modal>
    </div>
  )
}
