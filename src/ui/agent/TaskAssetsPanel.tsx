import { useMemo, useRef, useState } from 'react'
import type { Attachment, LibraryFile, LibraryFolder, TaskLibraryRefView } from '../../db/types'
import {
  addTaskAttachment,
  attachmentWorkspacePath,
  addTaskLibraryRef,
  deleteTaskAttachment,
  describeTaskLibraryRefs,
  importAttachmentsToWorkspace,
  listLibraryFiles,
  listLibraryFolders,
  listTaskAttachments,
  removeTaskLibraryRef,
  saveAttachmentToLibrary,
} from '../../db/assets'
import { createCharacterPage } from '../../character/page'
import { updateTask } from '../../db/repo'
import { queueWorkspaceRun } from '../../lib/runLock'
import { useLiveQueryValue } from '../hooks'
import { useToast } from '../toast'
import { Icon } from '../icons'
import { Modal } from '../Modal'
import { byteSize } from '../../lib/text'
import { profileForFile, profileStatusText } from '../../lib/documents'
import type { DocRef } from '../docs/DocViewer'
import type { CharacterCardTarget } from '../character/CharacterChatModal'

function folderPathOf(folderId: string, folders: LibraryFolder[]): string {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const names: string[] = []
  let cur = byId.get(folderId)
  let guard = 0
  while (cur && guard++ < 64) {
    names.unshift(cur.name)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return names.join(' / ')
}

function attachmentHandoff(a: Attachment): string {
  if (a.card) return `请用 character_card({action:"read", attachmentId:"${a.id}"}) 读取角色卡「${a.name}」，检查未支持的世界书、正则和界面，然后将需要的行为适配到当前工作区的 HTML 试玩页。不要执行卡内脚本或改写原件；先说明兼容差异，不要承诺等价还原。`
  if (a.parseStatus === 'unsupported' || a.parseStatus === 'binary') {
    return `我已上传附件「${a.name}」（id=${a.id}，${a.mime}）。工作台阅读器无法解析它；请先用 attachment({action:"read"}) 确认可读取性，再如实说明限制和可行的处理方案，不要伪造解析结果。`
  }
  if (a.parseStatus === 'image') {
    return `我已上传图片附件「${a.name}」（id=${a.id}）。如果需要作为素材使用，请先 attachment({action:"import_to_workspace"}) 导入工作区，再在页面中引用。`
  }
  if (a.parseStatus === 'runnable') {
    return `我已上传 HTML 附件「${a.name}」（id=${a.id}）。请用 attachment({action:"import_to_workspace"}) 导入工作区，保持相对资源关系，然后 build_project 并 preview 打开，读取真实运行结果再修复。`
  }
  return `请阅读附件「${a.name}」（id=${a.id}，${a.mime}）。用 attachment({action:"read"}) 查看内容，再根据我的需求处理；原始附件不要覆盖。`
}

export function TaskAssetsPanel({
  taskId,
  open,
  onClose,
  onOpenDoc,
  onRequestRun,
  onOpenCard,
  onSendToAgent,
}: {
  taskId: string
  open: boolean
  onClose: () => void
  onOpenDoc: (doc: DocRef) => void
  onRequestRun: (path: string) => void
  onOpenCard: (target: CharacterCardTarget) => void
  onSendToAgent: (text: string) => void
}) {
  const { toast } = useToast()
  const attachments = useLiveQueryValue(() => listTaskAttachments(taskId), [taskId], [])
  const refs = useLiveQueryValue(() => describeTaskLibraryRefs(taskId), [taskId], [])
  const folders = useLiveQueryValue(() => listLibraryFolders(), [], [])
  const libraryFiles = useLiveQueryValue(() => listLibraryFiles(), [], [])

  const [tab, setTab] = useState<'attachments' | 'library'>('attachments')
  const [uploading, setUploading] = useState(false)
  const [busyId, setBusyId] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerSel, setPickerSel] = useState<Set<string>>(new Set())
  const [saveTarget, setSaveTarget] = useState<Attachment | null>(null)
  const [saveFolderId, setSaveFolderId] = useState('')

  const existingRefs = useMemo(() => {
    const set = new Set<string>()
    for (const ref of refs) set.add(`${ref.targetType}:${ref.targetId}`)
    return set
  }, [refs])

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length || uploading) return
    setUploading(true)
    try {
      let ok = 0
      const added: Attachment[] = []
      const warnings: string[] = []
      for (const file of list.slice(0, 40)) {
        try {
          const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
          added.push(await addTaskAttachment(taskId, file, relative))
          ok++
        } catch (e) {
          warnings.push(`${file.name}: ${String((e as Error)?.message || e)}`)
        }
      }
      if (list.length > 40) warnings.push('一次最多上传 40 个文件，其余已跳过')
      toast(ok ? `已上传 ${ok} 个附件` : '上传失败', ok ? 'success' : 'error')
      if (warnings.length) toast(warnings[0], 'warning')
      const entries = added.filter((a) => a.parseStatus === 'runnable')
      if (entries.length === 1) await importAndRun(entries[0], added.map((a) => a.id))
      else if (entries.length > 1) toast('发现多个网页，请在附件中选择要打开的入口。', 'info')
      if (added.some((a) => a.card)) toast('已识别角色卡。点击「生成角色试玩页」即可在本地组装，不消耗模型。', 'info')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
      if (folderInputRef.current) folderInputRef.current.value = ''
    }
  }

  const importAndRun = async (attachment: Attachment, ids?: string[]) => {
    setBusyId(attachment.id)
    try {
      const result = await queueWorkspaceRun(taskId, new AbortController().signal, () => importAttachmentsToWorkspace(taskId, ids))
      const entry = attachmentWorkspacePath(attachment.name)
      await updateTask(taskId, { entryPath: entry })
      toast(result.kept.length ? '已打开工作副本，你的修改保持不变。' : `已导入 ${result.imported.length} 个文件`, 'success')
      onRequestRun(entry)
      onClose()
    } catch (e) {
      toast('打开失败：' + String((e as Error)?.message || e), 'error')
    } finally {
      setBusyId('')
    }
  }

  const generateCard = async (attachment: Attachment) => {
    if (busyId) return
    setBusyId(attachment.id)
    try {
      const result = await createCharacterPage(taskId, attachment.id)
      toast('已生成基础角色试玩页，兼容差异可在页面「玩法与兼容说明」中查看。', 'success')
      onRequestRun(result.path)
      onClose()
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error')
    } finally {
      setBusyId('')
    }
  }

  const importOnly = async (attachment: Attachment) => {
    setBusyId(attachment.id)
    try {
      const result = await queueWorkspaceRun(taskId, new AbortController().signal, () => importAttachmentsToWorkspace(taskId, [attachment.id]))
      toast(result.kept.length ? '已保留现有工作副本。' : `已导入工作区：${result.imported[0] || attachment.name}`, 'success')
    } catch (e) {
      toast('导入失败：' + String((e as Error)?.message || e), 'error')
    } finally {
      setBusyId('')
    }
  }

  const confirmSaveToLibrary = async () => {
    if (!saveTarget) return
    try {
      await saveAttachmentToLibrary(saveTarget, saveFolderId)
      toast('已保存到常用资料', 'success')
      setSaveTarget(null)
      setSaveFolderId('')
    } catch (e) {
      toast('保存失败：' + String((e as Error)?.message || e), 'error')
    }
  }

  const togglePick = (key: string) => {
    setPickerSel((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const confirmPicker = async () => {
    if (!pickerSel.size) {
      setPickerOpen(false)
      return
    }
    let added = 0
    const failures: string[] = []
    for (const key of pickerSel) {
      const [type, id] = key.split(':')
      try {
        await addTaskLibraryRef(taskId, type === 'folder' ? 'folder' : 'file', id)
        added++
      } catch (e) {
        failures.push(String((e as Error)?.message || e))
      }
    }
    setPickerOpen(false)
    setPickerSel(new Set())
    if (added) toast(`已引用 ${added} 项资料`, 'success')
    if (failures.length) toast(failures[0], 'warning')
  }

  const pickerFolders = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase()
    return folders
      .map((f) => ({ ...f, path: folderPathOf(f.id, folders) }))
      .filter((f) => !q || `${f.path} ${f.name}`.toLowerCase().includes(q))
  }, [folders, pickerQuery])

  const pickerFiles = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase()
    return libraryFiles
      .map((f) => ({ ...f, path: folderPathOf(f.folderId, folders) }))
      .filter((f) => !q || `${f.path} ${f.name}`.toLowerCase().includes(q))
  }, [libraryFiles, folders, pickerQuery])

  if (!open) return null

  const renderRef = (ref: TaskLibraryRefView) => {
    const location = [ref.folderPath, ref.name].filter(Boolean).join(' / ')
    return (
      <div className="asset-item" key={ref.id}>
        <div className="asset-main">
          <Icon name={ref.targetType === 'folder' ? 'folder' : 'file'} size={15} />
          <div className="asset-text">
            <span className="asset-name">{location}</span>
            <span className="asset-meta">
              {ref.targetType === 'folder' ? '文件夹' : '文件'} · 当前 {ref.currentFiles} 个文件
              {ref.missingFiles.length ? ` · 已删除 ${ref.missingFiles.length}` : ''}
              {ref.changedFiles.length ? ` · 已变更 ${ref.changedFiles.length}` : ''}
              {ref.addedFiles ? ` · 新增 ${ref.addedFiles}` : ''}
            </span>
            {ref.files.length ? (
              <div className="asset-files">
                {ref.files
                  .filter((f) => !ref.missingFiles.some((m) => m.fileId === f.fileId))
                  .slice(0, 4)
                  .map((f) => (
                    <button
                      key={f.fileId}
                      className="chip chip-small"
                      title={`阅读 ${f.name}`}
                      onClick={() => onOpenDoc({ source: 'library', id: f.fileId, name: f.name, mime: f.mime })}
                    >
                      {f.name}
                    </button>
                  ))}
                {ref.files.length > 4 ? <span className="asset-sub">等 {ref.files.length} 个</span> : null}
              </div>
            ) : (
              <span className="asset-sub muted">建立引用时文件夹里没有文件</span>
            )}
          </div>
        </div>
        <div className="asset-actions">
          <button
            className="icon-btn"
            title="移除引用（不会删除源资料）"
            onClick={async () => {
              await removeTaskLibraryRef(ref.id)
              toast('已移除引用', 'info')
            }}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <aside className="assets-panel">
        <div className="file-panel-head">
          <div>
            <strong>任务资料</strong>
            <span className="file-count">附件与常用资料只属于当前任务</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="收起任务资料">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="assets-tabs">
          <button className={tab === 'attachments' ? 'is-on' : ''} onClick={() => setTab('attachments')}>
            附件 {attachments.length}
          </button>
          <button className={tab === 'library' ? 'is-on' : ''} onClick={() => setTab('library')}>
            常用资料 {refs.length}
          </button>
        </div>

        {tab === 'attachments' ? (
          <div className="assets-body">
            <div className="asset-upload">
              <button className="btn btn-small btn-primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                <Icon name="plus" size={13} /> {uploading ? '上传中…' : '上传文件'}
              </button>
              <button className="btn btn-small" onClick={() => folderInputRef.current?.click()} disabled={uploading}>
                <Icon name="folder" size={13} /> 上传文件夹
              </button>
              <p className="asset-hint">
                上传 HTML 后可直接试玩；多文件请一起上传或选择目录。角色卡可本地生成基础网页。PDF/Word
                不做正文提取，交给 Agent 前会说明限制。
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden-input"
                onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
              />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                className="hidden-input"
                onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
                {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              />
            </div>

            {attachments.length ? (
              attachments.map((a) => {
                const profile = profileForFile(a.name, a.mime)
                return (
                  <div className="asset-item" key={a.id}>
                    <div className="asset-main">
                      <Icon
                        name={
                          profile.kind === 'html'
                            ? 'preview'
                            : profile.kind === 'image'
                              ? 'file'
                              : profile.kind === 'markdown'
                                ? 'book'
                                : 'file'
                        }
                        size={15}
                      />
                      <div className="asset-text">
                        <span className="asset-name" title={a.name}>
                          {a.name}
                        </span>
                        <span className="asset-meta">
                          {profileStatusText(a.parseStatus)} · {byteSize(a.size)} · {a.mime || '未知类型'}
                        </span>
                        {a.card ? (
                          <span className="asset-sub">
                            角色卡「{a.card.name}」· {a.card.spec}
                            {a.card.worldEntries ? ` · ${a.card.worldEntries} 条世界书` : ''}
                            {a.card.unsupported.length ? ` · 部分兼容（${a.card.unsupported.length} 项提示）` : ''}
                          </span>
                        ) : null}
                        {a.card ? <details className="asset-sub"><summary>兼容范围（不是原样还原）</summary>
                          <p>基础页支持开场、近期对话、本地续玩与有限世界书；不执行原卡脚本、正则及自定义 UI。</p>
                          {a.card.unsupported.map((text, i) => <p key={i}>{text}</p>)}
                        </details> : null}
                        {a.parseStatus === 'unsupported' || a.parseStatus === 'binary' ? (
                          <span className="asset-sub muted">{a.parseNote || '暂不支持解析'}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="asset-actions">
                      {a.card ? (
                        <button
                          className="chip chip-small is-on"
                          onClick={() => void generateCard(a)}
                          disabled={Boolean(busyId)}
                          title="本地生成可编辑、可导出的基础网页，不调用模型"
                        >
                          <Icon name="preview" size={11} /> {busyId === a.id ? '生成中…' : '生成角色试玩页'}
                        </button>
                      ) : null}
                      {profile.readable ? (
                        <button
                          className="chip chip-small"
                          onClick={() =>
                            onOpenDoc({ source: 'attachment', taskId, id: a.id, name: a.name, mime: a.mime })
                          }
                          title="在试玩区阅读"
                        >
                          阅读
                        </button>
                      ) : null}
                      {profile.runnable ? (
                        <button
                          className="chip chip-small"
                          onClick={() => void importAndRun(a)}
                          disabled={busyId === a.id}
                        >
                          {busyId === a.id ? '打开中…' : '打开试玩'}
                        </button>
                      ) : (
                        <button
                          className="chip chip-small"
                          onClick={() => void importOnly(a)}
                          disabled={busyId === a.id}
                          title="复制到工作区，原附件不变"
                        >
                          导入工作区
                        </button>
                      )}
                      <button className="chip chip-small" onClick={() => setSaveTarget(a)} title="保存到常用资料">
                        存到资料
                      </button>
                      <button className="chip chip-small" onClick={() => {
                        if (window.confirm('将附件交给 Agent 后，发送对话时可能将附件内容发送到你配置的模型端点。现在只填入适配请求，是否继续？')) {
                          onSendToAgent(attachmentHandoff(a))
                          onClose()
                        }
                      }}>
                        {a.card ? '交给 Agent 适配' : '交给 Agent'}
                      </button>
                      <button
                        className="icon-btn"
                        title="删除附件"
                        onClick={async () => {
                          await deleteTaskAttachment(a.id)
                          toast('附件已删除', 'info')
                        }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </div>
                )
              })
            ) : (
              <p className="empty-hint">还没有附件。上传 HTML、Markdown、图片或待处理文档。</p>
            )}
          </div>
        ) : (
          <div className="assets-body">
            <div className="asset-upload">
              <button className="btn btn-small btn-primary" onClick={() => setPickerOpen(true)}>
                <Icon name="plus" size={13} /> 选择参考资料
              </button>
              <p className="asset-hint">引用常用资料后，Agent 才能按需读取；未选资料不会进入模型上下文，也不会被全文塞入请求。</p>
            </div>
            {refs.length ? refs.map(renderRef) : <p className="empty-hint">还没有引用常用资料。可先在顶栏「常用资料」里整理文件夹和文件。</p>}
          </div>
        )}
      </aside>

      <Modal
        open={pickerOpen}
        title="选择参考资料"
        subtitle="勾选文件夹会引用整个文件夹；Agent 只能读取已勾选的内容"
        onClose={() => setPickerOpen(false)}
        wide
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setPickerOpen(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void confirmPicker()} disabled={!pickerSel.size}>
              引用所选（{pickerSel.size}）
            </button>
          </div>
        }
      >
        <input
          className="input"
          placeholder="按名称或路径筛选资料…"
          value={pickerQuery}
          onChange={(e) => setPickerQuery(e.target.value)}
        />
        <div className="picker-list">
          {pickerFolders.map((folder) => {
            const key = `folder:${folder.id}`
            const existing = existingRefs.has(key)
            return (
              <label className={`picker-row ${existing ? 'is-disabled' : ''}`} key={key}>
                <input
                  type="checkbox"
                  checked={existing || pickerSel.has(key)}
                  disabled={existing}
                  onChange={() => togglePick(key)}
                />
                <Icon name="folder" size={14} />
                <span className="picker-name">{folder.path || folder.name}</span>
                <span className="picker-meta">{existing ? '已引用' : '整个文件夹'}</span>
              </label>
            )
          })}
          {pickerFiles.map((file) => {
            const key = `file:${file.id}`
            const existing = existingRefs.has(key)
            return (
              <label className={`picker-row ${existing ? 'is-disabled' : ''}`} key={key}>
                <input
                  type="checkbox"
                  checked={existing || pickerSel.has(key)}
                  disabled={existing}
                  onChange={() => togglePick(key)}
                />
                <Icon name="file" size={14} />
                <span className="picker-name">{file.path ? `${file.path} / ${file.name}` : file.name}</span>
                <span className="picker-meta">{existing ? '已引用' : byteSize(file.size)}</span>
              </label>
            )
          })}
          {!pickerFolders.length && !pickerFiles.length ? (
            <p className="empty-hint">资料库还是空的。先在顶栏「常用资料」里新建资料。</p>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={Boolean(saveTarget)}
        title="保存到常用资料"
        subtitle={saveTarget ? saveTarget.name : ''}
        onClose={() => setSaveTarget(null)}
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setSaveTarget(null)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void confirmSaveToLibrary()}>
              保存副本
            </button>
          </div>
        }
      >
        <p className="modal-note">附件不会被移动或删除，这里只创建一个副本。</p>
        <select className="select" value={saveFolderId} onChange={(e) => setSaveFolderId(e.target.value)}>
          <option value="">根目录</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {folderPathOf(f.id, folders)}
            </option>
          ))}
        </select>
      </Modal>
    </>
  )
}
