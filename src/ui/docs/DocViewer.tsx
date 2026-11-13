import { useEffect, useMemo, useState } from 'react'
import { liveQuery } from 'dexie'
import type { AssetParseStatus } from '../../db/types'
import { getTaskAttachment, getLibraryFile, readAttachmentText, readLibraryFileText } from '../../db/assets'
import { getWorkspaceFile } from '../../db/repo'
import { byteSize, formatTime } from '../../lib/text'
import { profileForFile, profileStatusText } from '../../lib/documents'
import { Icon } from '../icons'
import { Markdown } from '../agent/Markdown'

export interface DocRef {
  source: 'workspace' | 'attachment' | 'library'
  taskId?: string
  /** workspace 用 path；attachment/library 用 id。 */
  path?: string
  id?: string
  name: string
  mime: string
}

interface LoadedDoc {
  key: string
  mime: string
  revision: string
  text: string | null
  blob: Blob | null
  size: number
  updatedAt: number
  parseStatus: AssetParseStatus
  note: string
}

function parseCsv(text: string, maxRows = 200): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let truncated = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.some((c) => c.length)) rows.push(row)
      row = []
      if (rows.length >= maxRows) {
        truncated = true
        break
      }
    } else cell += ch
  }
  if (!truncated && (cell.length || row.length)) {
    row.push(cell)
    if (row.some((c) => c.length)) rows.push(row)
  }
  return { rows, truncated }
}

