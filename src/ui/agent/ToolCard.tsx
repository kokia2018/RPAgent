import { useEffect, useRef } from 'react'
import { Icon } from '../icons'
import { formatDuration } from '../../lib/text'

const LABELS: Record<string, string> = {
  todo_write: '更新计划',
  fs_list: '列目录',
  fs_read: '读文件',
  fs_write: '写文件',
  fs_edit: '修改文件',
  fs_delete: '删除文件',
  fs_search: '搜索工作区',
  build_project: '构建检查',
  preview: '试玩',
  page_action: '页面操作',
  js_run: '执行脚本',
  web_fetch: '获取网页',
  snapshot: '版本快照',
  export_html: '导出 HTML',
  finish: '完成任务',
}

function parseJson(text?: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function argSummary(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  if (typeof args.path === 'string') return args.path
  if (name === 'fs_search' && typeof args.query === 'string') return `“${args.query}”`
  if (name === 'preview') {
    const action = String(args.action || '')
    const target = typeof args.entryPath === 'string' ? args.entryPath : ''
    return [action, target].filter(Boolean).join(' · ')
  }
  if (name === 'page_action') {
    return [String(args.action || ''), typeof args.selector === 'string' ? args.selector : '']
      .filter(Boolean)
      .join(' · ')
  }
  if (name === 'export_html') return typeof args.name === 'string' ? args.name : ''
  if (name === 'finish') return typeof args.summary === 'string' ? args.summary.slice(0, 80) : ''
  if (name === 'web_fetch') return typeof args.url === 'string' ? args.url : ''
  if (name === 'todo_write') return Array.isArray(args.todos) ? `${args.todos.length} 项` : ''
  return ''
}

function resultSummary(raw?: string): { text: string; error?: string } {
  const parsed = parseJson(raw) as
    | {
        success?: boolean
        error?: { message?: string }
        data?: Record<string, unknown>
        warnings?: string[]
      }
    | undefined
  if (!parsed || typeof parsed !== 'object') {
    return { text: raw ? raw.slice(0, 120) : '' }
  }
  if (parsed.success === false) {
    return { text: parsed.error?.message || '工具执行失败', error: parsed.error?.message || '失败' }
  }
  const data = parsed.data || {}
  if (typeof data.path === 'string') {
    const bytes = typeof data.bytes === 'number' ? ` · ${data.bytes} B` : ''
    return { text: `${data.path}${bytes}` }
  }
  if (typeof data.sessionId === 'string') return { text: `会话 ${data.sessionId.slice(0, 12)}…` }
  if (data.diff && typeof data.diff === 'object') return { text: '版本差异已生成' }
  if (Array.isArray(data.sessions)) return { text: `${data.sessions.length} 个会话` }
  if (Array.isArray(data.matches)) return { text: `${data.matches.length} 处匹配` }
  if (data.result !== undefined) return { text: String(JSON.stringify(data.result)).slice(0, 120) }
  const warnings = parsed.warnings?.length ? ` · ${parsed.warnings.length} 条提示` : ''
  return { text: `完成${warnings}` }
}

/**
 * 工具调用卡片：默认折叠成一行，点开才看结果与参数。
 * 失败自动展开（错误信息不该藏在折叠里），但用户手动折叠后不再强行撑开。
 */
export function ToolCard({
  name,
  argsText,
  resultText,
  status,
  durationMs,
}: {
  name: string
  argsText?: string
  resultText?: string
  status: 'running' | 'ok' | 'error'
  durationMs?: number
}) {
  const args = parseJson(argsText) as Record<string, unknown> | undefined
  const summary = argSummary(name, args)
  const result = resultSummary(resultText)
  const label = LABELS[name] || name
  const cardRef = useRef<HTMLDetailsElement>(null)
  const touchedRef = useRef(false)

  // 直接改 DOM 的 open，不用 state：折叠是纯展示状态，交给浏览器管。
  useEffect(() => {
    const el = cardRef.current
    if (el && status === 'error' && !touchedRef.current) el.open = true
  }, [status])

  const hasBody = Boolean(result.text || result.error || argsText || resultText)

  return (
    <details
      ref={cardRef}
      className={`tool-card tool-${status}`}
      onToggle={() => {
        touchedRef.current = true
      }}
    >
      <summary className="tool-head" title={[label, summary].filter(Boolean).join(' · ')}>
        <Icon name="chevron" size={12} className="tool-chevron" />
        <span className="tool-icon">
          <Icon name={name === 'finish' ? 'check' : name.startsWith('fs_') ? 'file' : name === 'preview' ? 'preview' : 'terminal'} size={14} />
        </span>
        <span className="tool-name">{label}</span>
        {summary ? <span className="tool-arg">{summary}</span> : null}
        <span className="tool-meta">
          {status === 'running' ? <span className="spinner" /> : null}
          {status === 'error' ? <Icon name="warning" size={13} /> : null}
          {status === 'ok' ? <Icon name="check" size={13} /> : null}
          {durationMs != null ? <span>{formatDuration(durationMs)}</span> : null}
        </span>
      </summary>
      {hasBody ? (
        <div className="tool-body">
          {result.text || result.error ? (
            <div className={`tool-result ${result.error ? 'is-error' : ''}`}>{result.error || result.text}</div>
          ) : null}
          {argsText ? (
            <div className="tool-detail-block">
              <div className="tool-detail-label">参数</div>
              <pre>{argsText.slice(0, 4000)}</pre>
            </div>
          ) : null}
          {resultText ? (
            <div className="tool-detail-block">
              <div className="tool-detail-label">结果</div>
              <pre>{resultText.slice(0, 6000)}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}
