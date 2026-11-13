import 'fake-indexeddb/auto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { createTask, getWorkspaceFile, writeWorkspaceText } from '../db/repo'
import { addTaskAttachment, addTaskLibraryRef, createLibraryFolder, saveLibraryNote } from '../db/assets'
import { createToolRegistry, type ToolContext } from './tools'

let taskId = ''

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((t) => t.clear()))
  const task = await createTask('工具测试')
  taskId = task.id
})

afterAll(() => {
  db.close()
})

function ctx(spaceId = taskId): ToolContext {
  return {
    taskId: spaceId,
    runId: 'run_test',
    signal: new AbortController().signal,
    emit: () => undefined,
  }
}

describe('工作区工具', () => {
  it('卡片导出到独立工作文件，拒绝未知格式和错误扩展名', async () => {
    const tools = createToolRegistry(ctx())
    await writeWorkspaceText(taskId, '/source.json', JSON.stringify({ name: '测试', description: '中性角色', first_mes: '你好', extensions: { custom: true } }))
    await writeWorkspaceText(taskId, '/manifest.json', JSON.stringify({ source: { path: '/source.json' } }))
    const out = await tools.component({ action: 'export', manifestPath: '/manifest.json', target: 'json-v3' })
    expect(out.success).toBe(true)
    const path = (out.data as any).path
    expect(path).toBe('/cards/测试.v3.json')
    expect(JSON.parse((await getWorkspaceFile(taskId, path))!.text!).data.extensions).toEqual({ custom: true })
    expect((await tools.component({ action: 'export', manifestPath: '/manifest.json', target: 'bad' })).success).toBe(false)
    expect((await tools.component({ action: 'export', manifestPath: '/manifest.json', target: 'json-v3', outPath: '/cards/test.txt' })).success).toBe(false)
  })
  it('缺少或错误类型的内容不清空已有文件', async () => {
    await writeWorkspaceText(taskId, '/safe.txt', '保留正文')
    const tools = createToolRegistry(ctx())
    for (const content of [undefined, null, 42]) {
      const result = await tools.fs_write({ path: '/safe.txt', content })
      expect(result.success).toBe(false)
      expect((await getWorkspaceFile(taskId, '/safe.txt'))?.text).toBe('保留正文')
    }
  })

  it('其他工作空间的窗口只能 observe，不能关闭或刷新', async () => {
    const other = await createTask('别的任务')
    await db.previewSessions.put({ id: 'foreign-pv', taskId: other.id, name: 'x', entryPath: '/index.html', mode: 'inline', status: 'ready', buildVersion: 1, capabilities: {} as any, limitations: [], createdAt: 1, updatedAt: 1 })
    const tools = createToolRegistry(ctx())
    for (const action of ['close', 'refresh']) {
      const result = await tools.preview({ action, sessionId: 'foreign-pv' })
      expect(result.success).toBe(false)
      expect(result.error?.message).toContain('其他工作空间')
    }
    // observe 允许跨空间（只读）；这里没有真实 iframe，失败原因不应是权限
    const observed = await tools.preview({ action: 'observe', sessionId: 'foreign-pv' })
    expect(String(observed.error?.message || '')).not.toContain('其他工作空间')
    expect((await db.previewSessions.get('foreign-pv'))?.status).toBe('ready')
  })

  it('写入、读取、搜索、删除', async () => {
    const tools = createToolRegistry(ctx())
    const write = await tools.fs_write({ path: '/src/app.js', content: 'const answer = 42\nconsole.log(answer)' })
    expect(write.success).toBe(true)
    expect((write.data as { created: boolean }).created).toBe(true)

    const read = await tools.fs_read({ path: '/src/app.js' })
    expect(read.success).toBe(true)
    expect((read.data as { content: string }).content).toContain('answer = 42')

    const search = await tools.fs_search({ query: 'answer' })
    expect(search.success).toBe(true)
    expect((search.data as { matches: unknown[] }).matches.length).toBeGreaterThan(0)

    const del = await tools.fs_delete({ path: '/src/app.js' })
    expect(del.success).toBe(true)
    expect((del.data as { deleted: number }).deleted).toBe(1)
    expect(await getWorkspaceFile(taskId, '/src/app.js')).toBeUndefined()
  })

  it('fs_edit 精确替换且不解释 $ 符号', async () => {
    const tools = createToolRegistry(ctx())
    await tools.fs_write({ path: '/a.txt', content: 'price: 10' })
    const edit = await tools.fs_edit({ path: '/a.txt', oldString: '10', newString: '$& 20' })
    expect(edit.success).toBe(true)
    const file = await getWorkspaceFile(taskId, '/a.txt')
    expect(file?.text).toBe('price: $& 20')
  })

  it('build_project 报告缺失资源', async () => {
    const tools = createToolRegistry(ctx())
    await tools.fs_write({ path: '/index.html', content: '<img src="missing.png">' })
    const build = await tools.build_project({ entryPath: '/index.html' })
    expect(build.success).toBe(true)
    expect((build.data as { missing: string[] }).missing).toContain('/missing.png')
  })

  it('snapshot create / diff / restore', async () => {
    const tools = createToolRegistry(ctx())
    await tools.fs_write({ path: '/note.txt', content: 'v1' })
    const created = await tools.snapshot({ action: 'create', label: 'v1' })
    expect(created.success).toBe(true)
    const id = (created.data as { id: string }).id

    await writeWorkspaceText(taskId, '/note.txt', 'v2')
    const diff = await tools.snapshot({ action: 'diff', id })
    expect(diff.success).toBe(true)
    expect((diff.data as { diff: { changed: string[] } }).diff.changed).toContain('/note.txt')

    const restored = await tools.snapshot({ action: 'restore', id })
    expect(restored.success).toBe(true)
    const file = await getWorkspaceFile(taskId, '/note.txt')
    expect(file?.text).toBe('v1')
  })
})

