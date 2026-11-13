import { useState } from 'react'
import type { Conversation, Task } from '../../db/types'
import { formatTime } from '../../lib/text'
import { useDialogFocus } from '../useDialogFocus'
import { Icon } from '../icons'

/** 对话列表：按工作空间分组。对话可随时切到别的工作空间；写入只会落在切换后的那个空间。 */
export function TaskDrawer({
  open,
  tasks,
  conversations,
  currentConversationId,
  isRunning,
  onClose,
  onSelect,
  onCreate,
  onRebind,
  onRename,
  onRenameSpace,
  onDelete,
}: {
  open: boolean
  tasks: Task[]
  conversations: Conversation[]
  currentConversationId: string
  isRunning: (conversationId: string) => boolean
  onClose: () => void
  onSelect: (id: string) => void
  onCreate: (title: string, workspaceId?: string) => Promise<void>
  onRebind: (conversationId: string, workspaceId: string) => Promise<void>
  onRename: (id: string, title: string) => Promise<void>
  onRenameSpace: (id: string, title: string) => Promise<void>
  onDelete: (workspaceId: string) => void
}) {
  const [newTitle, setNewTitle] = useState('')
  const [target, setTarget] = useState('')
  const [editing, setEditing] = useState<{ kind: 'conversation' | 'space'; id: string; title: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose)

  if (!open) return null

  const submitNew = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onCreate(newTitle.trim() || '新对话', target || undefined)
      setNewTitle('')
    } finally {
      setBusy(false)
    }
  }

  const submitRename = async () => {
    if (!editing) return
    const title = editing.title.trim()
    if (title) await (editing.kind === 'space' ? onRenameSpace(editing.id, title) : onRename(editing.id, title))
    setEditing(null)
  }

  const renameInput = (
    <input
      className="input task-rename"
      value={editing?.title || ''}
      autoFocus
      aria-label="新名称"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setEditing((v) => (v ? { ...v, title: e.target.value } : v))}
      onBlur={() => void submitRename()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void submitRename()
        if (e.key === 'Escape') setEditing(null)
      }}
    />
  )

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={dialogRef} tabIndex={-1} className="task-drawer" role="dialog" aria-modal="true" aria-label="对话与工作空间">
        <div className="drawer-head">
          <div>
            <h2>对话</h2>
            <p>对话属于一个工作空间（写入落在那里）；随时可以切到别的空间，运行中的 Agent 会在下一轮使用新空间。试玩窗口是独立程序，不受对话切换影响。</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </div>

        <div className="task-create">
          <input
            className="input"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="新对话标题（可留空）"
            aria-label="新对话标题"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitNew()
            }}
          />
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="新对话使用的工作空间">
            <option value="">新建工作空间</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
          <button className="btn btn-primary btn-small" onClick={() => void submitNew()} disabled={busy}>
            <Icon name="plus" size={13} /> 新建
          </button>
        </div>

        <div className="task-list">
          {tasks.length ? tasks.map((space) => {
            const items = conversations.filter((c) => c.workspaceId === space.id)
            return (
              <section key={space.id} className="space-group" aria-label={`工作空间：${space.title}`}>
                <div className="space-group-head">
                  {editing?.kind === 'space' && editing.id === space.id ? renameInput : (
                    <span className="space-group-title"><Icon name="file" size={13} /> {space.title}</span>
                  )}
                  <div className="task-item-actions">
                    <button className="icon-btn" title="重命名空间" aria-label={`重命名空间 ${space.title}`}
                      onClick={() => setEditing({ kind: 'space', id: space.id, title: space.title })}>
                      <Icon name="edit" size={13} />
                    </button>
                    <button className="icon-btn" title="删除空间" aria-label={`删除空间 ${space.title}`} onClick={() => onDelete(space.id)}>
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
                {items.length ? items.map((c) => {
                  const runningNow = isRunning(c.id)
                  return (
                    <div key={c.id} className={`task-item ${c.id === currentConversationId ? 'is-active' : ''}`}>
                      {editing?.kind === 'conversation' && editing.id === c.id ? <div className="task-item-main">{renameInput}</div> : (
                        <button className="task-item-main" onClick={() => onSelect(c.id)} aria-current={c.id === currentConversationId}>
                          <span className={`status-dot ${runningNow ? 'warn' : 'ok'}`} aria-hidden="true" />
                          <span className="task-item-text">
                            <span className="task-item-title">{c.title}</span>
                            <span className="task-item-meta">{runningNow ? '运行中 · ' : ''}{formatTime(c.updatedAt)}</span>
                          </span>
                        </button>
                      )}
                      <div className="task-item-actions">
                        <select className="input input-small" value={c.workspaceId}
                          title="切换这个对话的工作空间" aria-label={`把对话 ${c.title} 切到工作空间`}
                          onChange={(e) => void onRebind(c.id, e.target.value)}>
                          {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                        </select>
                        <button className="icon-btn" title="重命名对话" aria-label={`重命名对话 ${c.title}`}
                          onClick={() => setEditing({ kind: 'conversation', id: c.id, title: c.title })}>
                          <Icon name="edit" size={13} />
                        </button>
                      </div>
                    </div>
                  )
                }) : <p className="empty-hint">这个空间还没有对话。</p>}
              </section>
            )
          }) : <p className="empty-hint">还没有工作空间。新建一个对话开始。</p>}
        </div>

        <div className="drawer-foot">
          <Icon name="book" size={13} />
          <span>不同空间的文件、试玩窗口和作品存档互不混用；同空间的写入会排队执行。</span>
        </div>
      </aside>
    </div>
  )
}
