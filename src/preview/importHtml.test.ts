import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { createTask, getTask, listWorkspaceFiles, readWorkspaceText } from '../db/repo'
import { createPreviewHtml, importPreviewHtml, NEW_PREVIEW_HTML } from './importHtml'

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('试玩面板直接新建 / 导入 HTML', () => {
  it('新建会写入工作区，并把入口指向新文件', async () => {
    const { id } = await createTask('新建 HTML')
    const path = await createPreviewHtml(id, 'demo', NEW_PREVIEW_HTML)
    expect(path).toBe('/demo.html')
    expect(await readWorkspaceText(id, path)).toContain('新作品')
    expect((await getTask(id))?.entryPath).toBe('/demo.html')
  })

  it('自动补 .html，并拒绝空内容、非 HTML 名与覆盖同名文件', async () => {
    const { id } = await createTask('新建边界')
    expect(await createPreviewHtml(id, 'plain', '<h1>ok</h1>')).toBe('/plain.html')
    expect(await readWorkspaceText(id, '/plain.html')).toBe('<h1>ok</h1>')
    await expect(createPreviewHtml(id, 'plain', '<h1>覆盖</h1>')).rejects.toThrow('同名')
    await expect(createPreviewHtml(id, 'empty.html', '   ')).rejects.toThrow('不能为空')
    await expect(createPreviewHtml(id, 'notes.txt', 'x')).rejects.toThrow('.html')
  })

  it('导入多文件时保留相对路径，并优先用 index.html 作为入口', async () => {
    const { id } = await createTask('导入 HTML')
    const files = [
      new File(['<link rel="stylesheet" href="app.css"><script src="app.js"></script>'], 'index.html', { type: 'text/html' }),
      new File(['body{color:red}'], 'app.css', { type: 'text/css' }),
      new File(['console.log(1)'], 'app.js', { type: 'text/javascript' }),
    ]
    const result = await importPreviewHtml(id, files)
    expect(result.paths).toHaveLength(3)
    expect(result.entryPath).toMatch(/^\/uploads\/import_[\w-]+\/index\.html$/)
    expect(result.htmlEntries).toEqual([result.entryPath])
    const rows = await listWorkspaceFiles(id)
    expect(rows.map((row) => row.path).sort()).toEqual([...result.paths].sort())
    const script = result.paths.find((path) => path.endsWith('/app.js'))!
    expect(await readWorkspaceText(id, script)).toBe('console.log(1)')
    expect((await getTask(id))?.entryPath).toBe(result.entryPath)
  })

  it('导入文件夹时保留目录层级，并用第一个 HTML 兜底', async () => {
    const { id } = await createTask('导入文件夹')
    const page = new File(['<h1>page</h1>'], 'page.html', { type: 'text/html' })
    Object.defineProperty(page, 'webkitRelativePath', { value: 'mysite/sub/page.html' })
    const style = new File(['h1{color:blue}'], 'style.css', { type: 'text/css' })
    Object.defineProperty(style, 'webkitRelativePath', { value: 'mysite/sub/style.css' })
    const result = await importPreviewHtml(id, [page, style])
    expect(result.entryPath).toBe(result.htmlEntries[0])
    expect(result.entryPath).toMatch(/\/mysite\/sub\/page\.html$/)
    expect(result.paths.some((path) => path.endsWith('/mysite/sub/style.css'))).toBe(true)
  })

  it('没有 HTML 或路径重名时明确报错', async () => {
    const { id } = await createTask('导入错误')
    await expect(importPreviewHtml(id, [new File(['x'], 'a.txt', { type: 'text/plain' })])).rejects.toThrow('.html')
    await expect(
      importPreviewHtml(id, [new File(['a'], 'index.html'), new File(['b'], 'index.html')]),
    ).rejects.toThrow('重名')
  })
})
