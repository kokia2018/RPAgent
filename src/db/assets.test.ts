import 'fake-indexeddb/auto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  addTaskAttachment,
  addTaskLibraryRef,
  copyLibraryFile,
  createLibraryFolder,
  deleteLibraryFile,
  deleteLibraryFolder,
  describeTaskLibraryRefs,
  folderPath,
  getLibraryFile,
  getSelectedLibraryFile,
  importAttachmentsToWorkspace,
  listLibraryFiles,
  listLibraryFolders,
  listTaskAttachments,
  moveLibraryFile,
  readAttachmentText,
  saveAttachmentToLibrary,
  saveLibraryNote,
  searchLibrary,
  selectedLibraryFiles,
  uploadLibraryFile,
} from './assets'
import { createTask, getWorkspaceFile, listWorkspaceFiles } from './repo'

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((t) => t.clear()))
})

afterAll(() => {
  db.close()
})

function file(content: string, name: string, type = ''): File {
  return new File([content], name, { type })
}

describe('常用资料库', () => {
  it('文件夹层级、路径与重名保护', async () => {
    const a = await createLibraryFolder('写作')
    const b = await createLibraryFolder('模板', a.id)
    expect(await folderPath(b.id)).toBe('写作 / 模板')
    await expect(createLibraryFolder('写作')).rejects.toThrow('同名')
    expect((await listLibraryFolders()).length).toBe(2)
  })

  it('文字资料保存、重名编号与正文搜索', async () => {
    const folder = await createLibraryFolder('经验')
    await saveLibraryNote('动效经验', '按钮点击使用 180ms 过渡', folder.id)
    const second = await saveLibraryNote('动效经验', '第二份', folder.id)
    expect(second.name).toBe('动效经验 (2).md')
    const hits = await searchLibrary('180ms')
    expect(hits).toHaveLength(1)
    expect(hits[0].name).toBe('动效经验.md')
  })

  it('上传文本与二进制资料，解析状态正确', async () => {
    const md = await uploadLibraryFile(file('# 标题', 'guide.md', 'text/markdown'))
    expect(md.parseStatus).toBe('readable')
    expect(md.text).toContain('# 标题')

    const png = await uploadLibraryFile(file('\x89PNG', 'pic.png', 'image/png'))
    expect(png.parseStatus).toBe('image')
    expect(png.blob).toBeDefined()

    const pdf = await uploadLibraryFile(file('%PDF-1.4', 'doc.pdf', 'application/pdf'))
    expect(pdf.parseStatus).toBe('unsupported')
    expect(pdf.parseNote).toContain('PDF')
  })

  it('移动、复制与递归删除', async () => {
    const root = await createLibraryFolder('根')
    const sub = await createLibraryFolder('子', root.id)
    const note = await saveLibraryNote('说明', '内容')
    await moveLibraryFile(note.id, sub.id)
    const moved = await getLibraryFile(note.id)
    expect(moved?.folderId).toBe(sub.id)

    const copy = await copyLibraryFile(note.id)
    expect(copy.id).not.toBe(note.id)
    expect(copy.name).toContain('副本')

    const result = await deleteLibraryFolder(root.id)
    expect(result.folders).toBe(2)
    expect(result.files).toBe(2)
    expect(await listLibraryFiles()).toHaveLength(0)
  })
})

