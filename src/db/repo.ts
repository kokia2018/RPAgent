import { deletePreviewSessionCache } from '../preview/cache'
import Dexie from 'dexie'
import { db } from './db'
import { hashBlob, hashString, randomId } from '../lib/hash'
import { mimeFromPath, isTextPath } from '../lib/mime'
import { normalizePath } from '../lib/path'
import { ifAgentRunInactive } from '../lib/runLock'
import { tabSync } from '../lib/tabSync'
import type {
  ApplicationSave,
  ExecutionEventRecord,
  MessageRecord,
  PreviewSessionRecord,
  ProjectSnapshotRecord,
  SnapshotFile,
  Task,
  TodoItem,
  WorkspaceFile,
} from './types'

/* ───────────────────────────── 任务 ───────────────────────────── */

export async function createTask(title = '未命名任务'): Promise<Task> {
  const now = Date.now()
  const task: Task = {
    id: randomId('task_'),
    title: title.trim() || '未命名任务',
    status: 'idle',
    entryPath: '/index.html',
    todos: [],
    createdAt: now,
    updatedAt: now,
  }
  await db.tasks.add(task)
  await db.settings.put({ key: 'lastTaskId', value: task.id, updatedAt: now })
  return task
}

export async function listTasks(): Promise<Task[]> {
  return db.tasks.orderBy('updatedAt').reverse().toArray()
}

export async function getTask(id: string): Promise<Task | undefined> {
  return db.tasks.get(id)
}

export async function updateTask(id: string, patch: Partial<Task>): Promise<void> {
  await db.tasks.update(id, { ...patch, updatedAt: Date.now() })
}

export async function setTaskTodos(taskId: string, todos: TodoItem[]): Promise<void> {
  await updateTask(taskId, { todos })
}

export async function deleteTask(taskId: string): Promise<void> {
  const sessions = await db.previewSessions.where('taskId').equals(taskId).toArray()
  await Promise.all(sessions.map((session) => deletePreviewSessionCache(session.id)))
  await db.transaction(
    'rw',
    [
      db.tasks,
      db.messages,
      db.workspaceFiles,
      db.previewSessions,
      db.executionEvents,
      db.projectSnapshots,
      db.applicationSaves,
      db.attachments,
      db.taskLibraryRefs,
      db.settings,
      db.conversations,
    ],
    async () => {
      const boundIds = new Set((await db.conversations.where('workspaceId').equals(taskId).toArray()).map(c => c.id))
      await db.messages.filter(m => m.conversationId ? boundIds.has(m.conversationId) : m.taskId === taskId).delete()
      await db.conversations.where('workspaceId').equals(taskId).delete()
      await db.workspaceFiles.where('taskId').equals(taskId).delete()
      await db.previewSessions.where('taskId').equals(taskId).delete()
      await db.executionEvents.where('taskId').equals(taskId).delete()
      await db.projectSnapshots.where('taskId').equals(taskId).delete()
      await db.applicationSaves.where('taskId').equals(taskId).delete()
      await db.attachments.where('taskId').equals(taskId).delete()
      await db.taskLibraryRefs.where('taskId').equals(taskId).delete()
      await db.settings.delete(`api:task:${taskId}`)
      await db.tasks.delete(taskId)
    },
  )
}

export async function markInterruptedTasks(): Promise<void> {
  const running = await db.tasks.where('status').equals('running').toArray()
  for (const t of running) {
    await ifAgentRunInactive(t.id, async () => {
      await db.transaction('rw', db.tasks, async () => {
        const latest = await db.tasks.get(t.id)
        if (latest?.status === 'running' && latest.lastRunId === t.lastRunId) await updateTask(t.id, { status: 'interrupted' })
      })
    })
  }
}

/* ───────────────────────────── 消息 ───────────────────────────── */

export async function nextSeq(taskId: string): Promise<number> {
  const last = await db.messages
    .where('[taskId+seq]')
    .between([taskId, Dexie.minKey], [taskId, Dexie.maxKey])
    .last()
  return (last?.seq ?? 0) + 1
}

export async function appendMessage(
  input: Omit<MessageRecord, 'id' | 'seq' | 'createdAt'> & { seq?: number; createdAt?: number },
): Promise<MessageRecord> {
  return db.transaction('rw', db.messages, db.tasks, async () => {
    const seq = input.seq ?? (await nextSeq(input.taskId))
    const row: MessageRecord = { ...input, seq, createdAt: input.createdAt ?? Date.now() }
    row.id = await db.messages.add(row)
    await updateTask(input.taskId, {})
    return row
  })
}

