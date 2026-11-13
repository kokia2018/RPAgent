/**
 * 试玩窗口的"当前聚焦"状态。
 *
 * 试玩被设计成独立程序（像浏览器的标签页）：打开哪个窗口、看的是哪个工作空间的页面，
 * 不取决于当前对话。这个模块只保存"用户/Agent 最后聚焦的那个窗口"，
 * 让标签栏、试玩面板、外壳布局三处都能读到同一个值。
 */

export interface PreviewFocus {
  taskId: string
  sessionId: string
}

let current: PreviewFocus | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* 订阅方异常不影响其他订阅方 */
    }
  }
}

export function setPreviewFocus(taskId: string, sessionId: string): void {
  if (current?.taskId === taskId && current.sessionId === sessionId) return
  current = { taskId, sessionId }
  emit()
}

export function clearPreviewFocus(sessionId?: string): void {
  if (!current) return
  if (sessionId && current.sessionId !== sessionId) return
  current = null
  emit()
}

export function getPreviewFocus(): PreviewFocus | null {
  return current
}

export function subscribePreviewFocus(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 测试用：清掉内存态。 */
export function resetPreviewFocus(): void {
  current = null
  listeners.clear()
}
