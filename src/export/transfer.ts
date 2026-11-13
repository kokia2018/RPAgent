/** 阶段 3：项目导入导出与完整备份恢复。 */

import { db } from '../db/db'
import { ensureConversations } from '../db/conversations'
import {
  createTask,
  getTask,
  listWorkspaceFiles,
  updateTask,
  writeWorkspaceBinary,
  writeWorkspaceText,
} from '../db/repo'
import { listTaskLibraryRefs } from '../db/assets'
import { normalizePath, sanitizeFileName } from '../lib/path'
import type {
  ApplicationSave,
  Attachment,
  Conversation,
  ExecutionEventRecord,
  LibraryFile,
  LibraryFolder,
  MessageRecord,
  PreviewSessionRecord,
  ProjectSnapshotRecord,
  Task,
  TaskLibraryRef,
  TodoItem,
  WorkspaceFile,
} from '../db/types'

const PROJECT_FORMAT = 'rpagent-project'
const BACKUP_FORMAT = 'rpagent-backup'
const TRANSFER_VERSION = 1

const MAX_BINARY_FILE = 10 * 1024 * 1024
const MAX_BINARY_TOTAL = 40 * 1024 * 1024
const MAX_PROJECT_FILES = 2000

/* ───────────────────────────── 通用 ───────────────────────────── */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const mime = blob.type || 'application/octet-stream'
  if (typeof FileReader !== 'undefined') {
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error || new Error('读取二进制失败'))
        reader.readAsDataURL(blob)
      })
      if (url.startsWith('data:')) return url
    } catch {
      /* 继续尝试 arrayBuffer */
    }
  }
  if (typeof blob.arrayBuffer === 'function') {
    return `data:${mime};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`
  }
  throw new Error('当前环境无法读取二进制文件')
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''))
  if (!match) throw new Error('二进制数据格式不正确')
  const mime = match[1] || 'application/octet-stream'
  if (match[2]) {
    const bytes = base64ToBytes(match[3])
    const buffer = new ArrayBuffer(bytes.length)
    new Uint8Array(buffer).set(bytes)
    return new Blob([buffer], { type: mime })
  }
  return new Blob([decodeURIComponent(match[3])], { type: mime })
}

function secretLike(text: string): boolean {
  return /\bsk-[A-Za-z0-9._:-]{12,}\b|\bBearer\s+[A-Za-z0-9._:-]{16,}\b/.test(text)
}

