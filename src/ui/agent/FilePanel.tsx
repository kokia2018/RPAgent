import { useEffect, useMemo, useState } from 'react'
import type { WorkspaceFile } from '../../db/types'
import { listWorkspaceFiles } from '../../db/repo'
import { useLiveQueryValue } from '../hooks'
import { Icon, type IconName } from '../icons'
import { Modal } from '../Modal'
import { byteSize, formatTime } from '../../lib/text'
import { downloadText } from '../../export/exportHtml'
import type { DocRef } from '../docs/DocViewer'
import { profileForFile } from '../../lib/documents'

interface TreeNode {
  name: string
  path: string
  dirs: Map<string, TreeNode>
  files: WorkspaceFile[]
}

function buildTree(files: WorkspaceFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '/', dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      const path = '/' + parts.slice(0, i + 1).join('/')
      let next = cur.dirs.get(name)
      if (!next) {
        next = { name, path, dirs: new Map(), files: [] }
        cur.dirs.set(name, next)
      }
      cur = next
    }
    cur.files.push(file)
  }
  return root
}

function extIcon(path: string): IconName {
  if (/\.html?$/i.test(path)) return 'preview'
  if (/\.(js|mjs|ts|tsx|jsx)$/i.test(path)) return 'terminal'
  if (/\.(css|scss|less)$/i.test(path)) return 'edit'
  if (/\.(md|txt)$/i.test(path)) return 'book'
  return 'file'
}

function FileViewer({
  file,
  onClose,
  onOpenEntry,
  onOpenDoc,
}: {
  file: WorkspaceFile | null
  onClose: () => void
  onOpenEntry: (path: string) => void
  onOpenDoc?: (doc: DocRef) => void
}) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    setContent(null)
    setShowRaw(false)
  }, [file?.path, file?.hash])

  const load = async () => {
    if (!file) return
    setLoading(true)
    try {
      const text = typeof file.text === 'string' ? file.text : file.blob ? await file.blob.text() : ''
      setContent(text)
    } finally {
      setLoading(false)
    }
  }

  const isText = typeof file?.text === 'string' || (file?.mime || '').startsWith('text/') || /\.(md|txt|json|js|css|html?|svg)$/i.test(file?.path || '')
  const isHtml = /\.html?$/i.test(file?.path || '')

  return (
    <Modal
      open={Boolean(file)}
      title={file?.path || '文件'}
      subtitle={file ? `${byteSize(file.size)} · ${file.mime} · ${formatTime(file.updatedAt)}` : ''}
      onClose={() => {
        setContent(null)
        onClose()
      }}
      wide
      footer={
        file ? (
          <div className="modal-actions">
            {isText ? (
              <button className="btn btn-ghost" onClick={load} disabled={loading}>
                {loading ? '读取中…' : '读取内容'}
              </button>
            ) : null}
            {onOpenDoc && profileForFile(file.path, file.mime).readable && !isHtml ? (
              <button className="btn btn-ghost" onClick={() => { onOpenDoc({ source: 'workspace', taskId: file.taskId, path: file.path, name: file.path, mime: file.mime }); onClose() }}>在阅读器打开</button>
            ) : null}
            {isHtml ? (
              <button className="btn btn-ghost" onClick={() => { onOpenEntry(file.path); onClose() }}>
                <Icon name="preview" /> 在试玩打开
              </button>
            ) : null}
            <button
              className="btn btn-ghost"
              onClick={() => {
                if (!file) return
                if (file.blob) {
                  const url = URL.createObjectURL(file.blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = file.path.split('/').pop() || 'file'
                  a.click()
                  setTimeout(() => URL.revokeObjectURL(url), 5000)
                } else {
                  downloadText(file.path.split('/').pop() || 'file.txt', file.text || '', file.mime)
                }
              }}
            >
              <Icon name="download" /> 下载
            </button>
            {isText ? (
              <button className="btn btn-ghost" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? '隐藏原文' : '查看原文'}
              </button>
            ) : null}
          </div>
        ) : null
      }
    >
      {!isText ? (
        <div className="file-binary">
          <Icon name="file" size={28} />
          <p>二进制文件，预览区不展示内容。可下载后查看。</p>
        </div>
      ) : content == null ? (
        <div className="file-binary">
          <Icon name="file" size={28} />
          <p>点击“读取内容”查看文本。</p>
        </div>
      ) : (
        <div className="file-viewer">
          {showRaw ? <pre className="file-raw">{content}</pre> : <FileContent content={content} path={file?.path || ''} />}
        </div>
      )}
    </Modal>
  )
}

function FileContent({ content, path }: { content: string; path: string }) {
  if (/\.html?$/i.test(path)) {
    return <iframe className="file-html-preview" sandbox="" srcDoc={content} title="HTML 预览" />
  }
  return <pre className="file-raw">{content}</pre>
}

export function FilePanel({
  taskId,
  open,
  onClose,
  onOpenEntry,
  onOpenDoc,
}: {
  taskId: string
  open: boolean
  onClose: () => void
  onOpenEntry: (path: string) => void
  onOpenDoc?: (doc: DocRef) => void
}) {
  const files = useLiveQueryValue(() => listWorkspaceFiles(taskId), [taskId], [])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [viewerPath, setViewerPath] = useState<string | null>(null)
  const viewer = files.find(file => file.path === viewerPath) || null
  const tree = useMemo(() => buildTree(files), [files])

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const dirs = Array.from(node.dirs.values()).sort((a, b) => a.name.localeCompare(b.name))
    const fileList = [...node.files].sort((a, b) => a.path.localeCompare(b.path))
    return (
      <>
        {dirs.map((dir) => {
          const isCollapsed = collapsed.has(dir.path)
          return (
            <div key={dir.path} className="tree-dir">
              <button
                className="tree-row tree-dir-row"
                style={{ paddingLeft: 10 + depth * 14 }}
                onClick={() => toggle(dir.path)}
              >
                <Icon name="chevron" size={12} className={isCollapsed ? 'chev-collapsed' : 'chev-open'} />
                <Icon name="folder" size={14} />
                <span className="tree-name">{dir.name}</span>
              </button>
              {isCollapsed ? null : renderNode(dir, depth + 1)}
            </div>
          )
        })}
        {fileList.map((file) => (
          <button
            key={file.path}
            className="tree-row tree-file-row"
            style={{ paddingLeft: 22 + depth * 14 }}
            onClick={() => setViewerPath(file.path)}
            title={file.path}
          >
            <Icon name={extIcon(file.path)} size={14} />
            <span className="tree-name">{file.path.split('/').pop()}</span>
            <span className="tree-size">{byteSize(file.size)}</span>
          </button>
        ))}
      </>
    )
  }

  if (!open) return null
  return (
    <>
      <aside className="file-panel">
        <div className="file-panel-head">
          <div>
            <strong>工作区</strong>
            <span className="file-count">{files.length} 个文件</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="收起文件面板">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="file-tree">
          {files.length ? renderNode(tree, 0) : <p className="empty-hint">工作区还是空的。让 Agent 创建第一个文件。</p>}
        </div>
        <div className="file-panel-foot">
          <span>文件由 Agent 写入；点击查看内容。</span>
        </div>
      </aside>
      <FileViewer file={viewer} onClose={() => setViewerPath(null)} onOpenEntry={onOpenEntry} onOpenDoc={onOpenDoc} />
    </>
  )
}
