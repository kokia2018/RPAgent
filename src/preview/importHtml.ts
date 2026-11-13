import { db } from '../db/db'
import { prepareTaskAttachment } from '../db/assets'
import { getTask, listWorkspaceFiles, updateTask, writeWorkspaceBinary, writeWorkspaceText } from '../db/repo'
import { isHtmlPath, normalizePath } from '../lib/path'
import { randomId } from '../lib/hash'
import { queueWorkspaceRun } from '../lib/runLock'

export const NEW_PREVIEW_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>新作品</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; }
main { min-height: 100dvh; padding: 24px; display: grid; place-content: center; }
</style>
</head>
<body><main><h1>新作品</h1><p>回到 Agent 对话，描述你想添加的内容和功能。</p></main></body>
</html>`

export async function createPreviewHtml(taskId: string, name: string, html: string): Promise<string> {
  let path = normalizePath(name)
  if (path === '/') throw new Error('请填写 HTML 文件名')
  if (!/\.[^/]+$/.test(path)) path += '.html'
  if (!isHtmlPath(path)) throw new Error('文件名必须以 .html 或 .htm 结尾')
  if (!html.trim()) throw new Error('HTML 内容不能为空')
  return queueWorkspaceRun(taskId, new AbortController().signal, () =>
    db.transaction('rw', db.tasks, db.workspaceFiles, async () => {
      if (!(await getTask(taskId))) throw new Error('工作空间已删除')
      const existing = await listWorkspaceFiles(taskId)
      if (existing.some(file => file.path.toLowerCase() === path.toLowerCase())) throw new Error('已有同名文件，请换一个文件名；不会覆盖已有作品')
      await writeWorkspaceText(taskId, path, html, 'user')
      await updateTask(taskId, { entryPath: path })
      return path
    }),
  )
}

export async function importPreviewHtml(taskId: string, files: readonly File[]): Promise<{ entryPath: string; paths: string[]; htmlEntries: string[] }> {
  if (!files.length) throw new Error('请选择要导入的文件')
  const attachments = await Promise.all(files.map(file => prepareTaskAttachment(taskId, file, file.webkitRelativePath || file.name)))
  const entries = attachments.filter(file => isHtmlPath(file.name))
  if (!entries.length) throw new Error('请至少选择一个 .html 或 .htm 文件；可同时选择配套脚本、样式和图片')
  const names = attachments.map(file => file.name.toLowerCase())
  if (new Set(names).size !== names.length) throw new Error('所选文件路径重名，请分开导入或使用不同文件名')
  const dir = `/uploads/${randomId('import_')}`
  const paths = attachments.map(file => normalizePath(`${dir}/${file.name}`))
  const htmlEntries = entries.map(file => normalizePath(`${dir}/${file.name}`))
  const entryPath = htmlEntries.find(path => /\/index\.html?$/i.test(path)) || htmlEntries[0]
  await queueWorkspaceRun(taskId, new AbortController().signal, () =>
    db.transaction('rw', db.tasks, db.workspaceFiles, db.attachments, async () => {
      if (!(await getTask(taskId))) throw new Error('工作空间已删除')
      await db.attachments.bulkAdd(attachments)
      for (const [i, file] of attachments.entries()) {
        if (typeof file.text === 'string') await writeWorkspaceText(taskId, paths[i], file.text, 'attachment')
        else if (file.blob) await writeWorkspaceBinary(taskId, paths[i], file.blob, 'attachment', file.hash)
        else throw new Error(`文件内容不可用：${file.name}`)
      }
      await updateTask(taskId, { entryPath })
    }),
  )
  return { entryPath, paths, htmlEntries }
}
