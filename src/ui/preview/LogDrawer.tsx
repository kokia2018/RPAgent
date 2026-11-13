import { useEffect, useMemo, useRef, useState } from 'react'
import type { PreviewSessionRecord } from '../../db/types'
import { previewManager, type PreviewLogEntry } from '../../preview/manager'
import { useSyncExternalStore } from 'react'
import { Icon } from '../icons'
import { formatTime } from '../../lib/text'

type Filter = 'all' | 'errors' | 'console' | 'network'

function levelClass(level: string): string {
  if (level === 'error') return 'log-error'
  if (level === 'warn') return 'log-warn'
  if (level === 'debug') return 'log-debug'
  return 'log-info'
}

function typeLabel(entry: PreviewLogEntry): string {
  if (entry.type === 'error') return '异常'
  if (entry.type === 'network') return '网络'
  if (entry.type === 'ready') return '就绪'
  if (entry.type === 'load') return '加载'
  return '日志'
}

export function LogDrawer({
  session,
  onClose,
  onSendToAgent,
}: {
  session: PreviewSessionRecord
  onClose: () => void
  onSendToAgent: (text: string) => void
}) {
  useSyncExternalStore(previewManager.subscribe, previewManager.getVersion)
  const memoryLogs = previewManager.getLogs(session.id)
  const [persisted, setPersisted] = useState<PreviewLogEntry[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    previewManager
      .loadPersistedEvents(session.id)
      .then((rows) => {
        if (!cancelled) setPersisted(rows)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [session.id])

  const logs = useMemo(() => {
    const seen = new Set<string>()
    const merged: PreviewLogEntry[] = []
    for (const l of [...memoryLogs, ...persisted]) {
      const key = `${l.type}|${l.buildVersion}|${l.message}|${Math.round(l.at / 2000)}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(l)
    }
    merged.sort((a, b) => a.at - b.at)
    return merged
  }, [memoryLogs, persisted])

  const current = logs.filter((l) => l.buildVersion === session.buildVersion || l.buildVersion === 0)
  const filtered = current.filter((l) => {
    if (filter === 'errors') return l.type === 'error' || l.level === 'error'
    if (filter === 'console') return l.type === 'console'
    if (filter === 'network') return l.type === 'network'
    return true
  })
  const staleCount = logs.length - current.length
  const errorCount = current.filter((l) => l.type === 'error' || l.level === 'error').length

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [filtered.length])

  const send = () => {
    const errors = current.filter((l) => l.type === 'error' || l.level === 'error').slice(-8)
    const consoleErrors = current.filter((l) => l.type === 'console' && l.level === 'error').slice(-8)
    const network = current.filter((l) => l.type === 'network' && l.level !== 'info').slice(-8)
    const lines = [
      `试玩会话 ${session.id}（入口 ${session.entryPath}，build ${session.buildVersion}）出现以下问题，请先调用 preview({action:"observe"}) 确认当前构建，再修改工作区文件：`,
      ...errors.map((l) => `- [异常] ${l.message}`),
      ...consoleErrors.map((l) => `- [console.error] ${l.message}`),
      ...network.map((l) => `- [网络] ${l.message}`),
    ]
    if (lines.length === 1) lines.push('- 暂无明确错误，请读取页面结构与状态，判断为什么没有达到预期。')
    onSendToAgent(lines.join('\n'))
  }

  return (
    <div className="log-drawer">
      <div className="log-head">
        <div className="log-title">
          <Icon name="terminal" size={14} />
          <span>运行日志</span>
          <span className="log-count">{current.length} 条</span>
          {errorCount ? <span className="log-error-badge">{errorCount} 错误</span> : null}
          {staleCount ? <span className="log-stale">已隐藏 {staleCount} 条旧构建日志</span> : null}
        </div>
        <div className="log-actions">
          <div className="segmented">
            {(
              [
                ['all', '全部'],
                ['errors', '错误'],
                ['console', '控制台'],
                ['network', '网络'],
              ] as [Filter, string][]
            ).map(([key, label]) => (
              <button key={key} className={filter === key ? 'is-on' : ''} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>
          <button className="btn btn-small" onClick={send}>
            <Icon name="agent" size={13} /> 交给 Agent
          </button>
          <button className="btn btn-small btn-ghost" onClick={() => previewManager.clearLogs(session.id)}>
            清空
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="关闭日志">
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>
      <div className="log-list" ref={scrollRef}>
        {filtered.length ? (
          filtered.map((l) => (
            <div key={l.id} className={`log-row ${levelClass(l.level)}`}>
              <span className="log-time">{formatTime(l.at)}</span>
              <span className="log-type">{typeLabel(l)}</span>
              <span className="log-message">{l.message}</span>
              {l.data ? (
                <details className="log-data">
                  <summary>详情</summary>
                  <pre>{JSON.stringify(l.data, null, 2).slice(0, 2000)}</pre>
                </details>
              ) : null}
            </div>
          ))
        ) : (
          <p className="empty-hint">当前构建还没有日志。运行页面或触发交互后，这里会显示 console、异常与网络失败。</p>
        )}
      </div>
    </div>
  )
}
