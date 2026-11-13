import { useSyncExternalStore } from 'react'
import { db } from '../../db/db'
import { previewManager } from '../../preview/manager'
import { getPreviewFocus, setPreviewFocus, subscribePreviewFocus } from '../../preview/focus'
import { useLiveQueryValue } from '../hooks'
import { Icon } from '../icons'

/**
 * 试玩窗口标签栏：跨工作空间的全局列表。
 *
 * 试玩被当作独立程序（像浏览器标签）：任意窗口可以同时存在，
 * 点标签只是"把前台切到那个窗口"，与当前是哪个对话无关。
 */
export function PreviewTabs() {
  const focus = useSyncExternalStore(subscribePreviewFocus, getPreviewFocus, getPreviewFocus)
  const sessions = useLiveQueryValue(
    async () => (await db.previewSessions.toArray()).filter((s) => s.status !== 'closed').sort((a, b) => a.createdAt - b.createdAt),
    [],
    [],
  )
  const tasks = useLiveQueryValue(() => db.tasks.toArray(), [], [])

  if (sessions.length <= 1) return null

  const titleOf = (taskId: string) => tasks.find((t) => t.id === taskId)?.title || '未命名空间'

  return (
    <div className="preview-windows" role="tablist" aria-label="试玩窗口">
      {sessions.map((session) => {
        const focused = focus?.sessionId === session.id
        return (
          <div
            key={session.id}
            className={`preview-window ${focused ? 'is-active' : ''} ${session.status === 'error' ? 'is-error' : ''}`}
            role="tab"
            aria-selected={focused}
            tabIndex={0}
            title={`${titleOf(session.taskId)} · ${session.entryPath}`}
            onClick={() => setPreviewFocus(session.taskId, session.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setPreviewFocus(session.taskId, session.id)
              }
            }}
          >
            <span className="preview-window-name">{session.name}</span>
            <span className="preview-window-space">{titleOf(session.taskId)}</span>
            <button
              className="preview-window-close"
              aria-label={`关闭 ${session.name}`}
              onClick={(e) => {
                e.stopPropagation()
                void previewManager.close(session.id)
              }}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
