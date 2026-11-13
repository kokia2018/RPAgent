import type { MessageRecord, TodoItem } from '../../db/types'
import { Icon } from '../icons'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { groupRunNotes, notePreview, type RunNote } from './notes'

export interface LiveTool {
  id: string
  name: string
  argsText: string
  resultText?: string
  status: 'running' | 'ok' | 'error'
  durationMs?: number
}

export interface RunView {
  runId: string
  status: 'running' | 'done' | 'aborted' | 'error' | 'budget'
  text: string
  tools: LiveTool[]
  notes: { kind: 'warning' | 'error'; message: string }[]
  rounds?: number
  maxRounds?: number
  summary?: string
  usage?: { prompt: number; completion: number; total: number }
}

const SUGGESTIONS = [
  '做一个点击计数器小游戏，带键盘快捷键和本地最高分。',
  '做一个番茄钟网页，支持自定义时长、暂停和提示音。',
  '做一个待办清单，支持增删改、筛选和本地保存。',
  '先创建一个空白 HTML 项目，打开试玩，然后告诉我下一步。',
]

function TodoCard({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return null
  const completed = todos.filter((t) => t.status === 'completed').length
  const percent = Math.round((completed / todos.length) * 100)
  return (
    <div className="todo-card">
      <div className="todo-head">
        <span>计划</span>
        <span className="todo-progress">
          {completed}/{todos.length}
        </span>
      </div>
      <div className="todo-bar">
        <span style={{ width: `${percent}%` }} />
      </div>
      <ul className="todo-list">
        {todos.map((t, i) => (
          <li key={i} className={`todo-${t.status}`}>
            <span className="todo-dot" />
            <span>{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 运行提示统一折叠成一行。
 * 一次运行会反复收到"试玩已更新"，逐条平铺会把消息列表冲垮；这里合并同文并折叠。
 */
function RunNotes({ notes }: { notes: RunNote[] }) {
  const groups = groupRunNotes(notes)
  const preview = notePreview(notes)
  const hasError = notes.some((n) => n.kind === 'error')
  return (
    <details className={`run-notes ${hasError ? 'is-error' : ''}`}>
      <summary className="run-notes-head">
        <Icon name="chevron" size={12} className="run-notes-chevron" />
        <Icon name="warning" size={13} />
        <span className="run-notes-title">运行提示 {notes.length} 条</span>
        {preview ? <span className="run-notes-preview">{preview.message}</span> : null}
      </summary>
      <div className="run-notes-body">
        {groups.map((group, i) => (
          <div key={i} className={`run-note run-note-${group.kind}`}>
            <span>{group.message}</span>
            {group.count > 1 ? <span className="run-note-count">×{group.count}</span> : null}
          </div>
        ))}
      </div>
    </details>
  )
}

export function MessageList({
  messages,
  live,
  todos,
  onSuggestion,
}: {
  messages: MessageRecord[]
  live: RunView | null
  todos: TodoItem[]
  onSuggestion: (text: string) => void
}) {
  const callMeta = new Map<string, { argsText: string; durationMs?: number; status?: string }>()
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    for (const c of m.toolCalls) {
      callMeta.set(c.id, {
        argsText: c.arguments,
        durationMs: c.durationMs,
        status: c.status,
      })
    }
  }

  const visible = messages.filter((m) => {
    if (!live || live.status !== 'running') return true
    if (m.role === 'user') return true
    return m.runId !== live.runId
  })

  const empty = visible.length === 0 && !live

  return (
    <div className="message-list">
      {empty ? (
        <div className="agent-welcome">
          <div className="agent-welcome-mark">
            <Icon name="spark" size={22} />
          </div>
          <h2>从一个想法开始</h2>
          <p>
            描述你想做的互动网页，或从下面的「附件」打开已有 HTML 和角色卡。先玩起来，再告诉 Agent 要改哪里。
          </p>
          <div className="suggestion-list">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggestion" onClick={() => onSuggestion(s)}>
                <span>{s}</span>
                <Icon name="chevron" size={14} />
              </button>
            ))}
          </div>
          <p className="agent-welcome-hint">
            本地打开网页、识别角色卡不需要模型。需要 AI 时再配置或授权。
          </p>
        </div>
      ) : null}

      <TodoCard todos={todos} />

      {visible.map((m) => {
        if (m.role === 'user') {
          return (
            <div key={m.id ?? m.seq} className="msg-user">
              <div className="msg-user-bubble">{m.content}</div>
            </div>
          )
        }
        if (m.role === 'assistant') {
          if (!m.content.trim()) return null
          return (
            <div key={m.id ?? m.seq} className="msg-assistant">
              <Markdown content={m.content} />
            </div>
          )
        }
        const meta = m.toolCallId ? callMeta.get(m.toolCallId) : undefined
        return (
          <ToolCard
            key={m.id ?? m.seq}
            name={m.name || 'tool'}
            argsText={meta?.argsText}
            resultText={m.content}
            status={m.status === 'error' ? 'error' : 'ok'}
            durationMs={meta?.durationMs}
          />
        )
      })}

      {live ? (
        <div className="live-run">
          {live.text ? (
            <div className="msg-assistant live-text">
              <Markdown content={live.text} />
              {live.status === 'running' ? <span className="stream-caret" /> : null}
            </div>
          ) : null}
          {live.tools.map((t) => (
            <ToolCard
              key={t.id}
              name={t.name}
              argsText={t.argsText}
              resultText={t.resultText}
              status={t.status}
              durationMs={t.durationMs}
            />
          ))}
          {live.notes.length ? <RunNotes notes={live.notes} /> : null}
          {live.status === 'running' ? (
            <div className="run-status">
              <span className="spinner" />
              <span>
                {live.rounds ? `第 ${live.rounds}${live.maxRounds ? `/${live.maxRounds}` : ''} 轮 · ` : ''}
                {live.tools.some((t) => t.status === 'running') ? '正在执行工具' : '正在生成'}
              </span>
              {live.usage ? (
                <span className="run-usage">
                  tokens {live.usage.total}（输入 {live.usage.prompt} / 输出 {live.usage.completion}）
                </span>
              ) : null}
            </div>
          ) : live.summary ? (
            <div className={`run-end run-end-${live.status}`}>
              <Icon name={live.status === 'done' ? 'check' : 'clock'} size={14} />
              <span>{live.summary}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
