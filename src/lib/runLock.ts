const heldLocally = new Set<string>()
const queues = new Map<string, Promise<void>>()
export const agentRunLock = (taskId: string) => `rpagent:agent-run:${taskId}`

export async function withAgentRunLock<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  if (heldLocally.has(taskId)) throw new Error('此空间的 Agent 已在运行，请先停止或等待完成。')
  heldLocally.add(taskId)
  try {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return await navigator.locks.request(agentRunLock(taskId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('另一个标签页正在修改此空间，请等待完成。')
        return work()
      })
    }
    return await work()
  } finally { heldLocally.delete(taskId) }
}

export async function queueWorkspaceRun<T>(taskId: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(taskId) || Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => gate)
  queues.set(taskId, tail)
  let abort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException('排队任务已停止', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    await Promise.race([previous.catch(() => undefined), aborted])
    if (signal.aborted) throw new DOMException('任务已停止', 'AbortError')
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return await navigator.locks.request(agentRunLock(taskId), { signal }, async () => {
        if (signal.aborted) throw new DOMException('任务已停止', 'AbortError')
        heldLocally.add(taskId)
        try { return await work() } finally { heldLocally.delete(taskId) }
      })
    }
    heldLocally.add(taskId)
    try { return await work() } finally { heldLocally.delete(taskId) }
  } finally {
    signal.removeEventListener('abort', abort)
    release()
    void tail.finally(() => { if (queues.get(taskId) === tail) queues.delete(taskId) })
  }
}

export function isWorkspaceRunning(taskId: string): boolean { return heldLocally.has(taskId) }

export async function ifAgentRunInactive(taskId: string, work: () => Promise<void>): Promise<void> {
  if (heldLocally.has(taskId)) return
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return
  await navigator.locks.request(agentRunLock(taskId), { ifAvailable: true }, async (lock) => { if (lock) await work() })
}
