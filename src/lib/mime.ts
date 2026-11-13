/** 常见 MIME 推断。文件实际形态仍以内容与解析结果为准。 */

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
}

export function mimeFromPath(path: string): string {
  const lower = String(path || '').toLowerCase()
  const i = lower.lastIndexOf('.')
  if (i < 0) return 'application/octet-stream'
  return MIME_BY_EXT[lower.slice(i)] || 'application/octet-stream'
}

const TEXT_MIME_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'image/svg+xml',
  'application/x-yaml',
]

export function isTextMime(mime: string): boolean {
  const m = String(mime || '').toLowerCase()
  return TEXT_MIME_PREFIXES.some((p) => m.startsWith(p))
}

export function isTextPath(path: string): boolean {
  return isTextMime(mimeFromPath(path))
}

export function isImagePath(path: string): boolean {
  return /^image\//.test(mimeFromPath(path))
}