export async function updateMessage(id: number, patch: Partial<MessageRecord>): Promise<void> {
  await db.messages.update(id, patch)
}

export async function listMessages(taskId: string, limit = 1000): Promise<MessageRecord[]> {
  const rows = await db.messages.where('taskId').equals(taskId).toArray()
  rows.sort((a, b) => a.seq - b.seq)
  return rows.slice(Math.max(0, rows.length - limit))
}

export async function listRecentMessages(taskId: string, limit: number): Promise<MessageRecord[]> {
  return listMessages(taskId, limit)
}

/* ───────────────────────────── 工作区 ───────────────────────────── */

export async function listWorkspaceFiles(taskId: string): Promise<WorkspaceFile[]> {
  const rows = await db.workspaceFiles.where('taskId').equals(taskId).toArray()
  rows.sort((a, b) => a.path.localeCompare(b.path))
  return rows
}

export async function getWorkspaceFile(taskId: string, path: string): Promise<WorkspaceFile | undefined> {
  return db.workspaceFiles.get([taskId, normalizePath(path)])
}

export async function workspaceFileExists(taskId: string, path: string): Promise<boolean> {
  return (await db.workspaceFiles.where('[taskId+path]').equals([taskId, normalizePath(path)]).count()) > 0
}

export async function writeWorkspaceText(
  taskId: string,
  path: string,
  content: string,
  source: WorkspaceFile['source'] = 'agent',
): Promise<{ file: WorkspaceFile; created: boolean }> {
  const p = normalizePath(path)
  const old = await getWorkspaceFile(taskId, p)
  const now = Date.now()
  const size = new TextEncoder().encode(content).length
  const file: WorkspaceFile = {
    taskId,
    path: p,
    mime: mimeFromPath(p),
    size,
    text: content,
    hash: hashString(content),
    source,
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
  }
  await db.workspaceFiles.put(file)
  await updateTask(taskId, {})
  // 其他标签页可能正在看同一任务；只做提示，不做自动合并。
  tabSync.notifyFilesChanged(p)
  return { file, created: !old }
}

export async function writeWorkspaceBinary(
  taskId: string,
  path: string,
  blob: Blob,
  source: WorkspaceFile['source'] = 'agent',
  knownHash?: string,
): Promise<{ file: WorkspaceFile; created: boolean }> {
  const p = normalizePath(path)
  const old = await getWorkspaceFile(taskId, p)
  const now = Date.now()
  const file: WorkspaceFile = {
    taskId,
    path: p,
    mime: blob.type || mimeFromPath(p),
    size: blob.size,
    blob,
    hash: knownHash || (await hashBlob(blob)),
    source,
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
  }
  await db.workspaceFiles.put(file)
  await updateTask(taskId, {})
  tabSync.notifyFilesChanged(p)
  return { file, created: !old }
}

export async function deleteWorkspaceEntry(taskId: string, path: string): Promise<number> {
  const p = normalizePath(path)
  const all = await listWorkspaceFiles(taskId)
  const targets = all.filter((f) => f.path === p || f.path.startsWith(p === '/' ? '/' : p + '/'))
  if (!targets.length) return 0
  await db.workspaceFiles.bulkDelete(targets.map((f) => [taskId, f.path] as [string, string]))
  await updateTask(taskId, {})
  tabSync.notifyFilesChanged(p)
  return targets.length
}

export async function listEntryHtmlFiles(taskId: string): Promise<WorkspaceFile[]> {
  const rows = await listWorkspaceFiles(taskId)
  return rows.filter((f) => /\.html?$/i.test(f.path))
}

export async function readWorkspaceText(taskId: string, path: string): Promise<string> {
  const f = await getWorkspaceFile(taskId, path)
  if (!f) throw new Error(`文件不存在：${path}`)
  if (typeof f.text === 'string') return f.text
  if (f.blob) return f.blob.text()
  return ''
}

export async function taskFileStats(taskId: string): Promise<{ count: number; bytes: number; html: number }> {
  const files = await listWorkspaceFiles(taskId)
  return {
    count: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
    html: files.filter((f) => /\.html?$/i.test(f.path)).length,
  }
}

/* ───────────────────────────── 试玩会话 ───────────────────────────── */

export async function createPreviewSession(session: PreviewSessionRecord): Promise<void> {
  await db.previewSessions.put(session)
  await updateTask(session.taskId, {})
}

export async function updatePreviewSession(id: string, patch: Partial<PreviewSessionRecord>): Promise<void> {
  await db.previewSessions.update(id, { ...patch, updatedAt: Date.now() })
}

