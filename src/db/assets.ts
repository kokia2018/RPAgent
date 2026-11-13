/** 阶段 2 仓储：常用资料库、任务资料引用、任务附件。 */

import { db } from './db'
import { hashBlob, hashString, randomId } from '../lib/hash'
import { mimeFromPath } from '../lib/mime'
import { normalizePath } from '../lib/path'
import {
  baseName,
  fileNameForLibrary,
  profileForFile,
  sanitizeUploadPath,
  type FileProfile,
} from '../lib/documents'
import { writeWorkspaceBinary, writeWorkspaceText } from './repo'
import { parseCharacterCardFromFile } from '../character/card'
import type {
  Attachment,
  LibraryFile,
  LibraryFolder,
  LibraryRefFile,
  TaskLibraryRef,
  TaskLibraryRefView,
} from './types'

const MAX_TEXT_STORE = 8 * 1024 * 1024

/* ───────────────────────────── 文件夹 ───────────────────────────── */

export async function listLibraryFolders(): Promise<LibraryFolder[]> {
  const rows = await db.libraryFolders.toArray()
  rows.sort((a, b) => a.parentId.localeCompare(b.parentId) || a.name.localeCompare(b.name))
  return rows
}

export async function getLibraryFolder(id: string): Promise<LibraryFolder | undefined> {
  return db.libraryFolders.get(id)
}

export async function folderPath(folderId: string, folders?: LibraryFolder[]): Promise<string> {
  if (!folderId) return ''
  const all = folders || (await listLibraryFolders())
  const byId = new Map(all.map((f) => [f.id, f]))
  const names: string[] = []
  let cur = byId.get(folderId)
  let guard = 0
  while (cur && guard++ < 64) {
    names.unshift(cur.name)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return names.join(' / ')
}

async function siblingFolderNameTaken(parentId: string, name: string, exceptId?: string): Promise<boolean> {
  const rows = await db.libraryFolders.where('parentId').equals(parentId).toArray()
  return rows.some((f) => f.id !== exceptId && f.name.toLowerCase() === name.toLowerCase())
}

export async function createLibraryFolder(name: string, parentId = ''): Promise<LibraryFolder> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('文件夹名称不能为空')
  if (parentId && !(await db.libraryFolders.get(parentId))) throw new Error('上级文件夹不存在')
  if (await siblingFolderNameTaken(parentId, trimmed)) throw new Error('同一层级已有同名文件夹')
  const now = Date.now()
  const folder: LibraryFolder = {
    id: randomId('lf_'),
    parentId,
    name: trimmed.slice(0, 80),
    createdAt: now,
    updatedAt: now,
  }
  await db.libraryFolders.add(folder)
  return folder
}

export async function renameLibraryFolder(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('文件夹名称不能为空')
  const folder = await db.libraryFolders.get(id)
  if (!folder) throw new Error('文件夹不存在')
  if (await siblingFolderNameTaken(folder.parentId, trimmed, id)) {
    throw new Error('同一层级已有同名文件夹')
  }
  await db.libraryFolders.update(id, { name: trimmed.slice(0, 80), updatedAt: Date.now() })
}

/** 递归删除文件夹与其下文件；任务引用保留，并在引用视图里显示为缺失。 */
export async function deleteLibraryFolder(id: string): Promise<{ folders: number; files: number }> {
  const all = await listLibraryFolders()
  const children = new Map<string, string[]>()
  for (const f of all) {
    const list = children.get(f.parentId) || []
    list.push(f.id)
    children.set(f.parentId, list)
  }
  const targetIds: string[] = []
  const queue = [id]
  while (queue.length) {
    const cur = queue.shift() as string
    if (targetIds.includes(cur)) continue
    targetIds.push(cur)
    queue.push(...(children.get(cur) || []))
  }
  const files = await db.libraryFiles.where('folderId').anyOf(targetIds).toArray()
  await db.transaction('rw', [db.libraryFolders, db.libraryFiles], async () => {
    if (files.length) await db.libraryFiles.bulkDelete(files.map((f) => f.id))
    await db.libraryFolders.bulkDelete(targetIds)
  })
  return { folders: targetIds.length, files: files.length }
}