describe('资料与附件工具', () => {
  it('library 只能读取已选资料，并可复制到工作区', async () => {
    const folder = await createLibraryFolder('参考')
    const selected = await saveLibraryNote('已选资料', 'hello library content', folder.id)
    const other = await saveLibraryNote('未选资料', 'secret content')
    await addTaskLibraryRef(taskId, 'folder', folder.id)

    const tools = createToolRegistry(ctx())
    const refs = await tools.library({ action: 'list_refs' })
    expect(refs.success).toBe(true)
    expect((refs.data as { count: number }).count).toBe(1)

    const read = await tools.library({ action: 'read', fileId: selected.id })
    expect(read.success).toBe(true)
    expect((read.data as { content: string }).content).toContain('hello library content')

    const denied = await tools.library({ action: 'read', fileId: other.id })
    expect(denied.success).toBe(false)
    expect(denied.error?.message).toContain('不在当前任务已选范围')

    const copy = await tools.library({
      action: 'copy_to_workspace',
      fileId: selected.id,
      targetPath: '/notes/guide.md',
    })
    expect(copy.success).toBe(true)
    const copied = await getWorkspaceFile(taskId, '/notes/guide.md')
    expect(copied?.text).toContain('hello library content')
    expect(copied?.source).toBe('library')

    const overwrite = await tools.library({
      action: 'copy_to_workspace',
      fileId: selected.id,
      targetPath: '/notes/guide.md',
    })
    expect(overwrite.success).toBe(false)
    expect(overwrite.error?.code).toBe('already_exists')
  })

  it('attachment 列表、读取与多文件导入', async () => {
    await addTaskAttachment(
      taskId,
      new File(['<link rel="stylesheet" href="style.css"><h1>外部</h1>'], 'external/index.html', { type: 'text/html' }),
      'external/index.html',
    )
    const css = await addTaskAttachment(
      taskId,
      new File(['body{margin:0}'], 'external/style.css', { type: 'text/css' }),
      'external/style.css',
    )

    const tools = createToolRegistry(ctx())
    const list = await tools.attachment({ action: 'list' })
    expect(list.success).toBe(true)
    expect((list.data as { count: number }).count).toBe(2)

    const read = await tools.attachment({ action: 'read', id: css.id })
    expect(read.success).toBe(true)
    expect((read.data as { content: string }).content).toContain('margin:0')

    const imported = await tools.attachment({ action: 'import_to_workspace' })
    expect(imported.success).toBe(true)
    const data = imported.data as { imported: string[]; htmlEntries: string[] }
    expect([...data.imported].sort()).toEqual(['/uploads/external/index.html', '/uploads/external/style.css'])
    expect(data.htmlEntries).toEqual(['/uploads/external/index.html'])
    expect((await getWorkspaceFile(taskId, '/uploads/external/style.css'))?.text).toContain('margin:0')
  })

  it('character_card 识别附件角色卡与未启用字段', async () => {
    const cardJson = JSON.stringify({
      spec: 'chara_card_v2',
      data: {
        name: '测试角色',
        description: '一个用于测试的角色',
        first_mes: '你好 {{user}}',
        extensions: { regex_scripts: [] },
        character_book: {
          entries: [{ keys: ['测试'], content: '测试世界书内容' }],
        },
      },
    })
    const attachment = await addTaskAttachment(
      taskId,
      new File([cardJson], 'card.json', { type: 'application/json' }),
    )
    expect(attachment.card?.name).toBe('测试角色')

    const tools = createToolRegistry(ctx())
    const list = await tools.character_card({ action: 'list' })
    expect((list.data as { count: number }).count).toBe(1)

    const read = await tools.character_card({ action: 'read', attachmentId: attachment.id })
    expect(read.success).toBe(true)
    const data = read.data as {
      summary: { name: string }
      fields: { name: string; firstMes: string; alternateGreetings: string[] }
      worldEntries: { content: string }[]
      regexScripts: unknown[]
      unsupported: string[]
    }
    expect(data.fields.name).toBe('测试角色')
    expect(data.fields.firstMes).toContain('{{user}}')
    expect(data.worldEntries[0].content).toContain('测试世界书内容')
    expect(data.regexScripts).toEqual([])
    expect(data.unsupported.join(' ')).not.toContain('regex_scripts')
    expect(data.unsupported.join(' ')).not.toContain('extensions')

    await addTaskAttachment(taskId, new File(['{"hello":"world"}'], 'plain.json', { type: 'application/json' }))
    const notCard = await tools.character_card({ action: 'list' })
    expect((notCard.data as { count: number }).count).toBe(1)
  })
})

