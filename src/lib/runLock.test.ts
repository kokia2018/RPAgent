import { afterEach, describe, expect, it, vi } from 'vitest'
import { ifAgentRunInactive, queueWorkspaceRun, withAgentRunLock } from './runLock'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('任务运行所有权', () => {
  it('同空间排队、不同空间并行，取消等待项不执行写入', async () => {
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve }), order: string[] = []
    const first = queueWorkspaceRun('queue-a', new AbortController().signal, async () => { order.push('a1'); await wait })
    await new Promise(resolve => setTimeout(resolve, 0))
    const cancelled = new AbortController(), skipped = vi.fn(async () => undefined)
    const pending = queueWorkspaceRun('queue-a', cancelled.signal, skipped)
    const rejection = expect(pending).rejects.toThrow('停止')
    cancelled.abort(); await rejection
    const second = queueWorkspaceRun('queue-a', new AbortController().signal, async () => { order.push('a2') })
    await queueWorkspaceRun('queue-b', new AbortController().signal, async () => { order.push('b') })
    expect(order).toEqual(['a1', 'b'])
    release(); await Promise.all([first, second])
    expect(order).toEqual(['a1', 'b', 'a2']); expect(skipped).not.toHaveBeenCalled()
  })
  it('同页重复运行被拒绝，正常结束后释放', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const first = withAgentRunLock('a', async () => { await wait; return 1 })
    await expect(withAgentRunLock('a', async () => 2)).rejects.toThrow('已在运行')
    const recovered = vi.fn(async () => undefined)
    await ifAgentRunInactive('a', recovered)
    expect(recovered).not.toHaveBeenCalled()
    release()
    await expect(first).resolves.toBe(1)
    await expect(withAgentRunLock('a', async () => 3)).resolves.toBe(3)
  })
  it('已有跨页锁不接管，不把活跃任务标为中断', async () => {
    const request = vi.fn(async (_name, _opts, callback) => callback(null))
    vi.stubGlobal('navigator', { locks: { request } })
    await expect(withAgentRunLock('b', async () => 1)).rejects.toThrow('另一个标签页')
    const recover = vi.fn(async () => undefined)
    await ifAgentRunInactive('b', recover)
    expect(recover).not.toHaveBeenCalled()
  })
})
