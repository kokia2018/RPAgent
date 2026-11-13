/** 多标签页并发检测。
 *
 * 浏览器里同一个任务被两个标签页同时编辑时，IndexedDB 写入是「最后写入生效」，
 * 不会自动合并。这里不假装做合并，而是：
 * 1. 让同一任务的标签页互相感知；
 * 2. 广播文件变更，用于提示刷新；
 * 3. 关闭标签页时显式告别，避免留下幽灵 peer。
 *
 * 通过可注入的 channel 工厂与时钟，便于单测。
 */

export interface BroadcastChannelLike {
  postMessage(data: unknown): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}

export interface TabPeer {
  tabId: string
  taskId: string
  at: number
}

interface TabMessage {
  type: 'hello' | 'here' | 'bye' | 'files'
  tabId: string
  taskId: string
  path?: string
  at: number
}

export interface TabSyncOptions {
  channelFactory?: (name: string) => BroadcastChannelLike | null
  now?: () => number
  heartbeatMs?: number
  /** peer 超过该时间没有心跳就丢弃 */
  ttlMs?: number
}

function defaultFactory(name: string): BroadcastChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    return new BroadcastChannel(name) as unknown as BroadcastChannelLike
  } catch {
    return null
  }
}

export class TabSync {
  private readonly channelName: string
  private readonly now: () => number
  private readonly heartbeatMs: number
  private readonly ttlMs: number
  private channel: BroadcastChannelLike | null = null
  private channelFactory: (name: string) => BroadcastChannelLike | null
  private taskId = ''
  private tabId = `tab_${Math.random().toString(36).slice(2, 10)}`
  private peers = new Map<string, TabPeer>()
  private peerListeners = new Set<() => void>()
  private fileListeners = new Set<(taskId: string, path?: string) => void>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(name = 'rpagent-tabs', options: TabSyncOptions = {}) {
    this.channelName = name
    this.channelFactory = options.channelFactory || defaultFactory
    this.now = options.now || (() => Date.now())
    this.heartbeatMs = options.heartbeatMs ?? 10_000
    this.ttlMs = options.ttlMs ?? 35_000
  }

  get currentTabId(): string {
    return this.tabId
  }

  setTask(taskId: string): void {
    if (taskId === this.taskId && this.channel) return
    if (this.taskId) this.post({ type: 'bye', taskId: this.taskId })
    this.taskId = taskId
    this.ensureChannel()
    this.peers.clear()
    this.post({ type: 'hello', taskId })
    this.startHeartbeat()
    this.emit()
  }

  clearTask(): void {
    if (!this.taskId) return
    this.post({ type: 'bye', taskId: this.taskId })
    this.taskId = ''
    this.peers.clear()
    this.stopHeartbeat()
    this.emit()
  }

  /** 当前任务的其他标签页（已按 TTL 过滤）。 */
  getPeers(): TabPeer[] {
    const now = this.now()
    for (const [id, peer] of this.peers) {
      if (now - peer.at > this.ttlMs) this.peers.delete(id)
    }
    return Array.from(this.peers.values()).filter((peer) => peer.taskId === this.taskId)
  }

  subscribe(listener: () => void): () => void {
    this.peerListeners.add(listener)
    return () => this.peerListeners.delete(listener)
  }

  subscribeFiles(listener: (taskId: string, path?: string) => void): () => void {
    this.fileListeners.add(listener)
    return () => this.fileListeners.delete(listener)
  }

  notifyFilesChanged(path?: string): void {
    if (!this.taskId) return
    this.post({ type: 'files', taskId: this.taskId, path })
  }

  dispose(): void {
    this.clearTask()
    this.stopHeartbeat()
    if (this.channel) {
      this.channel.onmessage = null
      this.channel.close()
      this.channel = null
    }
    this.peerListeners.clear()
    this.fileListeners.clear()
  }

  private ensureChannel(): void {
    if (this.channel) return
    this.channel = this.channelFactory(this.channelName)
    if (!this.channel) return
    this.channel.onmessage = (event) => this.handle(event.data)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    if (typeof setInterval === 'undefined' || this.heartbeatMs <= 0) return
    this.timer = setInterval(() => {
      if (!this.taskId) return
      this.post({ type: 'hello', taskId: this.taskId })
      this.peers = new Map(Array.from(this.peers).filter(([, peer]) => this.now() - peer.at <= this.ttlMs))
      this.emit()
    }, this.heartbeatMs)
  }

  private stopHeartbeat(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private post(message: Omit<TabMessage, 'tabId' | 'at'>): void {
    if (!this.channel) return
    this.channel.postMessage({ ...message, tabId: this.tabId, at: this.now() } satisfies TabMessage)
  }

  private handle(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Partial<TabMessage>
    if (!message.tabId || message.tabId === this.tabId) return
    if (typeof message.type !== 'string') return
    const at = typeof message.at === 'number' ? message.at : this.now()

    if (message.type === 'bye') {
      if (this.peers.delete(message.tabId)) this.emit()
      return
    }

    if (message.type === 'files') {
      if (!message.taskId || message.taskId !== this.taskId) return
      for (const listener of this.fileListeners) listener(message.taskId, message.path)
      return
    }

    if (!message.taskId) return
    if (message.type === 'hello') {
      if (message.taskId === this.taskId) {
        this.peers.set(message.tabId, { tabId: message.tabId, taskId: message.taskId, at })
        this.post({ type: 'here', taskId: this.taskId })
        this.emit()
      }
      return
    }

    if (message.type === 'here' && message.taskId === this.taskId) {
      this.peers.set(message.tabId, { tabId: message.tabId, taskId: message.taskId, at })
      this.emit()
    }
  }

  private emit(): void {
    for (const listener of this.peerListeners) listener()
  }
}

export const tabSync = new TabSync()
