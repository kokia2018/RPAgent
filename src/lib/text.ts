/** 文本截断、脱敏与格式化。 */

export function truncate(text: string, max: number, note = '\n...[已截断]'): string {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max)) + note
}

export function redactSecrets(text: string): string {
  if (!text) return ''
  return String(text)
    .replace(/\bsk-[A-Za-z0-9._:-]{8,}/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._:-]{8,}/gi, 'Bearer ***')
    .replace(
      /\b(api[_-]?key|apikey|access[_-]?token|token|secret)\b(\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
      '$1$2***',
    )
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    for (const key of Array.from(u.searchParams.keys())) {
      if (/key|token|secret|auth|password|sign/i.test(key)) u.searchParams.set(key, '***')
    }
    return u.toString()
  } catch {
    return redactSecrets(url)
  }
}

export function byteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function countLines(text: string): number {
  if (!text) return 0
  return text.split(/\r\n|\r|\n/).length
}

export function lineSlice(text: string, startLine?: number, endLine?: number): string {
  if (!startLine && !endLine) return text
  const lines = text.split(/\r\n|\r|\n/)
  const start = Math.max(1, startLine || 1)
  const end = Math.max(start, Math.min(lines.length, endLine || lines.length))
  return lines.slice(start - 1, end).join('\n')
}

export function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(ts)
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}