export function DocViewer({
  doc,
  onSendToAgent,
  onOpenInPreview,
}: {
  doc: DocRef
  onSendToAgent?: (text: string) => void
  onOpenInPreview?: (path: string) => void
}) {
  const [loadedState, setLoaded] = useState<LoadedDoc | null>(null)
  const [errorState, setError] = useState<{ key: string; message: string } | null>(null)
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered')
  const [objectUrl, setObjectUrl] = useState<{ key: string; revision: string; url: string } | null>(null)
  const docKey = JSON.stringify([doc.source, doc.taskId, doc.path, doc.id, doc.name, doc.mime])
  // Never label the previous selection's bytes as the newly selected document.
  const loaded = loadedState?.key === docKey ? loadedState : null
  const error = errorState?.key === docKey ? errorState.message : ''
  const mime = loaded?.mime || doc.mime
  const profile = useMemo(() => profileForFile(doc.name, mime), [doc.name, mime])

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setError(null)
    setViewMode('rendered')
    const load = async (): Promise<LoadedDoc> => {
      let text: string | null = null
      let blob: Blob | null = null
      let size = 0
      let updatedAt = 0
      let actualMime = doc.mime
      let revision = ''
      let parseStatus: AssetParseStatus = profileForFile(doc.name, doc.mime).status
      let note = profileForFile(doc.name, doc.mime).note

      if (doc.source === 'workspace') {
        if (!doc.taskId || !doc.path) throw new Error('缺少空间或路径')
        const file = await getWorkspaceFile(doc.taskId, doc.path)
        if (!file) throw new Error('工作文件不存在，可能已被删除；不会回退下载其他版本。')
        const fileProfile = profileForFile(file.path, file.mime)
        blob = file.blob || null
        size = file.size
        actualMime = file.mime
        revision = file.hash
        updatedAt = file.updatedAt
        parseStatus = fileProfile.status
        note = fileProfile.note
        if (typeof file.text === 'string') text = file.text
        else if (blob && fileProfile.readable) text = await blob.text()
      } else if (doc.source === 'attachment') {
        if (!doc.id) throw new Error('缺少附件 ID')
        const attachment = await getTaskAttachment(doc.id)
        if (!attachment) throw new Error('附件不存在')
        text = await readAttachmentText(attachment)
        blob = attachment.blob || null
        size = attachment.size
        actualMime = attachment.mime
        revision = attachment.hash
        updatedAt = attachment.createdAt
        parseStatus = attachment.parseStatus
        note = attachment.parseNote || note
      } else {
        if (!doc.id) throw new Error('缺少资料 ID')
        const file = await getLibraryFile(doc.id)
        if (!file) throw new Error('资料不存在，可能已被删除')
        text = await readLibraryFileText(file)
        blob = file.blob || null
        size = file.size
        actualMime = file.mime
        revision = file.hash
        updatedAt = file.updatedAt
        parseStatus = file.parseStatus
        note = file.parseNote || note
      }
      return { key: docKey, mime: actualMime, revision, text, blob, size, updatedAt, parseStatus, note }
    }
    const accept = (next: LoadedDoc) => {
      if (cancelled) return
      setLoaded(next)
      setError(null)
    }
    const fail = (e: unknown) => {
      if (cancelled) return
      setLoaded(null)
      setError({ key: docKey, message: String((e as Error)?.message || e) })
    }
    // Catch inside liveQuery so deletion/read failures do not terminate its subscription.
    const subscription = doc.source === 'attachment' ? null : liveQuery(async () => {
      try { return { value: await load(), error: null } }
      catch (e) { return { value: null, error: e } }
    }).subscribe({
      next: (result) => { if (result.value) accept(result.value); else fail(result.error) },
      error: fail,
    })
    if (doc.source === 'attachment') void load().then(accept, fail)
    return () => {
      cancelled = true
      subscription?.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  useEffect(() => {
    if (!loaded || profile.kind !== 'image') {
      setObjectUrl(null)
      return
    }
    const blob = loaded.blob || (loaded.text != null ? new Blob([loaded.text], { type: loaded.mime }) : null)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setObjectUrl({ key: loaded.key, revision: loaded.revision, url })
    return () => URL.revokeObjectURL(url)
  }, [loaded, profile.kind])

  const download = () => {
    // Use the exact object rendered above, never re-read a latest workspace record here.
    const blob = loaded?.blob || (loaded?.text != null ? new Blob([loaded.text], { type: loaded.mime }) : null)
    if (!loaded || !blob) {
      setError({ key: docKey, message: '当前展示版本的原始数据不可用；未下载，也不会回退到最新文件。' })
      return
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = doc.name.split('/').pop() || 'file'
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  const handoffText = () => {
    if (doc.source === 'attachment') {
      return `请分析附件「${doc.name}」（id=${doc.id}，${doc.mime}）。先用 attachment({action:"read"}) 查看内容；如果格式不支持，请说明限制，并给出可行的处理方案（例如转换、提取、或改写到工作区）。`
    }
    if (doc.source === 'library') {
      return `请参考常用资料「${doc.name}」（fileId=${doc.id}，${doc.mime}）。先用 library({action:"read"}) 查看；如果格式不支持，请说明限制和可行处理方案。`
    }
    return `请检查工作区文件 ${doc.path}（${doc.mime}）。先用 fs_read 查看内容；如果需要修改，请直接修改并打开试玩验证。`
  }

  const meta = loaded
    ? `${profileStatusText(loaded.parseStatus)} · ${byteSize(loaded.size)} · ${doc.mime || '未知类型'} · ${formatTime(loaded.updatedAt)}`
    : `${profileStatusText(profile.status)} · ${doc.mime || '未知类型'}`

  return (
    <div className="doc-viewer">
      <header className="doc-head">
        <div className="doc-title">
          <Icon name="book" size={15} />
          <span className="doc-name">{doc.name}</span>
          <span className="doc-meta">{meta}</span>
        </div>
        <div className="doc-actions">
          {profile.kind === 'html' ? (
            <div className="segmented segmented-small">
              <button className={viewMode === 'rendered' ? 'is-on' : ''} onClick={() => setViewMode('rendered')}>
                渲染
              </button>
              <button className={viewMode === 'source' ? 'is-on' : ''} onClick={() => setViewMode('source')}>
                源码
              </button>
            </div>
          ) : null}
          {profile.runnable && doc.source === 'workspace' && doc.path && onOpenInPreview ? (
            <button className="btn btn-small" onClick={() => onOpenInPreview(doc.path as string)}>
              <Icon name="play" size={13} /> 在试玩打开
            </button>
          ) : null}
          {loaded && (loaded.blob || loaded.text != null) ? (
            <button className="btn btn-small btn-ghost" onClick={download}>
              <Icon name="download" size={13} /> 下载
            </button>
          ) : null}
          {onSendToAgent ? (
            <button className="btn btn-small btn-ghost" onClick={() => onSendToAgent(handoffText())}>
              <Icon name="agent" size={13} /> 交给 Agent
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="doc-body">
          <div className="doc-notice error">
            <Icon name="warning" size={22} />
            <p>{error}</p>
          </div>
        </div>
      ) : !loaded ? (
        <div className="doc-body">
          <div className="doc-notice">
            <span className="spinner" />
            <p>正在读取…</p>
          </div>
        </div>
      ) : loaded.parseStatus === 'unsupported' || loaded.parseStatus === 'binary' ? (
        <div className="doc-body">
          <div className="doc-notice">
            <Icon name="file" size={26} />
            <h3>暂不支持在阅读器里解析</h3>
            <p>{loaded.note}</p>
            <p className="muted">工作台不会伪造解析结果；原始文件仍保留，可下载或交给 Agent 分析。</p>
          </div>
        </div>
      ) : profile.kind === 'image' ? (
        <div className="doc-body doc-image-body">
          {objectUrl ? (
            <img className="doc-image" src={objectUrl.url} alt={doc.name} />
          ) : (
            <div className="doc-notice">
              <Icon name="warning" size={22} />
              <p>图片数据不可用。</p>
            </div>
          )}
        </div>
      ) : loaded.text == null ? (
        <div className="doc-body">
          <div className="doc-notice">
            <Icon name="file" size={24} />
            <p>{loaded.note || '没有可显示的文本内容。'}</p>
          </div>
        </div>
      ) : profile.kind === 'html' && viewMode === 'rendered' ? (
        <div className="doc-body doc-html-body">
          <p className="doc-hint">阅读器中的 HTML 渲染已禁用脚本；要运行交互，请使用「在试玩打开」。</p>
          <iframe className="doc-html-frame" sandbox="" srcDoc={loaded.text} title={doc.name} />
        </div>
      ) : (
        <div className="doc-body doc-text-body">
          <DocText text={loaded.text} kind={profile.kind} />
        </div>
      )}
    </div>
  )
}

function DocText({ text, kind }: { text: string; kind: string }) {
  const [showAll, setShowAll] = useState(false)
  const limit = 400_000
  const clipped = text.length > limit && !showAll
  const shown = clipped ? text.slice(0, limit) : text

  if (kind === 'markdown') {
    return (
      <div className="doc-scroll">
        <Markdown content={shown} />
        {clipped ? <TruncatedNote onMore={() => setShowAll(true)} total={text.length} /> : null}
      </div>
    )
  }
  if (kind === 'json') {
    let pretty = shown
    try {
      pretty = JSON.stringify(JSON.parse(shown), null, 2)
    } catch {
      pretty = shown
    }
    return (
      <div className="doc-scroll">
        <pre className="doc-pre">{pretty}</pre>
        {clipped ? <TruncatedNote onMore={() => setShowAll(true)} total={text.length} /> : null}
      </div>
    )
  }
  if (kind === 'csv') {
    const { rows, truncated } = parseCsv(shown)
    const header = rows[0] || []
    return (
      <div className="doc-scroll">
        {rows.length ? (
          <table className="doc-table">
            <thead>
              <tr>
                {header.map((cell, i) => (
                  <th key={i}>{cell}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((row, r) => (
                <tr key={r}>
                  {header.map((_, c) => (
                    <td key={c}>{row[c] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">没有可显示的表格行。</p>
        )}
        {truncated ? <p className="doc-hint">表格较大，只显示前 200 行。</p> : null}
        {clipped ? <TruncatedNote onMore={() => setShowAll(true)} total={text.length} /> : null}
      </div>
    )
  }
  return (
    <div className="doc-scroll">
      <pre className="doc-pre">{shown}</pre>
      {clipped ? <TruncatedNote onMore={() => setShowAll(true)} total={text.length} /> : null}
    </div>
  )
}

function TruncatedNote({ onMore, total }: { onMore: () => void; total: number }) {
  return (
    <div className="doc-hint">
      内容较长，当前只显示前 400,000 字符（共 {total} 字符）。
      <button className="btn btn-small btn-ghost" onClick={onMore}>
        显示全部
      </button>
    </div>
  )
}
