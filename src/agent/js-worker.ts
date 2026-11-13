/// <reference lib="webworker" />

interface JsRunRequest {
  code: string
  inputs?: Record<string, string>
}

interface JsRunResponse {
  ok: boolean
  result?: unknown
  error?: string
  logs: string[]
}

const ctx = self as unknown as DedicatedWorkerGlobalScope

function safeValue(value: unknown): unknown {
  try {
    if (value === undefined) return null
    const json = JSON.stringify(value)
    if (json === undefined) return String(value)
    return JSON.parse(json)
  } catch {
    return String(value)
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack || a.message
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

ctx.onmessage = async (event: MessageEvent<JsRunRequest>) => {
  const data = event.data || { code: '' }
  const logs: string[] = []
  const fakeConsole = {
    log: (...args: unknown[]) => logs.push(formatArgs(args)),
    info: (...args: unknown[]) => logs.push(formatArgs(args)),
    warn: (...args: unknown[]) => logs.push('[warn] ' + formatArgs(args)),
    error: (...args: unknown[]) => logs.push('[error] ' + formatArgs(args)),
    debug: (...args: unknown[]) => logs.push(formatArgs(args)),
  }
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (inputs: Record<string, string>, console: typeof fakeConsole) => Promise<unknown>
    const fn = new AsyncFunction('inputs', 'console', data.code)
    const result = await fn(data.inputs || {}, fakeConsole)
    ctx.postMessage({ ok: true, result: safeValue(result), logs } satisfies JsRunResponse)
  } catch (e) {
    ctx.postMessage({
      ok: false,
      error: String((e as Error)?.stack || (e as Error)?.message || e),
      logs,
    } satisfies JsRunResponse)
  }
}
