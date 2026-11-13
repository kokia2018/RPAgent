import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPreviewFocus, getPreviewFocus, resetPreviewFocus, setPreviewFocus, subscribePreviewFocus } from './focus'

beforeEach(() => resetPreviewFocus())

describe('试玩窗口聚焦', () => {
  it('记录最后聚焦的窗口并通知订阅方', () => {
    const listener = vi.fn()
    const off = subscribePreviewFocus(listener)
    setPreviewFocus('task-a', 'pv-1')
    expect(getPreviewFocus()).toEqual({ taskId: 'task-a', sessionId: 'pv-1' })
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })

  it('同一个窗口重复聚焦不重复通知', () => {
    setPreviewFocus('task-a', 'pv-1')
    const listener = vi.fn()
    subscribePreviewFocus(listener)
    setPreviewFocus('task-a', 'pv-1')
    expect(listener).not.toHaveBeenCalled()
  })

  it('关闭指定窗口才清除，别的窗口不受影响', () => {
    setPreviewFocus('task-a', 'pv-1')
    clearPreviewFocus('pv-2')
    expect(getPreviewFocus()?.sessionId).toBe('pv-1')
    clearPreviewFocus('pv-1')
    expect(getPreviewFocus()).toBeNull()
  })
})
