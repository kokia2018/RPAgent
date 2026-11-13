import 'fake-indexeddb/auto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  createSnapshot,
  appendMessage,
  listMessages,
  createTask,
  deleteTask,
  diffSnapshot,
  getWorkspaceFile,
  listAppSaves,
  listWorkspaceFiles,
  mergeAppSaves,
  restoreSnapshot,
  writeWorkspaceText,
} from './repo'
import { exportHtml } from '../export/exportHtml'
import { standaloneNamespace } from '../export/standaloneRuntime'
import { createSaveBundle, readSaveBundle } from '../export/saves'

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((t) => t.clear()))
})

afterAll(async () => {
  db.close()
})

describe('任务隔离（真实 Dexie / fake-indexeddb）', () => {
  it('并发追加消息序号唯一，删除任务同时删除任务级覆盖', async () => {
    const task = await createTask('消息序号')
    await Promise.all(Array.from({ length: 8 }, (_, i) => appendMessage({ taskId: task.id, role: 'user', content: String(i), status: 'done' })))
    expect((await listMessages(task.id)).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    await db.settings.put({ key: `api:task:${task.id}`, value: { apiKey: 'synthetic-only' }, updatedAt: 1 })
    await db.settings.put({ key: 'api', value: { model: 'global' }, updatedAt: 1 })
    await deleteTask(task.id)
    expect(await db.settings.get(`api:task:${task.id}`)).toBeUndefined()
    expect(await db.settings.get('api')).toBeDefined()
  })

  it('两个任务写同名文件互不覆盖', async () => {
    const a = await createTask('任务 A')
    const b = await createTask('任务 B')
    await writeWorkspaceText(a.id, '/index.html', '<h1>A</h1>')
    await writeWorkspaceText(b.id, '/index.html', '<h1>B</h1>')

    const aFile = await getWorkspaceFile(a.id, '/index.html')
    const bFile = await getWorkspaceFile(b.id, '/index.html')
    expect(aFile?.text).toContain('A')
    expect(bFile?.text).toContain('B')

    const aFiles = await listWorkspaceFiles(a.id)
    const bFiles = await listWorkspaceFiles(b.id)
    expect(aFiles).toHaveLength(1)
    expect(bFiles).toHaveLength(1)
    expect(aFiles[0].path).toBe('/index.html')
  })

  it('删除任务 A 不影响任务 B 的文件', async () => {
    const a = await createTask('任务 A')
    const b = await createTask('任务 B')
    await writeWorkspaceText(a.id, '/a.txt', 'A')
    await writeWorkspaceText(b.id, '/b.txt', 'B')
    await deleteTask(a.id)
    expect(await listWorkspaceFiles(a.id)).toHaveLength(0)
    const bFiles = await listWorkspaceFiles(b.id)
    expect(bFiles).toHaveLength(1)
    expect(bFiles[0].text).toBe('B')
  })
})

describe('快照与恢复', () => {
  it('超预算快照不会把后来改动的正文恢复为空', async () => {
    const task = await createTask('大文件')
    await writeWorkspaceText(task.id, '/large.txt', 'x'.repeat(1024 * 1024 + 1))
    const snap = await createSnapshot(task.id, '超限')
    await writeWorkspaceText(task.id, '/large.txt', '当前内容')
    const restored = await restoreSnapshot(snap.id)
    expect(restored.missingText).toEqual(['/large.txt'])
    expect((await getWorkspaceFile(task.id, '/large.txt'))?.text).toBe('当前内容')
  })

  it('快照 diff 与恢复文本文件', async () => {
    const task = await createTask('快照任务')
    await writeWorkspaceText(task.id, '/index.html', '<h1>v1</h1>')
    const snap = await createSnapshot(task.id, 'v1')
    await writeWorkspaceText(task.id, '/index.html', '<h1>v2</h1>')

    const diff = await diffSnapshot(snap.id)
    expect(diff.changed).toContain('/index.html')

    const restored = await restoreSnapshot(snap.id)
    expect(restored.restored).toBe(1)
    const file = await getWorkspaceFile(task.id, '/index.html')
    expect(file?.text).toBe('<h1>v1</h1>')
  })
})

describe('单 HTML 导出（真实工作区）', () => {
  it('内联本地 CSS 并写入 /dist', async () => {
    const task = await createTask('导出任务')
    await writeWorkspaceText(task.id, '/style.css', 'body{color:red}')
    await writeWorkspaceText(
      task.id,
      '/index.html',
      '<!doctype html><link rel="stylesheet" href="/style.css"><h1 id="out">初始</h1>' +
        '<button id="btn" onclick="document.getElementById(\'out\').textContent=\'已点击\'">点我</button>',
    )

    const result = await exportHtml(task.id, '/index.html', 'demo', 'Demo')
    expect(result.level).toBe('offline-static')
    expect(result.checks.missing).toHaveLength(0)
    const out = await getWorkspaceFile(task.id, '/dist/demo.html')
    expect(out?.text).toContain('body{color:red}')
    expect(out?.text).toContain('初始')
    expect(out?.text).toContain('id="btn"')
    expect(out?.text).not.toContain('__bridge.js')
    expect(out?.text).not.toContain('/__vfs__/')

    // 供独立打开验收：这个文件由测试生成，位于 tmp/，不进入交付目录。
    mkdirSync('tmp', { recursive: true })
    writeFileSync('tmp/exported-demo.html', out?.text || '')
  })

  it('缺失资源判定为不完整', async () => {
    const task = await createTask('缺失任务')
    await writeWorkspaceText(task.id, '/index.html', '<img src="missing.png">')
    const result = await exportHtml(task.id, '/index.html', 'missing')
    expect(result.level).toBe('incomplete')
    expect(result.checks.missing).toContain('/missing.png')
  })

  it('Workbench.ai 注入独立 AI 运行时并判定为 needs-network', async () => {
    const task = await createTask('独立 AI')
    await writeWorkspaceText(
      task.id,
      '/index.html',
      '<script>window.Workbench.ai.chat({messages:[]})</script><h1>x</h1>',
    )
    const result = await exportHtml(task.id, '/index.html', 'wb')
    expect(result.level).toBe('needs-network')
    expect(result.capabilities.ai).toBe(true)
    expect(result.checks.workbenchRefs).toHaveLength(0)
    const out = await getWorkspaceFile(task.id, '/dist/wb.html')
    expect(out?.text).toContain('AI 设置')
    expect(out?.text).toContain(standaloneNamespace(`${task.id}:/index.html`) + 'ai:config')
    expect(out?.text).not.toContain('Bearer sk-')
  })

  it('使用 Workbench.preview 时仍判定为 needs-workbench', async () => {
    const task = await createTask('预览桥依赖')
    await writeWorkspaceText(
      task.id,
      '/index.html',
      '<script>window.Workbench.preview.sessionId</script><h1>x</h1>',
    )
    const result = await exportHtml(task.id, '/index.html', 'preview-dep')
    expect(result.level).toBe('needs-workbench')
    expect(result.capabilities.ai).toBe(false)
    expect(result.checks.workbenchRefs.length).toBeGreaterThan(0)
  })

  it('仅使用 Workbench.storage 时注入独立存储并判定为可离线', async () => {
    const task = await createTask('存储桥')
    await writeWorkspaceText(
      task.id,
      '/index.html',
      '<script>window.Workbench.storage.get("score").then(v => document.title = String(v))</script><h1>storage</h1>',
    )
    const result = await exportHtml(task.id, '/index.html', 'storage-demo')
    expect(result.level).toBe('offline-static')
    expect(result.checks.workbenchRefs).toHaveLength(0)
    const out = await getWorkspaceFile(task.id, '/dist/storage-demo.html')
    expect(out?.text).toContain('window.Workbench.storage=')
    expect(out?.text).toContain(standaloneNamespace(`${task.id}:/index.html`))
    expect(result.warnings.join(' ')).toContain('独立 localStorage')
  })

  it('疑似密钥进入检查结果', async () => {
    const task = await createTask('密钥任务')
    await writeWorkspaceText(
      task.id,
      '/index.html',
      '<script>const key = "sk-abcdefghijklmnopqrstuvwxyz123456"</script>',
    )
    const result = await exportHtml(task.id, '/index.html', 'secret')
    expect(result.checks.secrets.length).toBeGreaterThan(0)
  })
})

describe('作品存档迁移', () => {
  it('导出包可导入到另一个任务，并保留键值', async () => {
    const a = await createTask('存档源')
    const b = await createTask('存档目标')
    await mergeAppSaves(a.id, 'preview', { score: 7, flags: { seen: true } }, { replace: true })
    const rows = await listAppSaves(a.id, 'preview')
    expect(rows.map((r) => r.key)).toEqual(['flags', 'score'])

    const entries: Record<string, unknown> = {}
    for (const row of rows) entries[row.key] = row.value
    const bundle = createSaveBundle(entries, { source: 'preview', app: '/index.html' })
    const parsed = readSaveBundle(JSON.parse(JSON.stringify(bundle)))
    const result = await mergeAppSaves(b.id, 'preview', parsed.entries, { replace: false })
    expect(result.written).toBe(2)

    const copied = await listAppSaves(b.id, 'preview')
    expect(copied.map((r) => r.key)).toEqual(['flags', 'score'])
    expect(copied.find((r) => r.key === 'score')?.value).toBe(7)
  })

  it('replace 会删除包中不存在的键', async () => {
    const task = await createTask('替换存档')
    await mergeAppSaves(task.id, 'preview', { a: 1, b: 2 }, { replace: true })
    const result = await mergeAppSaves(task.id, 'preview', { b: 9 }, { replace: true })
    expect(result).toEqual({ written: 1, removed: 1 })
    const rows = await listAppSaves(task.id, 'preview')
    expect(rows).toEqual([expect.objectContaining({ key: 'b', value: 9 })])
  })
})
