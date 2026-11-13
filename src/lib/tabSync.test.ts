import { describe, expect, it } from 'vitest'
import { TabSync, type BroadcastChannelLike } from './tabSync'

const hubs = new Map<string, Set<FakeChannel>>()

class FakeChannel implements BroadcastChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null = null
  constructor(private name: string) {
    if (!hubs.has(name)) hubs.set(name, new Set())
    hubs.get(name)!.add(this)
  }
  postMessage(data: unknown): void {
    for (const other of hubs.get(this.name) || []) {
      if (other === this) continue
      queueMicrotask(() => other.onmessage?.({ data }))
    }
  }
  close(): void {
    hubs.get(this.name)?.delete(this)
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const hubNames = new WeakMap<object, string>()

/** 同一个 clock 视为同一组标签页，共享一个通道名。 */
function makeSync(label: string, clock: { now: number }) {
  let hub = hubNames.get(clock)
  if (!hub) {
    hub = `hub-${Math.random().toString(36).slice(2)}`
    hubNames.set(clock, hub)
  }
  return new TabSync(hub, {
    channelFactory: (channelName) => new FakeChannel(channelName),
    now: () => clock.now,
    heartbeatMs: 0,
  })
}

describe('多标签页并发检测', () => {
  it('同一任务的标签页互相可见', async () => {
    const clock = { now: 1000 }
    const a = makeSync('t1-a', clock)
    const b = makeSync('t1-b', clock)
    a.setTask('task-1')
    b.setTask('task-1')
    await flush()
    await flush()
    expect(a.getPeers()).toHaveLength(1)
    expect(b.getPeers()).toHaveLength(1)
    a.dispose()
    b.dispose()
  })

  it('切换任务后旧 peer 会被移除', async () => {
    const clock = { now: 1000 }
    const a = makeSync('t2-a', clock)
    const b = makeSync('t2-b', clock)
    a.setTask('task-1')
    b.setTask('task-1')
    await flush()
    await flush()
    expect(a.getPeers()).toHaveLength(1)
    b.setTask('task-2')
    await flush()
    await flush()
    expect(a.getPeers()).toHaveLength(0)
    a.dispose()
    b.dispose()
  })

  it('不同任务的标签页不会互相打扰', async () => {
    const clock = { now: 1000 }
    const a = makeSync('t3-a', clock)
    const b = makeSync('t3-b', clock)
    a.setTask('task-1')
    b.setTask('task-2')
    await flush()
    await flush()
    expect(a.getPeers()).toHaveLength(0)
    a.dispose()
    b.dispose()
  })

  it('文件变更会广播给其他标签页', async () => {
    const clock = { now: 1000 }
    const a = makeSync('t4-a', clock)
    const b = makeSync('t4-b', clock)
    a.setTask('task-1')
    b.setTask('task-1')
    await flush()
    await flush()
    const received: { taskId: string; path?: string }[] = []
    b.subscribeFiles((taskId, path) => received.push({ taskId, path }))
    a.notifyFilesChanged('/index.html')
    await flush()
    expect(received).toEqual([{ taskId: 'task-1', path: '/index.html' }])
    a.dispose()
    b.dispose()
  })

  it('超过 TTL 的 peer 会被过滤', async () => {
    const clock = { now: 1000 }
    const a = makeSync('t5-a', clock)
    const b = makeSync('t5-b', clock)
    a.setTask('task-1')
    b.setTask('task-1')
    await flush()
    await flush()
    expect(a.getPeers()).toHaveLength(1)
    clock.now += 40_000
    expect(a.getPeers()).toHaveLength(0)
    a.dispose()
    b.dispose()
  })

  it('环境没有 BroadcastChannel 时保持安静失败', () => {
    const silent = new TabSync('t5-silent', { channelFactory: () => null, heartbeatMs: 0 })
    silent.setTask('task-1')
    expect(silent.getPeers()).toEqual([])
    expect(() => silent.notifyFilesChanged()).not.toThrow()
    silent.dispose()
  })

  it('关闭标签页会通知其他标签页', async () => {
    const clock = { now: 1000 }
    const a = makeSync('t6-a', clock)
    const b = makeSync('t6-b', clock)
    a.setTask('task-1')
    b.setTask('task-1')
    await flush()
    await flush()
    expect(a.getPeers()).toHaveLength(1)
    b.dispose()
    await flush()
    expect(a.getPeers()).toHaveLength(0)
    a.dispose()
  })
})