/** 关闭或被新构建替换的会话，不接受旧异步请求的完成状态。 */
export async function updateOpenPreviewBuild(id: string, version: number, patch: Partial<PreviewSessionRecord>): Promise<boolean> {
  return db.transaction('rw', db.previewSessions, async () => {
    const record = await db.previewSessions.get(id)
    if (!record || record.status === 'closed' || record.buildVersion !== version) return false
    await updatePreviewSession(id, patch)
    return true
  })
}

export async function listPreviewSessions(taskId: string): Promise<PreviewSessionRecord[]> {
  const rows = await db.previewSessions.where('taskId').equals(taskId).toArray()
  rows.sort((a, b) => a.createdAt - b.createdAt)
  return rows
}

export async function getPreviewSession(id: string): Promise<PreviewSessionRecord | undefined> {
  return db.previewSessions.get(id)
}

export async function getLatestPreviewSession(taskId: string): Promise<PreviewSessionRecord | undefined> {
  const rows = (await listPreviewSessions(taskId)).filter((s) => s.status !== 'closed')
  return rows[rows.length - 1]
}

export async function closePreviewSession(id: string): Promise<void> {
  await updatePreviewSession(id, { status: 'closed' })
}

export async function deletePreviewSession(id: string): Promise<void> {
  await db.previewSessions.delete(id)
}

/* ───────────────────────────── 执行事件 ───────────────────────────── */

export async function appendExecutionEvent(
  event: Omit<ExecutionEventRecord, 'id' | 'createdAt'> & { createdAt?: number },
): Promise<void> {
  await db.executionEvents.add({
    ...event,
    createdAt: event.createdAt ?? Date.now(),
  } as ExecutionEventRecord)
}

export async function listExecutionEvents(
  taskId: string,
  opts: { sessionId?: string; limit?: number } = {},
): Promise<ExecutionEventRecord[]> {
  const limit = opts.limit ?? 300
  let rows: ExecutionEventRecord[]
  if (opts.sessionId) {
    rows = await db.executionEvents
      .where('sessionId')
      .equals(opts.sessionId)
      .and((e) => e.taskId === taskId)
      .toArray()
  } else {
    rows = await db.executionEvents.where('taskId').equals(taskId).toArray()
  }
  rows.sort((a, b) => (a.id || 0) - (b.id || 0))
  return rows.slice(Math.max(0, rows.length - limit))
}

/* ───────────────────────────── 快照 ───────────────────────────── */

const SNAPSHOT_TOTAL_TEXT_BUDGET = 4 * 1024 * 1024
const SNAPSHOT_PER_FILE_BUDGET = 1024 * 1024

export async function createSnapshot(taskId: string, label: string): Promise<ProjectSnapshotRecord> {
  const files = await listWorkspaceFiles(taskId)
  let budget = SNAPSHOT_TOTAL_TEXT_BUDGET
  let truncated = false
  const items: SnapshotFile[] = files.map((f) => {
    const text = typeof f.text === 'string' ? f.text : undefined
    const canStore = text != null && text.length <= SNAPSHOT_PER_FILE_BUDGET && text.length <= budget
    if (text != null && !canStore) truncated = true
    if (canStore) budget -= text.length
    return {
      path: f.path,
      mime: f.mime,
      size: f.size,
      hash: f.hash,
      text: canStore ? text : undefined,
      binary: text == null,
    }
  })
  const snap: ProjectSnapshotRecord = {
    id: randomId('snap_'),
    taskId,
    label: label || '快照',
    files: items,
    truncated,
    createdAt: Date.now(),
  }
  await db.projectSnapshots.add(snap)
  return snap
}