describe('任务资料引用', () => {
  it('文件夹引用只允许读取已选文件', async () => {
    const task = await createTask('引用任务')
    const folder = await createLibraryFolder('参考')
    const selected = await saveLibraryNote('已选', 'SELECTED-CONTENT', folder.id)
    const other = await saveLibraryNote('未选', 'SECRET-CONTENT')

    const ref = await addTaskLibraryRef(task.id, 'folder', folder.id)
    expect(ref.files).toHaveLength(1)
    const allowed = await selectedLibraryFiles(task.id)
    expect(allowed.map((f) => f.id)).toEqual([selected.id])
    await expect(getSelectedLibraryFile(task.id, other.id)).rejects.toThrow('不在当前任务已选范围')
    expect((await getSelectedLibraryFile(task.id, selected.id)).text).toContain('SELECTED-CONTENT')
  })

  it('资料删除后引用保留并标记缺失', async () => {
    const task = await createTask('缺失引用')
    const note = await saveLibraryNote('会被删', 'x')
    await addTaskLibraryRef(task.id, 'file', note.id)
    await deleteLibraryFile(note.id)
    const views = await describeTaskLibraryRefs(task.id)
    expect(views).toHaveLength(1)
    expect(views[0].missingFiles).toHaveLength(1)
    expect(views[0].currentFiles).toBe(0)
  })

  it('资料变更后引用显示 changed', async () => {
    const task = await createTask('变更引用')
    const folder = await createLibraryFolder('变更')
    const note = await saveLibraryNote('a', 'v1', folder.id)
    await addTaskLibraryRef(task.id, 'folder', folder.id)
    await db.libraryFiles.update(note.id, { text: 'v2', hash: 'changed' })
    const views = await describeTaskLibraryRefs(task.id)
    expect(views[0].changedFiles).toHaveLength(1)
  })
})

describe('任务附件', () => {
  it('解析状态与任务隔离', async () => {
    const a = await createTask('附件 A')
    const b = await createTask('附件 B')
    await addTaskAttachment(a.id, file('<html><body>hi</body></html>', 'index.html', 'text/html'))
    await addTaskAttachment(a.id, file('%PDF-1.4', 'spec.pdf', 'application/pdf'))
    await addTaskAttachment(b.id, file('# B', 'note.md', 'text/markdown'))

    const listA = await listTaskAttachments(a.id)
    expect(listA.map((x) => x.parseStatus).sort()).toEqual(['runnable', 'unsupported'])
    expect((await listTaskAttachments(b.id)).map((x) => x.name)).toEqual(['note.md'])
  })

  it('多文件导入工作区保留相对目录与入口', async () => {
    const task = await createTask('导入任务')
    const html = await addTaskAttachment(
      task.id,
      file('<link rel="stylesheet" href="style.css"><h1 id="t">Hi</h1>', 'site/index.html', 'text/html'),
      'site/index.html',
    )
    await addTaskAttachment(task.id, file('body{color:red}', 'site/style.css', 'text/css'), 'site/style.css')

    const result = await importAttachmentsToWorkspace(task.id)
    expect([...result.imported].sort()).toEqual(['/uploads/site/index.html', '/uploads/site/style.css'])
    expect(result.htmlEntries).toEqual(['/uploads/site/index.html'])
    const wsHtml = await getWorkspaceFile(task.id, '/uploads/site/index.html')
    expect(wsHtml?.text).toContain('style.css')
    expect(wsHtml?.source).toBe('attachment')

    // 源附件保留
    const original = await listTaskAttachments(task.id)
    expect(original.length).toBe(2)
    const htmlAttachment = original.find((a) => a.name === 'site/index.html')
    expect(await readAttachmentText(htmlAttachment!)).toContain('style.css')
    expect(html.name).toBe('site/index.html')
    expect((await listWorkspaceFiles(task.id)).map((f) => f.path).sort()).toEqual([
      '/uploads/site/index.html',
      '/uploads/site/style.css',
    ])
  })

  it('导入指定附件与保存到常用资料', async () => {
    const task = await createTask('单附件')
    const png = await addTaskAttachment(task.id, file('\x89PNG', 'logo.png', 'image/png'))
    const note = await addTaskAttachment(task.id, file('# 说明', 'readme.md', 'text/markdown'))
    const result = await importAttachmentsToWorkspace(task.id, [png.id], '/assets')
    expect(result.imported).toEqual(['/assets/logo.png'])
    expect((await getWorkspaceFile(task.id, '/assets/logo.png'))?.blob).toBeDefined()

    const folder = await createLibraryFolder('素材')
    const saved = await saveAttachmentToLibrary(note, folder.id)
    expect(saved.name).toBe('readme.md')
    expect(saved.text).toContain('# 说明')
    expect((await listLibraryFiles(folder.id)).length).toBe(1)
  })
})
