import { useEffect, useRef, useState } from 'react'
import type { Task, UiSettings } from '../db/types'
import { Icon } from './icons'

export type Pane = UiSettings['mobileTab']
export type Layout = Pane | 'split'
type Theme = 'green' | 'mist'

function readTheme(): Theme {
  try { return localStorage.getItem('rpagent-theme') === 'mist' ? 'mist' : 'green' }
  catch { return 'green' }
}

export function TopBar({ task, conversationTitle, active, split, onPane, onSplit, onOpenTasks, onLibrary, onSettings, onCreateTask }: {
  task?: Task
  conversationTitle?: string
  active: Pane | null
  split: boolean
  onPane: (pane: Pane) => void
  onSplit: () => void
  onOpenTasks: () => void
  onLibrary: () => void
  onSettings: () => void
  onCreateTask: () => void
}) {
  const [menu, setMenu] = useState(false)
  const [theme, setTheme] = useState<Theme>(readTheme)
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  const setThemeAndPersist = (next: Theme) => {
    setTheme(next)
    try { localStorage.setItem('rpagent-theme', next) } catch { /* Theme remains active for this page. */ }
  }
  const menuRef = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!menu) return
    const outside = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [menu])
  const choose = (fn: () => void) => { setMenu(false); fn() }
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand" aria-label="青雾创作室 RPAgent">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span className="brand-name">RPAgent</span>
        </div>
        <nav className="topbar-nav primary-panes" aria-label="工作区切换">
          {(['agent', 'preview'] as const).map((pane) => (
            <button key={pane} className={active === pane ? 'is-active' : ''} aria-pressed={active === pane} onClick={() => choose(() => onPane(pane))}>
              <Icon name={pane} size={15} /> {pane === 'agent' ? 'Agent' : '试玩'}
            </button>
          ))}
        </nav>
      </div>
      <div className="topbar-right">
        {!split && task && <button className="chip split-restore" onClick={onSplit}>左右分栏</button>}
        <button className="task-switch" onClick={onOpenTasks} title={task ? `对话「${conversationTitle || ''}」· 工作空间「${task.title}」` : '对话列表'}>
          <span>{conversationTitle || task?.title || '对话列表'}</span><Icon name="chevron" size={12} className="task-switch-chevron" />
        </button>
        <div className="secondary-menu" ref={menuRef}>
          <button ref={trigger} className="icon-btn" aria-label="更多操作" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="more" /></button>
          {menu && <div className="menu-sheet">
            <div className="theme-switch" role="group" aria-label="界面主题">
              <button className={theme === 'green' ? 'is-selected' : ''} aria-pressed={theme === 'green'} onClick={() => setThemeAndPersist('green')}>青雾绿</button>
              <button className={theme === 'mist' ? 'is-selected' : ''} aria-pressed={theme === 'mist'} onClick={() => setThemeAndPersist('mist')}>雾紫樱粉</button>
            </div>
            <button onClick={() => choose(onCreateTask)}><Icon name="plus" size={15} />新建对话</button>
            <button onClick={() => choose(onLibrary)}><Icon name="book" size={15} />常用资料</button>
            <button onClick={() => choose(onSettings)}><Icon name="settings" size={15} />设置</button>
          </div>}
        </div>
      </div>
    </header>
  )
}