export async function listSnapshots(taskId: string): Promise<ProjectSnapshotRecord[]> {
  const rows = await db.projectSnapshots.where('taskId').equals(taskId).toArray()
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

export async function getSnapshot(id: string): Promise<ProjectSnapshotRecord | undefined> {
  return db.projectSnapshots.get(id)
}

export async function restoreSnapshot(snapshotId: string): Promise<{
  restored: number
  skippedBinary: string[]
  missingText: string[]
}> {
  const snap = await db.projectSnapshots.get(snapshotId)
  if (!snap) throw new Error('快照不存在')
  const skippedBinary: string[] = []
  const missingText: string[] = []
  let restored = 0
  for (const f of snap.files) {
    if (f.binary) {
      skippedBinary.push(f.path)
      continue
    }
    if (typeof f.text !== 'string' || (!f.text && f.size > 0)) {
      missingText.push(f.path)
      continue
    }
    await writeWorkspaceText(snap.taskId, f.path, f.text, 'agent')
    restored++
  }
  return { restored, skippedBinary, missingText }
}

export interface SnapshotDiff {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: number
}

export async function diffSnapshot(snapshotId: string): Promise<SnapshotDiff> {
  const snap = await db.projectSnapshots.get(snapshotId)
  if (!snap) throw new Error('快照不存在')
  const current = await listWorkspaceFiles(snap.taskId)
  const cur = new Map(current.map((f) => [f.path, f.hash]))
  const old = new Map(snap.files.map((f) => [f.path, f.hash]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  let unchanged = 0
  for (const [path, hash] of cur) {
    if (!old.has(path)) added.push(path)
    else if (old.get(path) !== hash) changed.push(path)
    else unchanged++
  }
  for (const path of old.keys()) if (!cur.has(path)) removed.push(path)
  return { added, removed, changed, unchanged }
}

/* ───────────────────────────── 作品存档桥 ───────────────────────────── */

function appSaveId(taskId: string, namespace: string, key: string): string {
  return `${taskId}::${encodeURIComponent(namespace)}::${encodeURIComponent(key)}`
}

export async function getAppSave(taskId: string, namespace: string, key: string): Promise<unknown> {
  const row = await db.applicationSaves.get(appSaveId(taskId, namespace, key))
  return row?.value
}

export async function setAppSave(taskId: string, namespace: string, key: string, value: unknown): Promise<void> {
  await db.applicationSaves.put({
    id: appSaveId(taskId, namespace, key),
    taskId,
    namespace,
    key,
    value,
    updatedAt: Date.now(),
  })
}

export async function removeAppSave(taskId: string, namespace: string, key: string): Promise<void> {
  await db.applicationSaves.delete(appSaveId(taskId, namespace, key))
}

export interface AppSaveEntry {
  key: string
  value: unknown
  updatedAt: number
}

/** 列出某任务某命名空间的全部存档（用于存档迁移）。 */
export async function listAppSaves(taskId: string, namespace: string): Promise<AppSaveEntry[]> {
  const rows = await db.applicationSaves.where('[taskId+namespace]').equals([taskId, namespace]).toArray()
  return rows
    .map((row) => ({ key: row.key, value: row.value, updatedAt: row.updatedAt }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** 批量写入存档；replace=true 时先删除包中不存在的键。 */
export async function mergeAppSaves(
  taskId: string,
  namespace: string,
  entries: Record<string, unknown>,
  options: { replace?: boolean } = {},
): Promise<{ written: number; removed: number }> {
  const keys = Object.keys(entries)
  let removed = 0
  await db.transaction('rw', db.applicationSaves, async () => {
    if (options.replace) {
      const existing = await db.applicationSaves.where('[taskId+namespace]').equals([taskId, namespace]).toArray()
      const keep = new Set(keys)
      const drops = existing.filter((row) => !keep.has(row.key))
      removed = drops.length
      if (drops.length) await db.applicationSaves.bulkDelete(drops.map((row) => row.id))
    }
    const now = Date.now()
    await db.applicationSaves.bulkPut(
      keys.map((key) => ({
        id: appSaveId(taskId, namespace, key),
        taskId,
        namespace,
        key,
        value: entries[key],
        updatedAt: now,
      })),
    )
  })
  return { written: keys.length, removed }
}

/* ───────────────────────────── 存储信息 ───────────────────────────── */

export async function storageInfo(): Promise<{ usage: number; quota: number; persisted: boolean }> {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {}
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false
  return { usage: est.usage || 0, quota: est.quota || 0, persisted }
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  return navigator.storage.persist()
}

export async function clearAllData(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.tasks,
      db.messages,
      db.workspaceFiles,
      db.previewSessions,
      db.executionEvents,
      db.projectSnapshots,
      db.applicationSaves,
      db.settings,
      db.libraryFolders,
      db.libraryFiles,
      db.taskLibraryRefs,
      db.attachments,
    ],
    async () => {
      await Promise.all([
        db.tasks.clear(),
        db.messages.clear(),
        db.workspaceFiles.clear(),
        db.previewSessions.clear(),
        db.executionEvents.clear(),
        db.projectSnapshots.clear(),
        db.applicationSaves.clear(),
        db.settings.clear(),
        db.libraryFolders.clear(),
        db.libraryFiles.clear(),
        db.taskLibraryRefs.clear(),
        db.attachments.clear(),
      ])
    },
  )
}

/** 供 UI 判断：文本文件优先读 text，否则读 Blob。 */
export async function readFileContent(file: WorkspaceFile): Promise<string> {
  if (typeof file.text === 'string') return file.text
  if (file.blob) return file.blob.text()
  return ''
}

export function isTextFileRecord(file: WorkspaceFile): boolean {
  return typeof file.text === 'string' || isTextPath(file.path)
}
