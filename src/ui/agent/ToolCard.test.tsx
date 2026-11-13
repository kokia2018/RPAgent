import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolCard } from './ToolCard'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

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

function render(node: React.ReactNode) {
  const root = createRoot(host)
  act(() => {
    root.render(node)
  })
  return root
}

describe('ToolCard 折叠', () => {
  it('默认折叠成一行，标题里带工具名与路径', () => {
    render(
      <ToolCard
        name="fs_read"
        argsText={JSON.stringify({ path: '/index.html' })}
        resultText={JSON.stringify({ success: true, data: { path: '/index.html', bytes: 120 } })}
        status="ok"
        durationMs={35}
      />,
    )
    const card = host.querySelector('details.tool-card') as HTMLDetailsElement
    expect(card).toBeTruthy()
    expect(card.open).toBe(false)
    const summary = card.querySelector('summary.tool-head')!
    expect(summary.textContent).toContain('读文件')
    expect(summary.textContent).toContain('/index.html')
    // 展开内容（结果与参数）不占折叠态的高度
    expect(card.querySelector('.tool-body')).toBeTruthy()
  })

  it('失败的调用自动展开，错误原因可见', () => {
    render(
      <ToolCard
        name="fs_edit"
        argsText={JSON.stringify({ path: '/a.html' })}
        resultText={JSON.stringify({ success: false, error: { message: '找不到要替换的文本' } })}
        status="error"
      />,
    )
    const card = host.querySelector('details.tool-card') as HTMLDetailsElement
    expect(card.open).toBe(true)
    expect(card.textContent).toContain('找不到要替换的文本')
  })

  it('没有参数与结果时不渲染空壳内容区', () => {
    render(<ToolCard name="finish" status="running" />)
    const card = host.querySelector('details.tool-card') as HTMLDetailsElement
    expect(card.open).toBe(false)
    expect(card.querySelector('.tool-body')).toBeNull()
    expect(card.textContent).toContain('完成任务')
  })
})
