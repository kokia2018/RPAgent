import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageList, type RunView } from './MessageList'
import type { MessageRecord } from '../../db/types'

let host: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  act(() => {
    host.remove()
  })
})

function liveRun(notes: RunView['notes']): RunView {
  return { runId: 'r1', status: 'running', text: '', tools: [], notes, rounds: 3, maxRounds: 60 }
}

function renderList(live: RunView | null, messages: MessageRecord[] = []) {
  const root = createRoot(host)
  act(() => {
    root.render(<MessageList messages={messages} live={live} todos={[]} onSuggestion={() => {}} />)
  })
  return root
}

describe('运行提示折叠', () => {
  it('多条重复提示只显示一个折叠行', () => {
    const notes = Array.from({ length: 7 }, (_, i) => ({
      kind: 'warning' as const,
      message: i === 6 ? '试玩已更新到 build 100。' : '试玩已更新到 build 99。',
    }))
    renderList(liveRun(notes))
    const groups = host.querySelectorAll('details.run-notes')
    expect(groups).toHaveLength(1)
    const details = groups[0] as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('.run-notes-title')?.textContent).toBe('运行提示 7 条')
    // 折叠标题直接显示最近一条，不用展开也知道发生了什么
    expect(details.querySelector('.run-notes-preview')?.textContent).toBe('试玩已更新到 build 100。')
    const items = [...details.querySelectorAll('.run-note')].map((n) => n.textContent?.trim())
    expect(items).toHaveLength(1)
    expect(items[0]).toContain('试玩已自动更新 7 次（最新 build 100）')
  })

  it('有错误时标题按错误配色，并优先展示错误文案', () => {
    renderList(
      liveRun([
        { kind: 'warning', message: '试玩已更新到 build 1。' },
        { kind: 'error', message: '模型请求失败' },
      ]),
    )
    const details = host.querySelector('details.run-notes') as HTMLDetailsElement
    expect(details.classList.contains('is-error')).toBe(true)
    expect(details.querySelector('.run-notes-preview')?.textContent).toBe('模型请求失败')
  })

  it('轮数显示带上限', () => {
    renderList(liveRun([]))
    expect(host.querySelector('.run-status')?.textContent).toContain('第 3/60 轮')
  })

  it('没有提示时不渲染折叠块', () => {
    renderList(liveRun([]))
    expect(host.querySelector('details.run-notes')).toBeNull()
  })
})