/** 返回某文件夹及其所有子孙文件夹 id。 */
export function descendantFolderIds(folderId: string, folders: LibraryFolder[]): Set<string> {
  const children = new Map<string, string[]>()
  for (const f of folders) {
    const list = children.get(f.parentId) || []
    list.push(f.id)
    children.set(f.parentId, list)
  }
  const out = new Set<string>()
  const queue = [folderId]
  while (queue.length) {
    const cur = queue.shift() as string
    if (out.has(cur)) continue
    out.add(cur)
    queue.push(...(children.get(cur) || []))
  }
  return out
}

/* ───────────────────────────── 资料文件 ───────────────────────────── */

export async function listLibraryFiles(folderId?: string): Promise<LibraryFile[]> {
  const rows =
    folderId === undefined
      ? await db.libraryFiles.toArray()
      : await db.libraryFiles.where('folderId').equals(folderId).toArray()
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

export async function getLibraryFile(id: string): Promise<LibraryFile | undefined> {
  return db.libraryFiles.get(id)
}

export async function libraryFilePath(file: LibraryFile, folders?: LibraryFolder[]): Promise<string> {
  const path = await folderPath(file.folderId, folders)
  return path ? `${path} / ${file.name}` : file.name
}

async function uniqueFileName(folderId: string, name: string): Promise<string> {
  const files = await db.libraryFiles.where('folderId').equals(folderId).toArray()
  const used = new Set(files.map((f) => f.name.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

async function makeTextRecord(
  input: {
    folderId: string
    name: string
    mime: string
    kind: LibraryFile['kind']
    text: string
    profile: FileProfile
    card?: LibraryFile['card']
  },
): Promise<LibraryFile> {
  const now = Date.now()
  const size = new TextEncoder().encode(input.text).length
  const file: LibraryFile = {
    id: randomId('lib_'),
    folderId: input.folderId,
    name: await uniqueFileName(input.folderId, input.name),
    mime: input.mime,
    size,
    text: input.text,
    hash: hashString(input.text),
    kind: input.kind,
    parseStatus: input.profile.status,
    parseNote: input.profile.note,
    card: input.card,
    createdAt: now,
    updatedAt: now,
  }
  await db.libraryFiles.add(file)
  return file
}

export async function uploadLibraryFile(file: File, folderId = ''): Promise<LibraryFile> {
  if (folderId && !(await db.libraryFolders.get(folderId))) throw new Error('目标文件夹不存在')
  const name = fileNameForLibrary(file.name)
  const mime = file.type || mimeFromPath(name)
  const profile = profileForFile(name, mime)
  const textLike = profile.kind === 'html' || profile.kind === 'markdown' || profile.kind === 'json' || profile.kind === 'csv' || profile.kind === 'text'
  if (textLike && file.size <= MAX_TEXT_STORE) {
    const text = await file.text()
    const card = await parseCharacterCardFromFile(name, mime, text, undefined)
    return makeTextRecord({ folderId, name, mime, kind: 'upload', text, profile, card: card?.summary })
  }
  const now = Date.now()
  const record: LibraryFile = {
    id: randomId('lib_'),
    folderId,
    name: await uniqueFileName(folderId, name),
    mime,
    size: file.size,
    blob: file,
    hash: await hashBlob(file),
    kind: 'upload',
    parseStatus: profile.status,
    parseNote: textLike ? '文件超过 8MB，未建立文本索引；仍保留原始文件。' : profile.note,
    createdAt: now,
    updatedAt: now,
  }
  const card = await parseCharacterCardFromFile(name, mime, undefined, file)
  if (card) record.card = card.summary
  await db.libraryFiles.add(record)
  return record
}

export async function saveLibraryNote(name: string, content: string, folderId = ''): Promise<LibraryFile> {
  if (folderId && !(await db.libraryFolders.get(folderId))) throw new Error('目标文件夹不存在')
  let fileName = fileNameForLibrary(name.trim() || '文字资料')
  if (!/\.[a-z0-9]{1,8}$/i.test(fileName)) fileName += '.md'
  return makeTextRecord({
    folderId,
    name: fileName,
    mime: mimeFromPath(fileName),
    kind: 'note',
    text: content,
    profile: profileForFile(fileName),
  })
}

export async function renameLibraryFile(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('资料名称不能为空')
  const file = await db.libraryFiles.get(id)
  if (!file) throw new Error('资料不存在')
  const unique = await uniqueFileName(file.folderId, fileNameForLibrary(trimmed))
  await db.libraryFiles.update(id, { name: unique, updatedAt: Date.now() })
}

export async function moveLibraryFile(id: string, folderId: string): Promise<void> {
  if (folderId && !(await db.libraryFolders.get(folderId))) throw new Error('目标文件夹不存在')
  const file = await db.libraryFiles.get(id)
  if (!file) throw new Error('资料不存在')
  const name = await uniqueFileName(folderId, file.name)
  await db.libraryFiles.update(id, { folderId, name, updatedAt: Date.now() })
}

export async function copyLibraryFile(id: string, folderId?: string): Promise<LibraryFile> {
  const source = await db.libraryFiles.get(id)
  if (!source) throw new Error('资料不存在')
  const targetFolder = folderId ?? source.folderId
  if (targetFolder && !(await db.libraryFolders.get(targetFolder))) throw new Error('目标文件夹不存在')
  const dot = source.name.lastIndexOf('.')
  const stem = dot > 0 ? source.name.slice(0, dot) : source.name
  const ext = dot > 0 ? source.name.slice(dot) : ''
  const copy: LibraryFile = {
    ...source,
    id: randomId('lib_'),
    folderId: targetFolder,
    name: await uniqueFileName(targetFolder, `${stem} 副本${ext}`),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await db.libraryFiles.add(copy)
  return copy
}

export async function deleteLibraryFile(id: string): Promise<void> {
  await db.libraryFiles.delete(id)
}

/** 读取资料正文；不支持文本的资料返回 null。 */
export async function readLibraryFileText(file: LibraryFile): Promise<string | null> {
  if (typeof file.text === 'string') return file.text
  if (file.blob) {
    const profile = profileForFile(file.name, file.mime)
    if (profile.readable || profile.kind === 'markdown' || profile.kind === 'text') {
      try {
        return await file.blob.text()
      } catch {
        return null
      }
    }
  }
  return null
}

export interface LibrarySearchHit {
  fileId: string
  name: string
  path: string
  matches: { line: number; text: string }[]
}

export async function searchLibrary(query: string, limit = 40): Promise<LibrarySearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const lower = q.toLowerCase()
  const [files, folders] = await Promise.all([listLibraryFiles(), listLibraryFolders()])
  const hits: LibrarySearchHit[] = []
  for (const file of files) {
    const path = await libraryFilePath(file, folders)
    const text = await readLibraryFileText(file)
    if (file.name.toLowerCase().includes(lower)) {
      hits.push({ fileId: file.id, name: file.name, path, matches: [] })
    } else if (text && text.toLowerCase().includes(lower)) {
      const lines = text.split(/\r\n|\r|\n/)
      const matches: { line: number; text: string }[] = []
      for (let i = 0; i < lines.length && matches.length < 5; i++) {
        if (lines[i].toLowerCase().includes(lower)) matches.push({ line: i + 1, text: lines[i].slice(0, 300) })
      }
      if (matches.length) hits.push({ fileId: file.id, name: file.name, path, matches })
    }
    if (hits.length >= limit) break
  }
  return hits
}

/* ───────────────────────────── 任务资料引用 ───────────────────────────── */

export async function listTaskLibraryRefs(taskId: string): Promise<TaskLibraryRef[]> {
  const rows = await db.taskLibraryRefs.where('taskId').equals(taskId).toArray()
  rows.sort((a, b) => a.createdAt - b.createdAt)
  return rows
}

export async function addTaskLibraryRef(
  taskId: string,
  targetType: TaskLibraryRef['targetType'],
  targetId: string,
): Promise<TaskLibraryRef> {
  const existing = await db.taskLibraryRefs
    .where('taskId')
    .equals(taskId)
    .filter((r) => r.targetType === targetType && r.targetId === targetId)
    .first()
  if (existing) return existing

  const folders = await listLibraryFolders()
  let name = ''
  let path = ''
  let files: LibraryRefFile[] = []

  if (targetType === 'file') {
    const file = await db.libraryFiles.get(targetId)
    if (!file) throw new Error('资料不存在')
    name = file.name
    path = await folderPath(file.folderId, folders)
    files = [{ fileId: file.id, name: file.name, mime: file.mime, size: file.size, hash: file.hash }]
  } else {
    const folder = folders.find((f) => f.id === targetId)
    if (!folder) throw new Error('文件夹不存在')
    name = folder.name
    path = await folderPath(folder.parentId, folders)
    const ids = descendantFolderIds(targetId, folders)
    const all = await listLibraryFiles()
    files = all
      .filter((f) => ids.has(f.folderId))
      .map((f) => ({ fileId: f.id, name: f.name, mime: f.mime, size: f.size, hash: f.hash }))
  }

  const ref: TaskLibraryRef = {
    id: randomId('ref_'),
    taskId,
    targetType,
    targetId,
    name,
    folderPath: path,
    files,
    createdAt: Date.now(),
  }
  await db.taskLibraryRefs.add(ref)
  return ref
}

export async function removeTaskLibraryRef(id: string): Promise<void> {
  await db.taskLibraryRefs.delete(id)
}

/** 当前引用视图：包含仍存在、已删除、已变更与后来新增的文件数。 */
export async function describeTaskLibraryRefs(taskId: string): Promise<TaskLibraryRefView[]> {
  const [refs, folders, allFiles] = await Promise.all([
    listTaskLibraryRefs(taskId),
    listLibraryFolders(),
    listLibraryFiles(),
  ])
  const byId = new Map(allFiles.map((f) => [f.id, f]))
  return refs.map((ref) => {
    let current: LibraryFile[]
    if (ref.targetType === 'file') {
      const f = byId.get(ref.targetId)
      current = f ? [f] : []
    } else {
      const ids = descendantFolderIds(ref.targetId, folders)
      current = allFiles.filter((f) => ids.has(f.folderId))
    }
    const snapshot = new Map(ref.files.map((f) => [f.fileId, f]))
    const currentIds = new Set(current.map((f) => f.id))
    const missingFiles = ref.files.filter((f) => !byId.has(f.fileId))
    const changedFiles = ref.files.filter((f) => {
      const now = byId.get(f.fileId)
      return now ? now.hash !== f.hash : false
    })
    const addedFiles = current.filter((f) => !snapshot.has(f.id)).length
    return {
      ...ref,
      currentFiles: current.length,
      addedFiles,
      missingFiles,
      changedFiles,
    }
  })
}

/** 当前任务可访问的资料（引用文件本身或引用文件夹内的现文件）。 */
export async function selectedLibraryFiles(taskId: string): Promise<LibraryFile[]> {
  const [refs, folders, allFiles] = await Promise.all([
    listTaskLibraryRefs(taskId),
    listLibraryFolders(),
    listLibraryFiles(),
  ])
  const allowedIds = new Set<string>()
  for (const ref of refs) {
    if (ref.targetType === 'file') allowedIds.add(ref.targetId)
    else {
      for (const id of descendantFolderIds(ref.targetId, folders)) {
        for (const f of allFiles) if (f.folderId === id) allowedIds.add(f.id)
      }
    }
  }
  return allFiles.filter((f) => allowedIds.has(f.id))
}

export async function getSelectedLibraryFile(taskId: string, fileId: string): Promise<LibraryFile> {
  const files = await selectedLibraryFiles(taskId)
  const found = files.find((f) => f.id === fileId)
  if (!found) throw new Error('该资料不在当前任务已选范围内。请让用户在任务资料面板中选择它。')
  return found
}

export async function saveAttachmentToLibrary(attachment: Attachment, folderId = ''): Promise<LibraryFile> {
  const profile = profileForFile(attachment.name, attachment.mime)
  const now = Date.now()
  const record: LibraryFile = {
    id: randomId('lib_'),
    folderId,
    name: await uniqueFileName(folderId, fileNameForLibrary(attachment.name)),
    mime: attachment.mime,
    size: attachment.size,
    text: attachment.text,
    blob: attachment.blob,
    hash: attachment.hash,
    kind: 'upload',
    parseStatus: profile.status,
    parseNote: profile.note,
    card: attachment.card,
    createdAt: now,
    updatedAt: now,
  }
  await db.libraryFiles.add(record)
  return record
}

/* ───────────────────────────── 任务附件 ───────────────────────────── */

export async function listTaskAttachments(taskId: string): Promise<Attachment[]> {
  const rows = await db.attachments.where('taskId').equals(taskId).toArray()
  rows.sort((a, b) => a.createdAt - b.createdAt)
  return rows
}

export async function getTaskAttachment(id: string): Promise<Attachment | undefined> {
  return db.attachments.get(id)
}

export async function prepareTaskAttachment(
  taskId: string,
  file: File,
  relativePath?: string,
): Promise<Attachment> {
  const name = sanitizeUploadPath(relativePath || file.name)
  const mime = file.type || mimeFromPath(name)
  const profile = profileForFile(name, mime)
  const textLike =
    profile.kind === 'html' ||
    profile.kind === 'markdown' ||
    profile.kind === 'json' ||
    profile.kind === 'csv' ||
    profile.kind === 'text'
  const text = textLike && file.size <= MAX_TEXT_STORE ? await file.text() : undefined
  const blob = file
  const attachment: Attachment = {
    id: randomId('att_'),
    taskId,
    name,
    mime,
    size: file.size,
    hash: await hashBlob(file),
    text,
    blob,
    parseStatus: profile.status,
    parseNote: textLike && file.size > MAX_TEXT_STORE ? '文件超过 8MB，只保留原始数据；读取时按需加载。' : profile.note,
    createdAt: Date.now(),
  }
  const card = await parseCharacterCardFromFile(name, mime, text, blob)
  if (card) attachment.card = card.summary
  return attachment
}

export async function addTaskAttachment(
  taskId: string,
  file: File,
  relativePath?: string,
): Promise<Attachment> {
  const attachment = await prepareTaskAttachment(taskId, file, relativePath)
  await db.attachments.add(attachment)
  return attachment
}

export async function deleteTaskAttachment(id: string): Promise<void> {
  await db.attachments.delete(id)
}

export async function readAttachmentText(attachment: Attachment): Promise<string | null> {
  if (typeof attachment.text === 'string') return attachment.text
  if (attachment.parseStatus !== 'readable' && attachment.parseStatus !== 'runnable') return null
  if (attachment.blob) {
    try {
      return await attachment.blob.text()
    } catch {
      return null
    }
  }
  return null
}

export interface ImportAttachmentsResult {
  imported: string[]
  replaced: string[]
  htmlEntries: string[]
  warnings: string[]
  kept: string[]
}

export function attachmentWorkspacePath(name: string, targetDir = '/uploads'): string {
  return normalizePath(`${normalizePath(targetDir)}/${sanitizeUploadPath(name)}`)
}

/** 附件原件只读；再次导入保留工作副本，避免重开作品覆盖编辑结果。 */
export async function importAttachmentsToWorkspace(
  taskId: string,
  attachmentIds?: string[],
  targetDir = '/uploads',
): Promise<ImportAttachmentsResult> {
  const all = await listTaskAttachments(taskId)
  const selected = attachmentIds?.length
    ? all.filter((a) => attachmentIds.includes(a.id))
    : all
  if (!selected.length) throw new Error('没有可导入的附件')

  const dir = normalizePath(targetDir || '/uploads')
  if (dir === '/') throw new Error('不能把附件直接铺到工作区根目录，请指定子目录')
  const imported: string[] = []
  const kept: string[] = []
  const replaced: string[] = []
  const htmlEntries: string[] = []
  const warnings: string[] = []

  for (const attachment of selected) {
    const relative = sanitizeUploadPath(attachment.name)
    const path = normalizePath(`${dir}/${relative}`)
    const existed = Boolean(await db.workspaceFiles.get([taskId, path]))
    if (existed) {
      kept.push(path)
      if (profileForFile(path, attachment.mime).runnable) htmlEntries.push(path)
      continue
    }
    const text = await readAttachmentText(attachment)
    const textImportable =
      text != null && (attachment.parseStatus === 'readable' || attachment.parseStatus === 'runnable')
    if (textImportable) {
      await writeWorkspaceText(taskId, path, text as string, 'attachment')
    } else if (attachment.blob) {
      await writeWorkspaceBinary(taskId, path, attachment.blob, 'attachment', attachment.hash)
    } else if (attachment.text != null) {
      await writeWorkspaceText(taskId, path, attachment.text, 'attachment')
    } else {
      warnings.push(`附件没有可写内容，已跳过：${attachment.name}`)
      continue
    }
    imported.push(path)
    if (existed) replaced.push(path)
    if (profileForFile(path, attachment.mime).runnable) htmlEntries.push(path)
  }

  if (htmlEntries.length > 1) {
    warnings.push(`导入了 ${htmlEntries.length} 个 HTML，运行时请选择正确的入口。`)
  }
  if (kept.length) warnings.push(`保留了 ${kept.length} 个已有工作副本，没有覆盖你的修改。`)
  return { imported, replaced, htmlEntries, warnings, kept }
}

export function attachmentDisplayName(attachment: Attachment): string {
  return baseName(attachment.name)
}
