/** 项目内路径规范化与隔离。所有工具只使用项目相对路径，并绑定 taskId。 */

const MAX_PATH_LENGTH = 500

export function normalizePath(input: string): string {
  if (typeof input !== 'string') throw new Error('路径必须是字符串')
  let raw = input.trim().replace(/\\/g, '/')
  if (!raw) return '/'
  if (raw.includes('\0')) throw new Error('路径包含非法字符')
  if (raw.length > MAX_PATH_LENGTH) throw new Error('路径过长')
  if (!raw.startsWith('/')) raw = '/' + raw
  raw = raw.replace(/\/+/g, '/')
  const parts: string[] = []
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') throw new Error('路径不允许包含 ..')
    if (seg.includes('/')) throw new Error('路径段非法')
    parts.push(seg)
  }
  const out = '/' + parts.join('/')
  return out === '' ? '/' : out
}

export function isRootPath(path: string): boolean {
  return normalizePath(path) === '/'
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'))
}

export function dirname(path: string): string {
  const p = normalizePath(path)
  if (p === '/') return '/'
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export function basename(path: string): string {
  const p = normalizePath(path)
  if (p === '/') return ''
  return p.slice(p.lastIndexOf('/') + 1)
}

export function extname(path: string): string {
  const name = basename(path)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i).toLowerCase()
}

/** 把相对引用解析成项目内绝对路径；rootAbsolute 以工作区根为基准。允许在根内使用 ..。 */
export function resolveProjectPath(fromFile: string, ref: string): string {
  const clean = ref.split('#')[0].split('?')[0].trim()
  if (!clean) return normalizePath(fromFile)
  if (clean.startsWith('/')) return normalizePath(clean)
  const base = dirname(fromFile).split('/').filter(Boolean)
  for (const seg of clean.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!base.length) throw new Error('引用路径越出工作区根目录')
      base.pop()
    } else {
      base.push(seg)
    }
  }
  return '/' + base.join('/')
}

export function isExternalRef(ref: string): boolean {
  const r = ref.trim()
  return (
    /^https?:\/\//i.test(r) ||
    /^\/\//.test(r) ||
    /^(data|blob|mailto|tel|javascript|about):/i.test(r) ||
    r.startsWith('#')
  )
}

export function isHtmlPath(path: string): boolean {
  return extname(path) === '.html' || extname(path) === '.htm'
}

export function sanitizeFileName(name: string, fallback = 'app'): string {
  const base = String(name || '')
    .replace(/[\\/:*?"<>|\0]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
  return base || fallback
}

/** 把路径拆成树结构所需的段。 */
export function pathSegments(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean)
}