export function transferFileName(title: string, suffix: string): string {
  const base = sanitizeFileName(title || 'workbench', 'workbench').replace(/\.json$/i, '')
  const stamp = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${base}-${suffix}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.json`
}

/* ───────────────────────────── 项目导出 / 导入 ───────────────────────────── */

export interface ProjectFileDTO {
  path: string
  mime: string
  size: number
  text?: string
  dataUrl?: string
  hash: string
  source: WorkspaceFile['source']
}

export interface ProjectRefDTO {
  targetType: 'folder' | 'file'
  name: string
  folderPath: string
  files: { name: string; mime: string; size: number; hash: string }[]
}

export interface ProjectDTO {
  format: typeof PROJECT_FORMAT
  version: 1
  exportedAt: number
  title: string
  entryPath: string
  todos: TodoItem[]
  files: ProjectFileDTO[]
  libraryRefs: ProjectRefDTO[]
  warnings: string[]
}

export async function exportProject(taskId: string): Promise<ProjectDTO> {
  const task = await getTask(taskId)
  if (!task) throw new Error('任务不存在')
  const [files, refs] = await Promise.all([listWorkspaceFiles(taskId), listTaskLibraryRefs(taskId)])
  const warnings: string[] = []
  const out: ProjectFileDTO[] = []
  let binaryBudget = MAX_BINARY_TOTAL

  for (const file of files) {
    if (typeof file.text === 'string') {
      out.push({
        path: file.path,
        mime: file.mime,
        size: file.size,
        text: file.text,
        hash: file.hash,
        source: file.source,
      })
      continue
    }
    if (!file.blob) {
      warnings.push(`${file.path}：没有可导出的内容，已跳过`)
      continue
    }
    if (file.size > MAX_BINARY_FILE || file.size > binaryBudget) {
      warnings.push(`${file.path}：二进制文件超过导出上限，未包含在项目文件中`)
      continue
    }
    try {
      const dataUrl = await blobToDataUrl(file.blob)
      binaryBudget -= file.size
      out.push({
        path: file.path,
        mime: file.mime,
        size: file.size,
        dataUrl,
        hash: file.hash,
        source: file.source,
      })
    } catch (e) {
      warnings.push(`${file.path}：${String((e as Error)?.message || e)}`)
    }
  }

  return {
    format: PROJECT_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt: Date.now(),
    title: task.title,
    entryPath: task.entryPath,
    todos: task.todos || [],
    files: out,
    libraryRefs: refs.map((ref) => ({
      targetType: ref.targetType,
      name: ref.name,
      folderPath: ref.folderPath,
      files: ref.files.map((f) => ({ name: f.name, mime: f.mime, size: f.size, hash: f.hash })),
    })),
    warnings,
  }
}

export function parseProject(input: unknown): ProjectDTO {
  if (!input || typeof input !== 'object') throw new Error('项目文件不是有效 JSON 对象')
  const dto = input as Partial<ProjectDTO>
  if (dto.format !== PROJECT_FORMAT) throw new Error('不是工作台项目文件（format 不匹配）')
  if (dto.version !== TRANSFER_VERSION) throw new Error(`不支持的项目版本：${String(dto.version)}`)
  if (!Array.isArray(dto.files)) throw new Error('项目文件缺少 files 数组')
  if (dto.files.length > MAX_PROJECT_FILES) throw new Error(`项目文件数量超过上限（${MAX_PROJECT_FILES}）`)
  return {
    format: PROJECT_FORMAT,
    version: 1,
    exportedAt: Number(dto.exportedAt) || 0,
    title: typeof dto.title === 'string' ? dto.title.slice(0, 200) : '导入项目',
    entryPath: typeof dto.entryPath === 'string' ? dto.entryPath : '/index.html',
    todos: Array.isArray(dto.todos) ? dto.todos : [],
    files: dto.files,
    libraryRefs: Array.isArray(dto.libraryRefs) ? dto.libraryRefs : [],
    warnings: Array.isArray(dto.warnings) ? dto.warnings : [],
  }
}

export interface ImportProjectResult {
  taskId: string
  title: string
  imported: number
  skipped: string[]
  warnings: string[]
}

export async function importProject(dto: ProjectDTO): Promise<ImportProjectResult> {
  const title = `${dto.title || '导入项目'}（导入）`.slice(0, 200)
  const task = await createTask(title)
  const warnings: string[] = []
  const skipped: string[] = []
  let imported = 0

  for (const file of dto.files) {
    try {
      if (!file || typeof file.path !== 'string') throw new Error('文件记录缺少路径')
      const path = normalizePath(file.path)
      if (path === '/') throw new Error('不能写入工作区根目录')
      if (typeof file.text === 'string') {
        await writeWorkspaceText(task.id, path, file.text, 'user')
      } else if (typeof file.dataUrl === 'string') {
        const blob = dataUrlToBlob(file.dataUrl)
        await writeWorkspaceBinary(task.id, path, blob, 'user', file.hash)
      } else {
        throw new Error('缺少 text 或 dataUrl')
      }
      imported++
    } catch (e) {
      skipped.push(`${String(file?.path || '未知文件')}：${String((e as Error)?.message || e)}`)
    }
  }

  let entryPath = '/index.html'
  try {
    entryPath = normalizePath(dto.entryPath || '/index.html')
  } catch {
    warnings.push(`入口路径不合法，已重置为 /index.html：${dto.entryPath}`)
  }
  // 只接受文本 HTML 入口；其余情况回退到第一个 HTML 文件。
  const htmlFiles = (await listWorkspaceFiles(task.id)).filter((f) => /\.html?$/i.test(f.path))
  if (!htmlFiles.some((f) => f.path === entryPath)) {
    if (htmlFiles.length) entryPath = htmlFiles[0].path
    else warnings.push('项目里没有 HTML 入口文件，可在 Agent 中继续创建')
  }

  await updateTask(task.id, { entryPath, todos: dto.todos || [] })

  if (skipped.length) warnings.push(...skipped.slice(0, 10))
  if (skipped.length > 10) warnings.push(`还有 ${skipped.length - 10} 个文件未导入`)
  if (dto.libraryRefs.length) {
    warnings.push(`项目包含 ${dto.libraryRefs.length} 项资料引用信息；资料库内容不会随项目导入，请在“常用资料”中重新引用。`)
  }
  if (dto.warnings.length) warnings.push(...dto.warnings.slice(0, 10))

  return { taskId: task.id, title, imported, skipped, warnings }
}

/* ───────────────────────────── 完整备份 / 恢复 ───────────────────────────── */

type WorkspaceFileBackup = Omit<WorkspaceFile, 'blob'> & { dataUrl?: string }
type LibraryFileBackup = Omit<LibraryFile, 'blob'> & { dataUrl?: string }
type AttachmentBackup = Omit<Attachment, 'blob'> & { dataUrl?: string }

export interface BackupData {
  tasks: Task[]
  messages: MessageRecord[]
  workspaceFiles: WorkspaceFileBackup[]
  previewSessions: PreviewSessionRecord[]
  executionEvents: ExecutionEventRecord[]
  projectSnapshots: ProjectSnapshotRecord[]
  applicationSaves: ApplicationSave[]
  libraryFolders: LibraryFolder[]
  libraryFiles: LibraryFileBackup[]
  taskLibraryRefs: TaskLibraryRef[]
  attachments: AttachmentBackup[]
  /** v3 起有；旧备份没有时恢复后由 ensureConversations 补默认对话。 */
  conversations?: Conversation[]
}

export type BackupCounts = Record<keyof BackupData, number>

export interface BackupDTO {
  format: typeof BACKUP_FORMAT
  version: 1
  exportedAt: number
  counts: BackupCounts
  incomplete: boolean
  warnings: string[]
  data: BackupData
}

export const BACKUP_TABLES: (keyof BackupData)[] = [
  'tasks',
  'messages',
  'workspaceFiles',
  'previewSessions',
  'executionEvents',
  'projectSnapshots',
  'applicationSaves',
  'libraryFolders',
  'libraryFiles',
  'taskLibraryRefs',
  'attachments',
  'conversations',
]

async function serializeFileRecord<T extends { blob?: Blob; path?: string; name?: string; size: number }>(
  record: T,
  budget: { left: number },
  warnings: string[],
): Promise<Omit<T, 'blob'> & { dataUrl?: string } | null> {
  const { blob, ...rest } = record
  if (!blob) return rest
  if (record.size > MAX_BINARY_FILE || record.size > budget.left) {
    warnings.push(`${record.path || record.name || '二进制文件'}：超过备份二进制上限，未包含内容`)
    return null
  }
  try {
    const dataUrl = await blobToDataUrl(blob)
    budget.left -= record.size
    return { ...rest, dataUrl }
  } catch (e) {
    warnings.push(`${record.path || record.name || '二进制文件'}：${String((e as Error)?.message || e)}`)
    return null
  }
}

export async function createBackup(): Promise<BackupDTO> {
  const [
    tasks,
    messages,
    workspaceFiles,
    previewSessions,
    executionEvents,
    projectSnapshots,
    applicationSaves,
    libraryFolders,
    libraryFiles,
    taskLibraryRefs,
    attachments,
    conversations,
  ] = await Promise.all([
    db.tasks.toArray(),
    db.messages.toArray(),
    db.workspaceFiles.toArray(),
    db.previewSessions.toArray(),
    db.executionEvents.toArray(),
    db.projectSnapshots.toArray(),
    db.applicationSaves.toArray(),
    db.libraryFolders.toArray(),
    db.libraryFiles.toArray(),
    db.taskLibraryRefs.toArray(),
    db.attachments.toArray(),
    db.conversations.toArray(),
  ])

  const warnings: string[] = []
  const budget = { left: MAX_BINARY_TOTAL }
  let incomplete = false

  const wsOut: WorkspaceFileBackup[] = []
  for (const file of workspaceFiles) {
    const out = await serializeFileRecord(file, budget, warnings)
    if (out) wsOut.push(out)
    else incomplete = true
  }
  const libOut: LibraryFileBackup[] = []
  for (const file of libraryFiles) {
    const out = await serializeFileRecord(file, budget, warnings)
    if (out) libOut.push(out)
    else incomplete = true
  }
  const attOut: AttachmentBackup[] = []
  for (const file of attachments) {
    const out = await serializeFileRecord(file, budget, warnings)
    if (out) attOut.push(out)
    else incomplete = true
  }

  const probeText = [
    ...messages.map((m) => m.content || ''),
    ...wsOut.map((f) => f.text || ''),
    ...libOut.map((f) => f.text || ''),
    ...attOut.map((f) => f.text || ''),
  ].join('\n')
  if (secretLike(probeText)) {
    warnings.push('备份内容中检测到疑似密钥字符串（可能来自对话或文件）；备份文件请妥善保管。')
  }
  if (incomplete) warnings.push('部分二进制文件超过大小上限，备份不完整。')

  const data: BackupData = {
    tasks,
    messages,
    workspaceFiles: wsOut,
    previewSessions,
    executionEvents,
    projectSnapshots,
    applicationSaves,
    libraryFolders,
    libraryFiles: libOut,
    taskLibraryRefs,
    attachments: attOut,
    conversations,
  }
  const counts = BACKUP_TABLES.reduce((acc, key) => {
    acc[key] = (data[key] || []).length
    return acc
  }, {} as BackupCounts)

  return {
    format: BACKUP_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt: Date.now(),
    counts,
    incomplete,
    warnings,
    data,
  }
}

export function parseBackup(input: unknown): BackupDTO {
  if (!input || typeof input !== 'object') throw new Error('备份文件不是有效 JSON 对象')
  const dto = input as Partial<BackupDTO>
  if (dto.format !== BACKUP_FORMAT) throw new Error('不是工作台备份文件（format 不匹配）')
  if (dto.version !== TRANSFER_VERSION) throw new Error(`不支持的备份版本：${String(dto.version)}`)
  if (!dto.data || typeof dto.data !== 'object') throw new Error('备份缺少 data')
  const data = dto.data as Partial<BackupData>
  // 旧版备份没有对话表，按空表兼容。
  if (data.conversations === undefined) data.conversations = []
  for (const key of BACKUP_TABLES) {
    if (!Array.isArray(data[key])) throw new Error(`备份缺少 ${key} 数组`)
    const expected = dto.counts?.[key]
    if (typeof expected === 'number' && expected !== (data[key] as unknown[]).length) {
      throw new Error(`备份不完整：${key} 数量与清单不一致`)
    }
  }
  const counts = BACKUP_TABLES.reduce((acc, key) => {
    acc[key] = (data[key] as unknown[]).length
    return acc
  }, {} as BackupCounts)
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: Number(dto.exportedAt) || 0,
    counts,
    incomplete: Boolean(dto.incomplete),
    warnings: Array.isArray(dto.warnings) ? dto.warnings : [],
    data: data as BackupData,
  }
}

export interface RestoreResult {
  taskId: string
  counts: BackupCounts
  warnings: string[]
}

export async function restoreBackup(backup: BackupDTO): Promise<RestoreResult> {
  const data = backup.data
  const warnings = [...backup.warnings]

  const workspaceRecords: WorkspaceFile[] = []
  for (const record of data.workspaceFiles) {
    const { dataUrl, ...rest } = record
    if (dataUrl) workspaceRecords.push({ ...rest, blob: dataUrlToBlob(dataUrl) })
    else workspaceRecords.push(rest as WorkspaceFile)
  }
  const libraryRecords: LibraryFile[] = []
  for (const record of data.libraryFiles) {
    const { dataUrl, ...rest } = record
    if (dataUrl) libraryRecords.push({ ...rest, blob: dataUrlToBlob(dataUrl) })
    else libraryRecords.push(rest as LibraryFile)
  }
  const attachmentRecords: Attachment[] = []
  for (const record of data.attachments) {
    const { dataUrl, ...rest } = record
    if (dataUrl) attachmentRecords.push({ ...rest, blob: dataUrlToBlob(dataUrl) })
    else attachmentRecords.push(rest as Attachment)
  }

  const tasks = data.tasks.map((task) => (task.status === 'running' ? { ...task, status: 'interrupted' as const } : task))

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
      db.libraryFolders,
      db.libraryFiles,
      db.taskLibraryRefs,
      db.attachments,
      db.conversations,
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
        db.libraryFolders.clear(),
        db.libraryFiles.clear(),
        db.taskLibraryRefs.clear(),
        db.attachments.clear(),
        db.conversations.clear(),
      ])
      await db.tasks.bulkPut(tasks)
      await db.messages.bulkPut(data.messages)
      await db.workspaceFiles.bulkPut(workspaceRecords)
      await db.previewSessions.bulkPut(data.previewSessions)
      await db.executionEvents.bulkPut(data.executionEvents)
      await db.projectSnapshots.bulkPut(data.projectSnapshots)
      await db.applicationSaves.bulkPut(data.applicationSaves)
      await db.libraryFolders.bulkPut(data.libraryFolders)
      await db.libraryFiles.bulkPut(libraryRecords)
      await db.taskLibraryRefs.bulkPut(data.taskLibraryRefs)
      await db.attachments.bulkPut(attachmentRecords)
      await db.conversations.bulkPut(data.conversations || [])
      await ensureConversations()
    },
  )

  const firstTask = tasks[0]
  await db.settings.put({ key: 'lastTaskId', value: firstTask?.id || '', updatedAt: Date.now() })

  if (backup.incomplete) warnings.push('这是不完整备份：部分二进制文件未恢复。')
  return {
    taskId: firstTask?.id || '',
    counts: backup.counts,
    warnings,
  }
}
