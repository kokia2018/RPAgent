import { useEffect, useRef, useState } from 'react'
import type { ApiSettings, Task, UiSettings } from '../db/types'
import { AgentPanel, type AgentSeed } from './agent/AgentPanel'
import { PreviewPanel } from './preview/PreviewPanel'
import { Icon } from './icons'
import type { DocRef } from './docs/DocViewer'
import { tabSync } from '../lib/tabSync'

import type { Layout } from './TopBar'

export interface DocRequest {
  id: number
  doc: DocRef
}

export interface RunRequest {
  id: number
  path: string
}

/** Agent 面板：属于某个对话。对话切换时保持挂载，正在运行的 Agent 不会被中止。 */
export function AgentLayer({
  task,
  conversationId,
  conversationTitle,
  settings,
  seed,
  onRevealPreview,
  onRunningChange,
  onOpenSettings,
  onSendToAgent,
  onOpenDoc,
  onRequestRun,
}: {
  task: Task
  conversationId: string
  conversationTitle: string
  settings: ApiSettings
  seed: AgentSeed | null
  onRevealPreview: () => void
  onRunningChange: (running: boolean) => void
  onOpenSettings: () => void
  onSendToAgent: (text: string) => void
  onOpenDoc: (doc: DocRef) => void
  onRequestRun: (path: string) => void
}) {
  return (
    <AgentPanel
      task={task}
      conversationId={conversationId}
      conversationTitle={conversationTitle}
      settings={settings}
      seed={seed}
      onRunningChange={onRunningChange}
      onOpenSettings={onOpenSettings}
      onSendToAgent={onSendToAgent}
      onOpenDoc={(doc) => { onOpenDoc(doc); onRevealPreview() }}
      onRequestRun={(path) => { onRequestRun(path); onRevealPreview() }}
    />
  )
}

/** 试玩面板：属于某个工作空间。切换对话或空间都不卸载 iframe，运行状态得以保留。 */
export function PreviewLayer({
  task,
  settings,
  docRequest,
  runRequest,
  onSendToAgent,
  onCloseDoc,
  onConsumeRunRequest,
}: {
  task: Task
  settings: ApiSettings
  docRequest: DocRequest | null
  runRequest: RunRequest | null
  onSendToAgent: (text: string) => void
  onCloseDoc: () => void
  onConsumeRunRequest: () => void
}) {
  return (
    <PreviewPanel
      task={task}
      settings={settings}
      onSendToAgent={onSendToAgent}
      docRequest={docRequest}
      onCloseDoc={onCloseDoc}
      runRequest={runRequest}
      onConsumeRunRequest={onConsumeRunRequest}
    />
  )
}

/**
 * 两个工作面的布局外壳。agent / preview 由 App 传入已经常驻挂载的层，
 * 这里只负责分栏、手机切换和多标签提示，不拥有任何对话或空间状态。
 */
export function Workbench({
  taskId,
  uiSettings,
  layout: maxMode,
  onSaveUi,
  agent,
  preview,
}: {
  taskId: string
  uiSettings: UiSettings
  layout: Layout
  onSaveUi: (settings: UiSettings) => void
  agent: React.ReactNode
  preview: React.ReactNode
}) {
  const [ratio, setRatio] = useState(uiSettings.splitRatio || 0.46)
  const tab = uiSettings.mobileTab
  const [peerCount, setPeerCount] = useState(0)
  const [remoteChanges, setRemoteChanges] = useState(0)
  const splitRef = useRef<HTMLDivElement>(null)
  const ratioRef = useRef(ratio)
  ratioRef.current = ratio

  useEffect(() => {
    setRemoteChanges(0)
    tabSync.setTask(taskId)
    setPeerCount(tabSync.getPeers().length)
    const offPeers = tabSync.subscribe(() => setPeerCount(tabSync.getPeers().length))
    const offFiles = tabSync.subscribeFiles((changedTask) => {
      if (changedTask === taskId) setRemoteChanges((n) => n + 1)
    })
    return () => {
      offPeers()
      offFiles()
    }
  }, [taskId])

  const onPointerDown = (e: React.PointerEvent) => {
    if (window.innerWidth <= 900 || maxMode !== 'split') return
    e.preventDefault()
    const rect = splitRef.current?.getBoundingClientRect()
    if (!rect) return
    const move = (ev: PointerEvent) => {
      const next = Math.min(0.72, Math.max(0.28, (ev.clientX - rect.left) / rect.width))
      ratioRef.current = next
      setRatio(next)
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.body.classList.remove('dragging')
      onSaveUi({ ...uiSettings, splitRatio: ratioRef.current })
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.body.classList.add('dragging')
  }

  return (
    <div className={`workbench max-${maxMode}`}>
      {peerCount > 0 ? (
        <div className="banner banner-warn tab-sync-banner">
          <Icon name="warning" size={15} />
          <span>
            检测到 {peerCount + 1} 个标签页同时打开此工作空间。同空间写入会排队，但其他标签页的改动不会自动合并
            {remoteChanges > 0 ? `；另一个标签页已修改 ${remoteChanges} 次文件` : ''}。
          </span>
          <button className="btn btn-small btn-ghost" onClick={() => window.location.reload()}>
            重新载入
          </button>
        </div>
      ) : null}

      <div
        className="split"
        ref={splitRef}
        style={
          maxMode === 'split'
            ? { gridTemplateColumns: `${(ratio * 100).toFixed(2)}% 6px minmax(0, 1fr)` }
            : { gridTemplateColumns: 'minmax(0, 1fr)' }
        }
      >
        <div className={`pane pane-agent ${tab === 'agent' ? 'mobile-show' : 'mobile-hide'}`}>{agent}</div>
        <div className="splitter" onPointerDown={onPointerDown} role="separator" aria-label="调整 Agent 与试玩宽度" aria-orientation="vertical" tabIndex={0}
          aria-valuemin={28} aria-valuemax={72} aria-valuenow={Math.round(ratio * 100)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            const next = Math.min(0.72, Math.max(0.28, ratio + (e.key === 'ArrowRight' ? 0.04 : -0.04)))
            setRatio(next)
            onSaveUi({ ...uiSettings, splitRatio: next })
          }}>
          <span />
        </div>
        <div className={`pane pane-preview ${tab === 'preview' ? 'mobile-show' : 'mobile-hide'}`}>{preview}</div>
      </div>
    </div>
  )
}