describe('跨工作空间只读', () => {
  it('fs_read / fs_list 可以读别的空间，写仍然只落当前空间', async () => {
    const other = await createTask('参考作品')
    await writeWorkspaceText(other.id, '/index.html', '<h1>别人的页面</h1>')
    const own = await createTask('当前作品')
    await writeWorkspaceText(own.id, '/index.html', '<h1>我的页面</h1>')
    const tools = createToolRegistry(ctx(own.id))

    const read = await tools.fs_read({ path: '/index.html', workspace: other.id })
    expect(read.success).toBe(true)
    expect((read.data as { content: string }).content).toContain('别人的页面')

    const listed = await tools.fs_list({ workspace: '参考作品' })
    expect((listed.data as { workspaceTitle: string }).workspaceTitle).toBe('参考作品')

    // 写工具没有 workspace 参数，写入永远落在当前空间
    await tools.fs_write({ path: '/index.html', content: '<h1>改的是自己的</h1>' })
    expect((await getWorkspaceFile(other.id, '/index.html'))?.text).toContain('别人的页面')
    expect((await getWorkspaceFile(own.id, '/index.html'))?.text).toContain('改的是自己的')
  })

  it('找不到工作空间时给出可读错误', async () => {
    const own = await createTask('当前作品')
    const tools = createToolRegistry(ctx(own.id))
    const result = await tools.fs_read({ path: '/index.html', workspace: '不存在的空间' })
    expect(result.success).toBe(false)
    expect(result.error?.message).toContain('找不到工作空间')
  })
})
