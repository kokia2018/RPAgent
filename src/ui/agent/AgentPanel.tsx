import { useEffect, useRef, useState } from 'react'
import type { ApiSettings, Task } from '../../db/types'
import { listMessages } from '../../db/repo'
import { listConversationMessages } from '../../db/conversations'
import { previewManager } from '../../preview/manager'
import { useAutoScroll, useLiveQueryValue } from '../hooks'
import { useToast } from '../toast'
import { Icon } from '../icons'
import { runAgent } from '../../agent/loop'
import type { AgentEvent } from '../../agent/types'
import { MessageList, type LiveTool, type RunView } from './MessageList'
import { FilePanel } from './FilePanel'
import { TaskAssetsPanel } from './TaskAssetsPanel'
import { SnapshotModal } from './SnapshotModal'
import { CharacterChatModal, type CharacterCardTarget } from '../character/CharacterChatModal'
import type { DocRef } from '../docs/DocViewer'

/** 小数字直接显示，大数字才缩成 k，避免 "0k → 0k" 这种没信息量的日志。 */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${Math.round(tokens)} token`
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k token`
}

export interface AgentSeed {
  id: number
  text: string
}

export function AgentPanel({
  task,
  conversationId,
  conversationTitle,
  settings,
  seed,
  onOpenSettings,
  onSendToAgent,
  onOpenDoc,
  onRequestRun,
  onRunningChange,
}: {
  task: Task
  /** 同一空间可有多个对话：历史按对话分开，文件按空间共享。 */
  conversationId?: string
  conversationTitle?: string
  settings: ApiSettings
  seed: AgentSeed | null
  onOpenSettings: () => void
  onSendToAgent: (text: string) => void
  onOpenDoc: (doc: DocRef) => void
  onRequestRun: (path: string) => void
  onRunningChange: (running: boolean) => void
}) {
  const { toast } = useToast()
  const messages = useLiveQueryValue(
    () => (conversationId ? listConversationMessages(conversationId) : listMessages(task.id)),
    [task.id, conversationId],
    [],
  )
  const [input, setInput] = useState('')
  const [run, setRun] = useState<RunView | null>(null)
  const [sidePanel, setSidePanel] = useState<'none' | 'files' | 'assets'>('none')
  const [snapshotsOpen, setSnapshotsOpen] = useState(false)
  const [cardTarget, setCardTarget] = useState<CharacterCardTarget | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const running = run?.status === 'running'
  const sideOpen = sidePanel !== 'none'

  const scrollRef = useAutoScroll<HTMLDivElement>(run?.text)

  useEffect(() => {
    if (!seed) return
    setInput(seed.text)
    inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.id])

  useEffect(() => {
    return () => {
      controllerRef.current?.abort()
      controllerRef.current = null
    }
  }, [])

  const configured = Boolean(settings.baseUrl && settings.model)

  const handleEvent = (event: AgentEvent) => {
    setRun((prev) => {
      if (event.type === 'run_start') {
        return {
          runId: event.runId,
          status: 'running',
          text: '',
          tools: [],
          notes: [],
          rounds: 0,
          maxRounds: settings.maxRounds > 0 ? settings.maxRounds : undefined,
        }
      }
      if (!prev) return prev
      switch (event.type) {
        case 'round':
          return {
            ...prev,
            rounds: event.round,
            maxRounds: event.maxRounds,
            text: prev.text && !prev.text.endsWith('\n') ? prev.text + '\n\n' : prev.text,
          }
        case 'text':
          return { ...prev, text: prev.text + event.text }
        case 'tool_start':
          return {
            ...prev,
            tools: [
              ...prev.tools,
              {
                id: event.id,
                name: event.name,
                argsText: JSON.stringify(event.args, null, 2),
                status: 'running',
              },
            ],
          }
        case 'tool_end':
          return {
            ...prev,
            tools: prev.tools.map((t) =>
              t.id === event.id
                ? {
                    ...t,
                    status: event.result.success ? 'ok' : 'error',
                    resultText: JSON.stringify(event.result, null, 2),
                    durationMs: event.durationMs,
                  }
                : t,
            ),
          }
        case 'todo':
          return prev
        case 'usage':
          return { ...prev, usage: event.usage }
        case 'compaction':
          return {
            ...prev,
            notes: [
              ...prev.notes,
              {
                kind: 'warning',
                message: `已压缩上下文：${formatTokens(event.tokensBefore)} → ${formatTokens(event.tokensAfter)}（${event.summarized} 条旧消息收进摘要）。`,
              },
            ],
          }
        case 'warning':
          return { ...prev, notes: [...prev.notes, { kind: 'warning', message: event.message }] }
        case 'error':
          return { ...prev, notes: [...prev.notes, { kind: 'error', message: event.message }] }
        case 'run_end':
          return {
            ...prev,
            status: event.status,
            text: '',
            tools: [],
            rounds: event.rounds,
            summary: event.summary,
          }
        default:
          return prev
      }
    })
  }

  const send = async () => {
    const text = input.trim()
    if (!text || controllerRef.current) return
    if (!configured) {
      toast('请先在设置里配置 API Base URL 与模型', 'warning')
      onOpenSettings()
      return
    }
    setInput('')
    setRun(null)
    const controller = new AbortController()
    setRun({ runId: 'starting', status: 'running', text: '', tools: [], notes: [] })
    controllerRef.current = controller
    onRunningChange(true)
    try {
      await runAgent({
        taskId: task.id,
        conversationId,
        // 发送时固定目标窗口；运行中切换查看的窗口不会改写本次执行。
        sessionId: previewManager.getActiveSession(task.id),
        userText: text,
        settings,
        signal: controller.signal,
        onEvent: handleEvent,
      })
    } catch (e) {
      const message = String((e as Error)?.message || e)
      toast('运行失败：' + message, 'error')
      setRun((prev) =>
        prev
          ? { ...prev, status: 'error', summary: message, text: '', tools: [] }
          : {
              runId: 'local_error',
              status: 'error',
              text: '',
              tools: [],
              notes: [],
              summary: message,
            },
      )
    } finally {
      controllerRef.current = null
      onRunningChange(false)
    }
  }

  const stop = () => {
    controllerRef.current?.abort()
    toast('已请求停止；已写入的文件会保留。', 'info')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <section className="agent-panel">
      <header className="panel-head">
        <div className="panel-title">
          <Icon name="agent" size={15} />
          <span>Agent</span>
          <span className="panel-sub">{conversationTitle ? `${conversationTitle} · ${task.title}` : task.title}</span>
        </div>
        <details className="secondary-menu panel-menu">
          <summary className="chip" aria-label="对话工具"><Icon name="more" size={16} /></summary>
          <div className="menu-sheet">
            <button onClick={() => setSidePanel((v) => v === 'files' ? 'none' : 'files')}>作品文件</button>
            <button onClick={() => setSidePanel((v) => v === 'assets' ? 'none' : 'assets')}>附件与参考资料</button>
            <button onClick={() => setSnapshotsOpen(true)}>版本与回退</button>
            <button onClick={onOpenSettings}>模型与设置</button>
          </div>
        </details>
      </header>

      {task.status === 'interrupted' && !running ? (
        <div className="banner">
          <Icon name="clock" size={15} />
          <span>上次运行被中断。工作区文件已保留，可以继续对话修复。</span>
        </div>
      ) : null}

      <div className={`agent-body ${sideOpen ? 'with-files' : ''}`}>
        <FilePanel
          taskId={task.id}
          open={sidePanel === 'files'}
          onOpenDoc={onOpenDoc}
          onClose={() => setSidePanel('none')}
          onOpenEntry={(path) => {
            setSidePanel('none')
            onRequestRun(path)
          }}
        />
        <TaskAssetsPanel
          taskId={task.id}
          open={sidePanel === 'assets'}
          onClose={() => setSidePanel('none')}
          onOpenDoc={onOpenDoc}
          onRequestRun={onRequestRun}
          onOpenCard={(target) => {
            setSidePanel('none')
            setCardTarget(target)
          }}
          onSendToAgent={onSendToAgent}
        />
        <div className="chat-scroll" ref={scrollRef}>
          <MessageList
            messages={messages}
            live={run}
            todos={task.todos || []}
            onSuggestion={(text) => {
              setInput(text)
              inputRef.current?.focus()
            }}
          />
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            aria-label="给 Agent 的消息"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="描述你要做的网页应用，或让 Agent 修改当前项目…"
            rows={3}
            disabled={running}
          />
          <div className="composer-bar">
            <button className={`btn btn-ghost ${sidePanel === 'assets' ? 'is-on' : ''}`} onClick={() => setSidePanel((v) => v === 'assets' ? 'none' : 'assets')} aria-label="添加附件或参考资料">
              <Icon name="plus" size={16} /> 附件
            </button>
            <span className="composer-hint">上传网页即玩 · 对话继续改</span>
            {running ? (
              <button className="btn btn-stop" onClick={stop}>
                <Icon name="stop" size={14} /> 停止
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void send()} disabled={!input.trim()}>
                <Icon name="send" size={14} /> 发送
              </button>
            )}
          </div>
        </div>
      </div>
      <SnapshotModal taskId={task.id} open={snapshotsOpen} onClose={() => setSnapshotsOpen(false)} />
      <CharacterChatModal
        open={Boolean(cardTarget)}
        target={cardTarget}
        taskId={task.id}
        settings={settings}
        onClose={() => setCardTarget(null)}
      />
    </section>
  )
}
