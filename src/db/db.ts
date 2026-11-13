import Dexie, { type EntityTable, type Table } from 'dexie'
import type {
  ApiSettings,
  ApplicationSave,
  Attachment,
  Conversation,
  ExecutionEventRecord,
  LibraryFile,
  LibraryFolder,
  MessageRecord,
  PreviewSessionRecord,
  ProjectSnapshotRecord,
  SettingRecord,
  Task,
  TaskApiOverride,
  TaskLibraryRef,
  UiSettings,
  UsageEventRecord,
  WorkspaceFile,
} from './types'
import { DEFAULT_API_SETTINGS, DEFAULT_UI_SETTINGS } from './types'
import { normalizeBaseUrl } from '../lib/url'

export class WorkbenchDB extends Dexie {
  settings!: EntityTable<SettingRecord, 'key'>
  tasks!: EntityTable<Task, 'id'>
  conversations!: EntityTable<Conversation, 'id'>
  messages!: Table<MessageRecord, number>
  workspaceFiles!: Table<WorkspaceFile, [string, string]>
  usageEvents!: Table<UsageEventRecord, number>
  previewSessions!: EntityTable<PreviewSessionRecord, 'id'>
  executionEvents!: Table<ExecutionEventRecord, number>
  projectSnapshots!: EntityTable<ProjectSnapshotRecord, 'id'>
  applicationSaves!: EntityTable<ApplicationSave, 'id'>
  libraryFolders!: EntityTable<LibraryFolder, 'id'>
  libraryFiles!: EntityTable<LibraryFile, 'id'>
  taskLibraryRefs!: EntityTable<TaskLibraryRef, 'id'>
  attachments!: EntityTable<Attachment, 'id'>

  constructor() {
    super('rpagent-workbench')
    this.version(1).stores({
      settings: 'key',
      tasks: 'id, updatedAt, status',
      messages: '++id, [taskId+seq], taskId, runId',
      workspaceFiles: '[taskId+path], taskId, updatedAt',
      previewSessions: 'id, taskId, updatedAt',
      executionEvents: '++id, taskId, sessionId, createdAt',
      projectSnapshots: 'id, taskId, createdAt',
      applicationSaves: 'id, [taskId+namespace], taskId',
    })
    this.version(2).stores({
      // 阶段 2：常用资料与任务附件。新增表不触碰已有数据。
      libraryFolders: 'id, parentId, updatedAt',
      libraryFiles: 'id, folderId, updatedAt, name',
      taskLibraryRefs: 'id, taskId, targetType, targetId',
      attachments: 'id, taskId, createdAt',
    })
    this.version(3).stores({
      conversations: 'id, workspaceId, updatedAt',
      messages: '++id, [taskId+seq], taskId, runId, conversationId',
    }).upgrade(async (tx) => {
      const tasks = await tx.table('tasks').toArray() as Task[]
      for (const task of tasks) {
        const id = `conversation:${task.id}`
        await tx.table('conversations').put({ id, title: task.title, workspaceId: task.id, createdAt: task.createdAt, updatedAt: task.updatedAt })
        await tx.table('messages').where('taskId').equals(task.id).modify({ conversationId: id })
      }
    })
    this.version(4).stores({
      // API 用量：一次请求一条，供设置页按模型/时间统计。
      usageEvents: '++id, at, model, host, source, taskId, conversationId, [model+at]',
    })
  }
}

export const db = new WorkbenchDB()

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key)
  if (!row) return fallback
  return row.value as T
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await db.settings.put({ key, value, updatedAt: Date.now() })
}

