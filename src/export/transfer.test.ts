import 'fake-indexeddb/auto'
import { File as NativeFile } from 'node:buffer'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { saveApiSettings, getApiSettings } from '../db/db'
import { DEFAULT_API_SETTINGS } from '../db/types'
import {
  createSnapshot,
  createTask,
  getTask,
  getWorkspaceFile,
  listWorkspaceFiles,
  updateTask,
  writeWorkspaceText,
} from '../db/repo'
import {
  addTaskAttachment,
  addTaskLibraryRef,
  createLibraryFolder,
  getLibraryFile,
  listTaskAttachments,
  listTaskLibraryRefs,
  saveLibraryNote,
} from '../db/assets'
import { createBackup, exportProject, importProject, parseBackup, parseProject, restoreBackup } from './transfer'

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((t) => t.clear()))
})

afterAll(() => {
  db.close()
})

describe('项目导出 / 导入', () => {
  it('导出工作区与资料引用信息，并导入为新任务', async () => {
    const task = await createTask('导出项目')
    await writeWorkspaceText(task.id, '/index.html', '<link rel="stylesheet" href="style.css"><h1>Hi</h1>')
    await writeWorkspaceText(task.id, '/style.css', 'body{color:red}')
    await updateTask(task.id, {
      entryPath: '/index.html',
      todos: [{ content: '页面', status: 'completed' }],
    })
    const folder = await createLibraryFolder('模板')
    await saveLibraryNote('说明', '长期参考', folder.id)
    await addTaskLibraryRef(task.id, 'folder', folder.id)

    const dto = await exportProject(task.id)
    expect(dto.format).toBe('rpagent-project')
    expect(dto.files.map((f) => f.path).sort()).toEqual(['/index.html', '/style.css'])
    expect(dto.libraryRefs).toHaveLength(1)
    expect(JSON.stringify(dto)).not.toContain('sk-')

    const parsed = parseProject(JSON.parse(JSON.stringify(dto)))
    const imported = await importProject(parsed)
    expect(imported.imported).toBe(2)
    const newTask = await getTask(imported.taskId)
    expect(newTask?.title).toContain('导出项目')
    expect(newTask?.entryPath).toBe('/index.html')
    expect(newTask?.todos).toHaveLength(1)
    const files = await listWorkspaceFiles(imported.taskId)
    expect(files.map((f) => f.path).sort()).toEqual(['/index.html', '/style.css'])
    expect((await getWorkspaceFile(imported.taskId, '/style.css'))?.text).toBe('body{color:red}')
    expect(imported.warnings.join(' ')).toContain('资料引用')
  })

  it('拒绝越界路径但保留其余文件', async () => {
    const dto = parseProject({
      format: 'rpagent-project',
      version: 1,
      title: '越界',
      entryPath: '/index.html',
      files: [
        { path: '../evil.txt', mime: 'text/plain', size: 1, text: 'x', hash: 'h', source: 'user' },
        { path: '/index.html', mime: 'text/html', size: 2, text: 'ok', hash: 'h2', source: 'user' },
      ],
    })
    const result = await importProject(dto)
    expect(result.imported).toBe(1)
    expect(result.skipped).toHaveLength(1)
    expect(result.warnings.join(' ')).toContain('..')
    expect((await getWorkspaceFile(result.taskId, '/index.html'))?.text).toBe('ok')
  })

  it('拒绝错误格式', () => {
    expect(() => parseProject({ format: 'other', version: 1, files: [] })).toThrow('不是工作台项目文件')
  })
})

describe('完整备份 / 恢复', () => {
  it('备份任务、资料、附件、引用与快照；恢复后保留 API 设置', async () => {
    await saveApiSettings({
      ...DEFAULT_API_SETTINGS,
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test-should-stay-local',
      model: 'test-model',
    })

    const task = await createTask('备份任务')
    await writeWorkspaceText(task.id, '/index.html', '<h1>backup</h1>')
    const folder = await createLibraryFolder('资料')
    const note = await saveLibraryNote('笔记', '常用内容', folder.id)
    await addTaskLibraryRef(task.id, 'folder', folder.id)
    await addTaskAttachment(task.id, new NativeFile(['# 附件'], 'note.md', { type: 'text/markdown' }) as unknown as File)
    await createSnapshot(task.id, '手动快照')
    await db.applicationSaves.put({
      id: `${task.id}::app::score`,
      taskId: task.id,
      namespace: 'app',
      key: 'score',
      value: { score: 3 },
      updatedAt: Date.now(),
    })
    await db.messages.add({
      taskId: task.id,
      seq: 1,
      role: 'user',
      content: '备份消息',
      status: 'done',
      createdAt: Date.now(),
    })

    const backup = await createBackup()
    expect(backup.data.tasks).toHaveLength(1)
    expect(backup.data.messages).toHaveLength(1)
    expect(backup.data.libraryFiles).toHaveLength(1)
    expect(backup.data.taskLibraryRefs).toHaveLength(1)
    expect(JSON.stringify(backup)).not.toContain('sk-test-should-stay-local')

    const parsed = parseBackup(JSON.parse(JSON.stringify(backup)))
    expect(parsed.counts.tasks).toBe(1)

    // 清空业务数据，模拟换浏览器 / 清库
    await Promise.all([
      db.tasks.clear(),
      db.messages.clear(),
      db.workspaceFiles.clear(),
      db.libraryFolders.clear(),
      db.libraryFiles.clear(),
      db.taskLibraryRefs.clear(),
      db.attachments.clear(),
      db.projectSnapshots.clear(),
      db.applicationSaves.clear(),
    ])

    const restored = await restoreBackup(parsed)
    expect(restored.taskId).toBe(task.id)
    expect((await getTask(task.id))?.title).toBe('备份任务')
    expect((await getWorkspaceFile(task.id, '/index.html'))?.text).toBe('<h1>backup</h1>')
    expect((await getLibraryFile(note.id))?.text).toBe('常用内容')
    expect(await listTaskLibraryRefs(task.id)).toHaveLength(1)
    expect(await listTaskAttachments(task.id)).toHaveLength(1)
    expect(await db.projectSnapshots.where('taskId').equals(task.id).count()).toBe(1)
    expect((await db.applicationSaves.get(`${task.id}::app::score`))?.value).toEqual({ score: 3 })

    const api = await getApiSettings()
    expect(api.apiKey).toBe('sk-test-should-stay-local')
    expect(api.baseUrl).toBe('https://example.com/v1')
  })

  it('数量清单不一致时拒绝恢复', async () => {
    const task = await createTask('校验')
    const backup = await createBackup()
    const raw = JSON.parse(JSON.stringify(backup))
    raw.counts.tasks = 5
    expect(() => parseBackup(raw)).toThrow('数量与清单不一致')
    expect(await getTask(task.id)).toBeTruthy()
  })

  it('运行中任务恢复后标记为中断', async () => {
    const task = await createTask('运行中')
    await updateTask(task.id, { status: 'running' })
    const backup = parseBackup(JSON.parse(JSON.stringify(await createBackup())))
    await restoreBackup(backup)
    expect((await getTask(task.id))?.status).toBe('interrupted')
  })
})
