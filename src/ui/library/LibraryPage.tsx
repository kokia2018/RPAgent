import { useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryFile, LibraryFolder } from '../../db/types'
import {
  addTaskLibraryRef,
  copyLibraryFile,
  createLibraryFolder,
  deleteLibraryFile,
  deleteLibraryFolder,
  descendantFolderIds,
  getLibraryFile,
  listLibraryFiles,
  listLibraryFolders,
  moveLibraryFile,
  removeTaskLibraryRef,
  renameLibraryFile,
  renameLibraryFolder,
  saveLibraryNote,
  searchLibrary,
  uploadLibraryFile,
  type LibrarySearchHit,
} from '../../db/assets'
import { useLiveQueryValue } from '../hooks'
import { useToast } from '../toast'
import { Icon } from '../icons'
import { Modal } from '../Modal'
import { DocViewer } from '../docs/DocViewer'
import { byteSize, formatTime } from '../../lib/text'
import { profileForFile, profileStatusText } from '../../lib/documents'
import type { DocRef } from '../docs/DocViewer'

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

export function LibraryPage({
  taskId,
  onBack,
  onSendToAgent,
}: {
  taskId?: string
  onBack: () => void
  onSendToAgent?: (text: string) => void
}) {
  const { toast } = useToast()
  const folders = useLiveQueryValue(() => listLibraryFolders(), [], [])
  const files = useLiveQueryValue(() => listLibraryFiles(), [], [])
  const [selectedFolderId, setSelectedFolderId] = useState('')
  const [query, setQuery] = useState('')
  const [searchHits, setSearchHits] = useState<LibrarySearchHit[] | null>(null)
  const [docFile, setDocFile] = useState<LibraryFile | null>(null)
  const [uploading, setUploading] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)

  const [folderModal, setFolderModal] = useState<{ mode: 'create' | 'rename'; id?: string; name: string } | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteName, setNoteName] = useState('')
  const [noteText, setNoteText] = useState('')
  const [renameFile, setRenameFile] = useState<{ id: string; name: string } | null>(null)
  const [moveFile, setMoveFile] = useState<{ id: string; name: string; folderId: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<
    { type: 'folder' | 'file'; id: string; name: string; fileCount?: number } | null
  >(null)

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setSearchHits(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      searchLibrary(q)
        .then((hits) => {
          if (!cancelled) setSearchHits(hits)
        })
        .catch(() => {
          if (!cancelled) setSearchHits([])
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query])

  const selectedFolder = folders.find((f) => f.id === selectedFolderId) || null
  const selectedPath = selectedFolderId ? folderPathOf(selectedFolderId, folders) : ''

  const visibleFiles = useMemo(() => {
    let list = files
    if (selectedFolderId) {
      const ids = descendantFolderIds(selectedFolderId, folders)
      list = files.filter((f) => ids.has(f.folderId))
    }
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [files, folders, selectedFolderId])

  const childFolders = useMemo(
    () => folders.filter((f) => f.parentId === selectedFolderId).sort((a, b) => a.name.localeCompare(b.name)),
    [folders, selectedFolderId],
  )

  const fileCountInFolder = (folderId: string): number => {
    const ids = descendantFolderIds(folderId, folders)
    return files.filter((f) => ids.has(f.folderId)).length
  }

  const submitFolder = async () => {
    if (!folderModal) return
    try {
      if (folderModal.mode === 'create') {
        const folder = await createLibraryFolder(folderModal.name, selectedFolderId)
        setSelectedFolderId(folder.id)
        toast('已创建文件夹', 'success')
      } else if (folderModal.id) {
        await renameLibraryFolder(folderModal.id, folderModal.name)
        toast('已重命名', 'success')
      }
      setFolderModal(null)
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error')
    }
  }

  const submitNote = async () => {
    if (!noteText.trim()) {
      toast('文字内容不能为空', 'warning')
      return
    }
    try {
      await saveLibraryNote(noteName, noteText, selectedFolderId)
      setNoteOpen(false)
      setNoteName('')
      setNoteText('')
      toast('已保存文字资料', 'success')
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error')
    }
  }

  const uploadFiles = async (fileList: FileList | File[]) => {
    const list = Array.from(fileList)
    if (!list.length) return
    setUploading(true)
    try {
      for (const file of list.slice(0, 40)) {
        await uploadLibraryFile(file, selectedFolderId)
      }
      toast(`已上传 ${Math.min(40, list.length)} 个文件`, 'success')
    } catch (e) {
      toast('上传失败：' + String((e as Error)?.message || e), 'error')
    } finally {
      setUploading(false)
      if (uploadRef.current) uploadRef.current.value = ''
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    try {
      if (pendingDelete.type === 'folder') {
        const result = await deleteLibraryFolder(pendingDelete.id)
        if (selectedFolderId === pendingDelete.id) setSelectedFolderId('')
        toast(`已删除 ${result.folders} 个文件夹、${result.files} 个文件`, 'info')
      } else {
        await deleteLibraryFile(pendingDelete.id)
        toast('资料已删除', 'info')
      }
      setPendingDelete(null)
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error')
    }
  }

  const referenceFile = async (file: LibraryFile) => {
    if (!taskId) return
    try {
      await addTaskLibraryRef(taskId, 'file', file.id)
      toast('已引用到当前任务', 'success')
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error')
    }
  }

  const referenceFolder = async () => {
    if (!taskId || !selectedFolder) return
    try {
      await addTaskLibraryRef(taskId, 'folder', selectedFolder.id)
      toast('已把整个文件夹引用到当前任务', 'success')
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error')
    }
  }

  const removeRef = async (id: string) => {
    try {
      await removeTaskLibraryRef(id)
      toast('已移除引用', 'info')
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error')
    }
  }

  const openSearchHit = async (hit: LibrarySearchHit) => {
    if (!hit.matches.length) {
      const file = await getLibraryFile(hit.fileId)
      if (file) setDocFile(file)
      return
    }
    const file = await getLibraryFile(hit.fileId)
    if (file) setDocFile(file)
  }

  const renderFolderTree = (parentId: string, depth: number): React.ReactNode =>
    folders
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder) => (
        <div key={folder.id}>
          <button
            className={`library-folder-row ${selectedFolderId === folder.id ? 'is-active' : ''}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => setSelectedFolderId(folder.id)}
          >
            <Icon name="folder" size={14} />
            <span className="library-folder-name">{folder.name}</span>
            <span className="library-folder-count">{fileCountInFolder(folder.id)}</span>
          </button>
          {renderFolderTree(folder.id, depth + 1)}
        </div>
      ))

  const docRef: DocRef | null = docFile
    ? { source: 'library', id: docFile.id, name: docFile.name, mime: docFile.mime }
    : null

  return (
    <div className="library-page">
      <header className="library-head">
        <div>
          <h1>常用资料</h1>
          <p>长期复用的说明、模板、示例和素材。资料库只读，任务里使用时先复制到工作区。</p>
        </div>
        <div className="library-head-actions">
          <button className="btn btn-small" onClick={() => setFolderModal({ mode: 'create', name: '' })}>
            <Icon name="folder" size={13} /> 新建文件夹
          </button>
          <button className="btn btn-small" onClick={() => uploadRef.current?.click()} disabled={uploading}>
            <Icon name="plus" size={13} /> {uploading ? '上传中…' : '上传文件'}
          </button>
          <button className="btn btn-small" onClick={() => setNoteOpen(true)}>
            <Icon name="edit" size={13} /> 写文字资料
          </button>
          <button className="btn btn-small btn-ghost" onClick={onBack}>
            <Icon name="agent" size={13} /> 返回工作台
          </button>
          <input
            ref={uploadRef}
            type="file"
            multiple
            className="hidden-input"
            onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
          />
        </div>
      </header>

      <div className="library-body">
        <aside className="library-tree">
          <button
            className={`library-folder-row ${selectedFolderId === '' ? 'is-active' : ''}`}
            style={{ paddingLeft: 10 }}
            onClick={() => setSelectedFolderId('')}
          >
            <Icon name="book" size={14} />
            <span className="library-folder-name">全部资料</span>
            <span className="library-folder-count">{files.length}</span>
          </button>
          {renderFolderTree('', 0)}
          {!folders.length ? <p className="empty-hint">还没有文件夹。新建一个来整理资料。</p> : null}
        </aside>

        <main className="library-main">
          <div className="library-toolbar">
            <div className="library-crumb">
              <Icon name="folder" size={14} />
              <span>{selectedPath || '全部资料'}</span>
              {selectedFolder ? (
                <>
                  <button className="chip chip-small" onClick={() => void referenceFolder()} disabled={!taskId}>
                    引用整个文件夹
                  </button>
                  <button
                    className="chip chip-small"
                    onClick={() => setFolderModal({ mode: 'rename', id: selectedFolder.id, name: selectedFolder.name })}
                  >
                    重命名
                  </button>
                  <button
                    className="chip chip-small"
                    onClick={() =>
                      setPendingDelete({
                        type: 'folder',
                        id: selectedFolder.id,
                        name: selectedFolder.name,
                        fileCount: fileCountInFolder(selectedFolder.id),
                      })
                    }
                  >
                    删除
                  </button>
                </>
              ) : null}
            </div>
            <input
              className="input library-search"
              placeholder="搜索名称或正文内容…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {searchHits ? (
            <div className="library-list">
              <div className="library-list-head">
                <span>搜索结果</span>
                <span>{searchHits.length} 项</span>
              </div>
              {searchHits.length ? (
                searchHits.map((hit) => (
                  <button
                    key={hit.fileId}
                    className="library-file-row library-search-row"
                    onClick={() => void openSearchHit(hit)}
                  >
                    <div className="library-file-main">
                      <span className="library-file-name">{hit.name}</span>
                      <span className="library-file-meta">{hit.path}</span>
                      {hit.matches.slice(0, 2).map((m) => (
                        <span className="library-search-line" key={m.line}>
                          第 {m.line} 行：{m.text}
                        </span>
                      ))}
                    </div>
                    <Icon name="chevron" size={13} />
                  </button>
                ))
              ) : (
                <p className="empty-hint">没有匹配的资料。搜索覆盖文件名与文本正文。</p>
              )}
            </div>
          ) : (
            <div className="library-list">
              <div className="library-list-head">
                <span>资料文件</span>
                <span>{visibleFiles.length} 个</span>
              </div>
              {childFolders.length && !selectedFolderId ? (
                <div className="library-child-folders">
                  {childFolders.map((folder) => (
                    <button key={folder.id} className="library-folder-chip" onClick={() => setSelectedFolderId(folder.id)}>
                      <Icon name="folder" size={13} /> {folder.name}
                      <span className="library-folder-count">{fileCountInFolder(folder.id)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {visibleFiles.length ? (
                visibleFiles.map((file) => {
                  const profile = profileForFile(file.name, file.mime)
                  return (
                    <div className="library-file-row" key={file.id}>
                      <div className="library-file-main">
                        <span className="library-file-name">{file.name}</span>
                        <span className="library-file-meta">
                          {selectedFolderId ? '' : `${folderPathOf(file.folderId, folders) || '根目录'} · `}
                          {profileStatusText(file.parseStatus)} · {byteSize(file.size)} · {formatTime(file.updatedAt)}
                        </span>
                      </div>
                      <div className="library-file-actions">
                        {profile.readable ? (
                          <button className="chip chip-small" onClick={() => setDocFile(file)}>
                            阅读
                          </button>
                        ) : null}
                        <button
                          className="chip chip-small"
                          onClick={() => void referenceFile(file)}
                          disabled={!taskId}
                          title={taskId ? '引用到当前任务' : '先创建或打开一个任务'}
                        >
                          引用到任务
                        </button>
                        <button
                          className="chip chip-small"
                          onClick={async () => {
                            await copyLibraryFile(file.id, file.folderId)
                            toast('已创建副本', 'success')
                          }}
                        >
                          复制
                        </button>
                        <button
                          className="chip chip-small"
                          onClick={() => setMoveFile({ id: file.id, name: file.name, folderId: file.folderId })}
                        >
                          移动
                        </button>
                        <button
                          className="chip chip-small"
                          onClick={() => setRenameFile({ id: file.id, name: file.name })}
                        >
                          重命名
                        </button>
                        <button
                          className="icon-btn"
                          title="删除"
                          onClick={() => setPendingDelete({ type: 'file', id: file.id, name: file.name })}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </div>
                  )
                })
              ) : (
                <p className="empty-hint">
                  这个位置还没有资料。上传文件或写一段文字资料；也可以在任务资料面板里从附件保存过来。
                </p>
              )}
            </div>
          )}
        </main>
      </div>

      <Modal
        open={Boolean(folderModal)}
        title={folderModal?.mode === 'rename' ? '重命名文件夹' : '新建文件夹'}
        subtitle={selectedPath || '根目录'}
        onClose={() => setFolderModal(null)}
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setFolderModal(null)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void submitFolder()}>
              保存
            </button>
          </div>
        }
      >
        <input
          className="input"
          autoFocus
          placeholder="文件夹名称"
          value={folderModal?.name || ''}
          onChange={(e) => setFolderModal((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitFolder()
          }}
        />
      </Modal>

      <Modal
        open={noteOpen}
        title="写文字资料"
        subtitle={`保存到：${selectedPath || '根目录'}`}
        onClose={() => setNoteOpen(false)}
        wide
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setNoteOpen(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void submitNote()}>
              保存
            </button>
          </div>
        }
      >
        <input
          className="input"
          placeholder="资料名称，如「网页动效经验」"
          value={noteName}
          onChange={(e) => setNoteName(e.target.value)}
        />
        <textarea
          className="input textarea-lg"
          rows={14}
          placeholder="写入希望长期复用的经验、模板说明或操作步骤…"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
        />
      </Modal>

      <Modal
        open={Boolean(renameFile)}
        title="重命名资料"
        onClose={() => setRenameFile(null)}
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setRenameFile(null)}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                if (!renameFile) return
                try {
                  await renameLibraryFile(renameFile.id, renameFile.name)
                  setRenameFile(null)
                  toast('已重命名', 'success')
                } catch (e) {
                  toast(String((e as Error)?.message || e), 'error')
                }
              }}
            >
              保存
            </button>
          </div>
        }
      >
        <input
          className="input"
          autoFocus
          value={renameFile?.name || ''}
          onChange={(e) => setRenameFile((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
        />
      </Modal>

      <Modal
        open={Boolean(moveFile)}
        title="移动到文件夹"
        subtitle={moveFile?.name}
        onClose={() => setMoveFile(null)}
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setMoveFile(null)}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                if (!moveFile) return
                try {
                  await moveLibraryFile(moveFile.id, moveFile.folderId)
                  setMoveFile(null)
                  toast('已移动', 'success')
                } catch (e) {
                  toast(String((e as Error)?.message || e), 'error')
                }
              }}
            >
              移动
            </button>
          </div>
        }
      >
        <select
          className="select"
          value={moveFile?.folderId || ''}
          onChange={(e) => setMoveFile((prev) => (prev ? { ...prev, folderId: e.target.value } : prev))}
        >
          <option value="">根目录</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {folderPathOf(f.id, folders)}
            </option>
          ))}
        </select>
      </Modal>

      <Modal
        open={Boolean(pendingDelete)}
        title={pendingDelete?.type === 'folder' ? '删除文件夹？' : '删除资料？'}
        subtitle={pendingDelete?.name}
        onClose={() => setPendingDelete(null)}
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setPendingDelete(null)}>
              取消
            </button>
            <button className="btn btn-danger" onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </div>
        }
      >
        <p className="delete-warning">
          {pendingDelete?.type === 'folder'
            ? `会递归删除 ${pendingDelete.fileCount || 0} 个文件。已引用这些资料的任务会显示「已删除」，但不会静默丢失引用记录。`
            : '删除后无法恢复；已经建立引用的任务会显示该资料已删除。'}
        </p>
      </Modal>

      <Modal
        open={Boolean(docFile)}
        title={docFile?.name || '资料'}
        subtitle={docFile ? `${profileStatusText(docFile.parseStatus)} · ${byteSize(docFile.size)}` : ''}
        onClose={() => setDocFile(null)}
        wide
        footer={
          docFile ? (
            <div className="modal-actions">
              {taskId ? (
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    void referenceFile(docFile)
                    setDocFile(null)
                  }}
                >
                  <Icon name="plus" size={13} /> 引用到当前任务
                </button>
              ) : null}
              <button className="btn btn-primary" onClick={() => setDocFile(null)}>
                关闭
              </button>
            </div>
          ) : null
        }
      >
        {docRef ? (
          <div className="doc-modal-body">
            <DocViewer doc={docRef} onSendToAgent={onSendToAgent} />
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