export async function getApiSettings(): Promise<ApiSettings> {
  const saved = await getSetting<Partial<ApiSettings>>('api', {})
  const merged = { ...DEFAULT_API_SETTINGS, ...saved, profiles: saved.profiles || [] }
  // 读出来就补齐协议与 /v1，避免旧存档里 `https://host` 拼出 /chat/completions。
  return {
    ...merged,
    baseUrl: normalizeBaseUrl(merged.baseUrl),
    maxRounds: normalizeBudget(merged.maxRounds, 'maxRounds'),
    maxToolCalls: normalizeBudget(merged.maxToolCalls, 'maxToolCalls'),
    contextWindow: normalizeWindow(merged.contextWindow, DEFAULT_API_SETTINGS.contextWindow),
    reserveTokens: normalizeWindow(merged.reserveTokens, DEFAULT_API_SETTINGS.reserveTokens),
    keepRecentTokens: normalizeWindow(merged.keepRecentTokens, DEFAULT_API_SETTINGS.keepRecentTokens),
    profiles: merged.profiles.map((profile) => ({ ...profile, baseUrl: normalizeBaseUrl(profile.baseUrl) })),
  }
}

/**
 * 旧版本的默认值曾被当作"用户选择"写进存档；数值等于旧默认时按没调过处理。
 * 现在 0 = 不限（对齐本地 Agent），旧的 24/60、80/150 都归到 0。
 */
const LEGACY_DEFAULT_BUDGET: Record<'maxRounds' | 'maxToolCalls', number[]> = {
  maxRounds: [24, 60],
  maxToolCalls: [80, 150],
}

function normalizeBudget(value: unknown, key: 'maxRounds' | 'maxToolCalls'): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_API_SETTINGS[key]
  const rounded = Math.round(n)
  if (rounded === 0) return 0
  return LEGACY_DEFAULT_BUDGET[key].includes(rounded) ? 0 : rounded
}

function normalizeWindow(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}

export async function saveApiSettings(settings: ApiSettings): Promise<void> {
  await setSetting('api', settings)
}

export async function getUiSettings(): Promise<UiSettings> {
  const saved = await getSetting<Partial<UiSettings>>('ui', {})
  return { ...DEFAULT_UI_SETTINGS, ...saved }
}

export async function saveUiSettings(settings: UiSettings): Promise<void> {
  await setSetting('ui', settings)
}

/* ── 任务级模型覆盖（plan 9.1「可为项目设置覆盖配置」） ── */

const taskApiKey = (taskId: string) => `api:task:${taskId}`

export async function getTaskApiOverride(taskId: string): Promise<TaskApiOverride> {
  if (!taskId) return {}
  const saved = await getSetting<Record<string, unknown>>(taskApiKey(taskId), {})
  const out: TaskApiOverride = {}
  if (typeof saved.baseUrl === 'string' && saved.baseUrl.trim()) out.baseUrl = normalizeBaseUrl(saved.baseUrl)
  if (typeof saved.apiKey === 'string' && saved.apiKey.trim()) out.apiKey = saved.apiKey.trim()
  if (typeof saved.model === 'string' && saved.model.trim()) out.model = saved.model.trim()
  if (typeof saved.temperature === 'number') out.temperature = saved.temperature
  return out
}

export async function saveTaskApiOverride(taskId: string, override: TaskApiOverride): Promise<void> {
  if (!taskId) return
  const clean: TaskApiOverride = {}
  if (override.baseUrl?.trim()) clean.baseUrl = override.baseUrl.trim()
  if (override.apiKey?.trim()) clean.apiKey = override.apiKey.trim()
  if (override.model?.trim()) clean.model = override.model.trim()
  if (typeof override.temperature === 'number') clean.temperature = override.temperature
  await setSetting(taskApiKey(taskId), clean)
}

export async function clearTaskApiOverride(taskId: string): Promise<void> {
  if (!taskId) return
  await db.settings.delete(taskApiKey(taskId))
}

/** 全局设置 + 任务覆盖；override 为空时等价于全局设置。 */
export function mergeApiSettings(base: ApiSettings, override: TaskApiOverride): ApiSettings {
  return {
    ...base,
    ...(override.baseUrl ? { baseUrl: override.baseUrl } : {}),
    ...(override.apiKey ? { apiKey: override.apiKey } : {}),
    ...(override.model ? { model: override.model } : {}),
    ...(typeof override.temperature === 'number' ? { temperature: override.temperature } : {}),
  }
}
