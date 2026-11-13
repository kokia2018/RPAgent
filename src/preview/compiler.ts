import { parse } from 'es-module-lexer/js'
import { extname, isExternalRef, normalizePath, resolveProjectPath } from '../lib/path'
import { mimeFromPath } from '../lib/mime'

export interface ProjectFile {
  path: string
  mime: string
  size: number
  text?: string
  blob?: Blob
}

export interface ProjectAnalysis {
  ok: boolean
  entryPath: string
  missing: string[]
  moduleIssues: string[]
  external: string[]
  workbenchRefs: string[]
  blobRefs: string[]
  warnings: string[]
  referenced: number
}

export interface InlineCompileResult extends ProjectAnalysis {
  unbundled: string[]
  html: string
  size: number
}

const HTML_REF_TAGS = /<(script|link|img|source|video|audio|iframe|object)\b[^>]*>/gi
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?\s*;?/gi
const SCRIPT_BLOCK_RE = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script\s*>)/gi

function attr(tag: string, name: string): string {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`, 'i')
  const m = tag.match(re)
  if (!m) return ''
  return (m[1] ?? m[2] ?? m[3] ?? '').trim()
}

function tagName(tag: string): string {
  const m = tag.match(/^<\s*([a-zA-Z0-9-]+)/)
  return (m?.[1] || '').toLowerCase()
}

function stripAttrs(tag: string, names: string[]): string {
  let out = tag
  for (const n of names) {
    out = out.replace(
      new RegExp(`\\s${n}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'gi'),
      '',
    )
  }
  return out
}

function setAttr(tag: string, name: string, value: string): string {
  const escaped = value.replace(/"/g, '&quot;')
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i')
  if (re.test(tag)) return tag.replace(re, `$1"${escaped}"`)
  return tag.replace(/\s*\/?>$/, (m) => ` ${name}="${escaped}"${m}`)
}

function isSelfClosing(tag: string): boolean {
  return /\/\s*>$/.test(tag)
}

function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean)
}

function moduleImports(code: string, path: string, issues: Set<string>) {
  const refs: { ref: string; start: number; end: number }[] = []
  try {
    for (const item of parse(code)[0]) {
      if (item.d === -2) continue // import.meta 不是文件引用
      if (item.n === undefined) {
        issues.add(`无法静态确定动态 import：${path}`)
        continue
      }
      // 静态 import 的范围不含引号，动态 import 的范围含引号。
      const quote = item.d >= 0 ? 1 : 0
      refs.push({ ref: item.n, start: item.s + quote, end: item.e - quote })
    }
  } catch {
    issues.add(`无法解析模块引用：${path}`)
  }
  return refs
}

function cssSpecifiers(css: string): string[] {
  const out: string[] = []
  for (const m of css.matchAll(CSS_IMPORT_RE)) out.push(m[2])
  for (const m of css.matchAll(CSS_URL_RE)) out.push(m[2])
  return out
}

async function fileText(file: ProjectFile | undefined): Promise<string> {
  if (!file) return ''
  if (typeof file.text === 'string') return file.text
  if (file.blob) return file.blob.text()
  return ''
}

function mapFiles(files: ProjectFile[]): Map<string, ProjectFile> {
  const map = new Map<string, ProjectFile>()
  for (const f of files) map.set(normalizePath(f.path), f)
  return map
}

function safeResolve(fromPath: string, ref: string, warnings: Set<string>): string | null {
  try {
    return resolveProjectPath(fromPath, ref)
  } catch (e) {
    warnings.add(`引用路径非法：${ref}（${String((e as Error)?.message || e)}）`)
    return null
  }
}

export async function analyzeProject(entryPath: string, files: ProjectFile[]): Promise<ProjectAnalysis> {
  const entry = normalizePath(entryPath)
  const map = mapFiles(files)
  const missing = new Set<string>()
  const external = new Set<string>()
  const workbenchRefs = new Set<string>()
  const blobRefs = new Set<string>()
  const warnings = new Set<string>()
  const moduleIssues = new Set<string>()
  const visited = new Set<string>()
  let referenced = 0

  const entryFile = map.get(entry)
  if (!entryFile) {
    return {
      ok: false,
      entryPath: entry,
      missing: [entry],
      moduleIssues: [],
      external: [],
      workbenchRefs: [],
      blobRefs: [],
      warnings: ['入口文件不存在'],
      referenced: 0,
    }
  }
  if (!/\.html?$/i.test(entry)) {
    warnings.add('入口文件不是 .html，试玩将无法作为网页运行')
  }

  const scanWorkbenchRefs = (text: string) => {
    if (text.includes('/__vfs__/')) workbenchRefs.add('/__vfs__/')
    if (text.includes('__WORKBENCH_PREVIEW__')) workbenchRefs.add('__WORKBENCH_PREVIEW__')
    if (/Workbench\.preview\b/.test(text)) workbenchRefs.add('Workbench.preview')
    if (/window\.Workbench|Workbench\.storage|Workbench\.ai/.test(text)) workbenchRefs.add('Workbench API')
  }

  const visitRef = async (ref: string, fromPath: string, kind: 'css' | 'js' | 'asset' | 'html') => {
    const clean = ref.split('#')[0].split('?')[0].trim()
    if (!clean) return
    if (/^blob:/i.test(clean)) {
      blobRefs.add(clean)
      return
    }
    if (isExternalRef(clean)) {
      if (/^https?:\/\//i.test(clean) || /^\/\//.test(clean)) external.add(clean)
      return
    }
    const resolved = safeResolve(fromPath, clean, warnings)
    if (!resolved) return
    referenced++
    const file = map.get(resolved)
    if (!file) {
      missing.add(resolved)
      return
    }
    if (visited.has(resolved)) return
    visited.add(resolved)

    if (file.size > 8 * 1024 * 1024) {
      warnings.add(`资源较大（${(file.size / 1024 / 1024).toFixed(1)}MB）：${resolved}，内联导出可能失败`)
    }
    if (kind === 'css' || extname(resolved) === '.css') {
      const css = await fileText(file)
      for (const ref2 of cssSpecifiers(css)) await visitRef(ref2, resolved, 'asset')
    } else if (kind === 'js' || /\.(mjs|cjs|jsx|ts|tsx)$/i.test(resolved)) {
      const code = await fileText(file)
      scanWorkbenchRefs(code)
      for (const { ref } of moduleImports(code, resolved, moduleIssues)) await visitRef(ref, resolved, 'js')
    } else if (kind === 'html' || /\.html?$/i.test(resolved)) {
      const html = await fileText(file)
      for (const ref2 of htmlSpecifiers(html, resolved, moduleIssues)) await visitRef(ref2.ref, resolved, ref2.kind)
    }
  }

  const html = await fileText(entryFile)
  scanWorkbenchRefs(html)
  for (const ref of htmlSpecifiers(html, entry, moduleIssues)) await visitRef(ref.ref, entry, ref.kind)

  const result: ProjectAnalysis = {
    ok: missing.size === 0 && moduleIssues.size === 0,
    moduleIssues: Array.from(moduleIssues),
    entryPath: entry,
    missing: Array.from(missing).sort(),
    external: Array.from(external).sort(),
    workbenchRefs: Array.from(workbenchRefs),
    blobRefs: Array.from(blobRefs),
    warnings: [...moduleIssues, ...warnings],
    referenced,
  }
  return result
}

function htmlSpecifiers(html: string, path: string, issues: Set<string>): { ref: string; kind: 'css' | 'js' | 'asset' | 'html' }[] {
  const out: { ref: string; kind: 'css' | 'js' | 'asset' | 'html' }[] = []
  html = html.replace(SCRIPT_BLOCK_RE, (_, open: string, code: string) => {
    if (attr(open, 'type').toLowerCase() === 'module' && !attr(open, 'src')) {
      for (const { ref } of moduleImports(code, path, issues)) out.push({ ref, kind: 'js' })
    }
    return open
  })
  for (const m of html.matchAll(HTML_REF_TAGS)) {
    const tag = m[0]
    const name = tagName(tag)
    const src = attr(tag, 'src')
    const href = attr(tag, 'href')
    const data = attr(tag, 'data')
    const srcset = attr(tag, 'srcset')
    if (name === 'script' && src) out.push({ ref: src, kind: 'js' })
    if (name === 'link') {
      const rel = attr(tag, 'rel').toLowerCase()
      if (href && (rel.includes('stylesheet') || rel.includes('icon') || rel.includes('preload'))) {
        out.push({ ref: href, kind: rel.includes('stylesheet') ? 'css' : 'asset' })
      }
    }
    if ((name === 'img' || name === 'source' || name === 'video' || name === 'audio') && src) {
      out.push({ ref: src, kind: 'asset' })
    }
    if (name === 'source' || name === 'img') {
      for (const u of srcsetUrls(srcset)) out.push({ ref: u, kind: 'asset' })
    }
    if (name === 'iframe' && src) out.push({ ref: src, kind: 'html' })
    if (name === 'object' && data) out.push({ ref: data, kind: 'asset' })
  }
  for (const m of html.matchAll(STYLE_BLOCK_RE)) {
    for (const ref of cssSpecifiers(m[1])) out.push({ ref, kind: 'asset' })
  }
  for (const m of html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) {
    for (const ref of cssSpecifiers(m[1])) out.push({ ref, kind: 'asset' })
  }
  return out
}

/* ───────────────────────── 内联编译（导出 / file:// 降级） ───────────────────────── */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

async function fileToDataUrl(file: ProjectFile): Promise<string> {
  if (file.blob && (!file.text || file.text.length === 0)) {
    const bytes = new Uint8Array(await file.blob.arrayBuffer())
    return `data:${file.blob.type || file.mime || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`
  }
  const text = await fileText(file)
  return `data:${file.mime || mimeFromPath(file.path) || 'text/plain'};base64,${textToBase64(text)}`
}

interface InlineCompileOptions {
  /** 模块正文即将编码为 data URL，之后在 HTML 中不再是明文。 */
  inspectModule?: (source: string) => void
}

interface CompileCtx extends InlineCompileOptions {
  map: Map<string, ProjectFile>
  warnings: Set<string>
  moduleIssues: Set<string>
  moduleCache: Map<string, string>
  cssStack: string[]
  moduleStack: string[]
}

async function inlineCss(css: string, fromPath: string, ctx: CompileCtx): Promise<string> {
  if (ctx.cssStack.includes(fromPath)) {
    ctx.warnings.add(`CSS @import 存在循环：${fromPath}`)
    return css
  }
  ctx.cssStack.push(fromPath)
  let out = css

  const imports = Array.from(out.matchAll(CSS_IMPORT_RE))
  for (const m of imports) {
    const raw = m[0]
    const ref = m[2]
    const clean = ref.split('#')[0].split('?')[0].trim()
    if (!clean || isExternalRef(clean)) continue
    const resolved = safeResolve(fromPath, clean, ctx.warnings)
    if (!resolved) continue
    const file = ctx.map.get(resolved)
    if (!file) {
      ctx.warnings.add(`CSS 引用的文件缺失：${resolved}`)
      continue
    }
    const imported = await inlineCss(await fileText(file), resolved, ctx)
    out = out.split(raw).join(imported)
  }

  const urls = Array.from(out.matchAll(CSS_URL_RE))
  for (const m of urls) {
    const raw = m[0]
    const ref = m[2]
    const clean = ref.split('#')[0].split('?')[0].trim()
    if (!clean || isExternalRef(clean)) continue
    const resolved = safeResolve(fromPath, clean, ctx.warnings)
    if (!resolved) continue
    const file = ctx.map.get(resolved)
    if (!file) {
      ctx.warnings.add(`CSS url() 引用的文件缺失：${resolved}`)
      continue
    }
    const dataUrl = await fileToDataUrl(file)
    out = out.split(raw).join(`url("${dataUrl}")`)
  }

  ctx.cssStack.pop()
  return out
}

async function rewriteModule(code: string, path: string, ctx: CompileCtx): Promise<string> {
  for (const { ref, start, end } of moduleImports(code, path, ctx.moduleIssues).reverse()) {
    if (isExternalRef(ref)) continue
    const dep = safeResolve(path, ref, ctx.moduleIssues)
    if (!dep || !ctx.map.has(dep)) continue
    const url = await moduleDataUrl(dep, ctx)
    code = code.slice(0, start) + url + code.slice(end)
  }
  return code
}

async function moduleDataUrl(path: string, ctx: CompileCtx): Promise<string> {
  const cached = ctx.moduleCache.get(path)
  if (cached) return cached
  const file = ctx.map.get(path)
  if (!file) {
    ctx.warnings.add(`模块缺失：${path}`)
    return `data:text/javascript,export default undefined`
  }
  if (ctx.moduleStack.includes(path)) {
    ctx.moduleIssues.add(`模块存在循环依赖，循环处的相对 import 未能内联：${path}`)
    return `data:text/javascript;base64,${textToBase64(await fileText(file))}`
  }
  ctx.moduleStack.push(path)
  const source = await fileText(file)
  ctx.inspectModule?.(source)
  const code = await rewriteModule(source, path, ctx)
  ctx.moduleStack.pop()
  const dataUrl = `data:text/javascript;base64,${textToBase64(code)}`
  ctx.moduleCache.set(path, dataUrl)
  return dataUrl
}

export async function compileInline(
  entryPath: string,
  files: ProjectFile[],
  options: InlineCompileOptions = {},
): Promise<InlineCompileResult> {
  const analysis = await analyzeProject(entryPath, files)
  const ctx: CompileCtx = {
    ...options,
    map: mapFiles(files),
    warnings: new Set(analysis.warnings),
    moduleIssues: new Set(analysis.moduleIssues),
    moduleCache: new Map(),
    cssStack: [],
    moduleStack: [],
  }
  const entryFile = ctx.map.get(analysis.entryPath)
  if (!entryFile) {
    return { ...analysis, unbundled: [], html: '', size: 0, ok: false }
  }
  let html = await fileText(entryFile)

  // <link rel=stylesheet> → <style>
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = attr(tag, 'rel').toLowerCase()
    if (!rel.includes('stylesheet')) return tag
    const href = attr(tag, 'href')
    if (!href || isExternalRef(href)) return tag
    const resolved = safeResolve(analysis.entryPath, href, ctx.warnings)
    if (!resolved) return tag
    const file = ctx.map.get(resolved)
    if (!file) {
      ctx.warnings.add(`样式文件缺失：${resolved}`)
      return stripAttrs(tag, ['href'])
    }
    return `<!-- inlined: ${resolved} --><link rel="stylesheet" data-inlined-from="${resolved}">`
  })

  // 内联 CSS 需要异步读取，先把占位 link 替换成真正 style
  const cssLinks = Array.from(html.matchAll(/<link\b[^>]*data-inlined-from="([^"]*)"[^>]*>/gi))
  for (const m of cssLinks) {
    const resolved = m[1]
    const file = ctx.map.get(resolved)
    if (!file) continue
    const css = await inlineCss(await fileText(file), resolved, ctx)
    html = html.split(m[0]).join(`<style data-inlined-from="${resolved}">\n${css}\n</style>`)
  }

  // 内联 <style> 里的资源
  const styleBlocks = Array.from(html.matchAll(STYLE_BLOCK_RE))
  for (const m of styleBlocks) {
    if (m[0].includes('data-inlined-from')) continue
    const css = await inlineCss(m[1], analysis.entryPath, ctx)
    html = html.split(m[0]).join(`<style>${css}</style>`)
  }

  // 内联 style 属性
  const styleAttrs = Array.from(html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi))
  for (const m of styleAttrs) {
    const css = await inlineCss(m[1], analysis.entryPath, ctx)
    html = html.split(m[0]).join(` style="${css.replace(/"/g, '&quot;')}"`)
  }

  // 内联 script
  for (const m of Array.from(html.matchAll(SCRIPT_BLOCK_RE)).reverse()) {
    let [, open, code, close] = m
    const src = attr(open, 'src')
    const module = attr(open, 'type').toLowerCase() === 'module'
    if ((!src && !module) || isExternalRef(src)) continue
    let path = analysis.entryPath
    if (src) {
      const resolved = safeResolve(path, src, ctx.warnings)
      if (!resolved) continue
      const file = ctx.map.get(resolved)
      if (!file) continue
      path = resolved
      code = await fileText(file)
      open = stripAttrs(open, ['src', 'integrity', 'crossorigin'])
    }
    if (module) code = await rewriteModule(code, path, ctx)
    if (src) code = code.replace(/<\/script/gi, '<\\/script')
    html = html.slice(0, m.index) + open + code + close + html.slice(m.index + m[0].length)
  }

  // 图片 / 媒体 / icon / srcset
  const assetTags = Array.from(html.matchAll(/<(img|source|video|audio|link)\b[^>]*>/gi)).map((m) => m[0])
  for (const tag of assetTags) {
    const name = tagName(tag)
    if (name === 'link') {
      const rel = attr(tag, 'rel').toLowerCase()
      const href = attr(tag, 'href')
      if (!href || isExternalRef(href) || !(rel.includes('icon') || rel.includes('apple-touch-icon'))) continue
      const resolved = safeResolve(analysis.entryPath, href, ctx.warnings)
      if (!resolved) continue
      const file = ctx.map.get(resolved)
      if (!file) continue
      html = html.split(tag).join(setAttr(tag, 'href', await fileToDataUrl(file)))
      continue
    }
    let next = tag
    const src = attr(tag, 'src')
    if (src && !isExternalRef(src)) {
      const resolved = safeResolve(analysis.entryPath, src, ctx.warnings)
      const file = resolved ? ctx.map.get(resolved) : undefined
      if (file) next = setAttr(next, 'src', await fileToDataUrl(file))
    }
    const srcset = attr(tag, 'srcset')
    if (srcset) {
      const parts = srcset.split(',').map((p) => p.trim())
      const rewritten: string[] = []
      for (const part of parts) {
        const [u, ...desc] = part.split(/\s+/)
        if (!u || isExternalRef(u)) {
          rewritten.push(part)
          continue
        }
        const resolved = safeResolve(analysis.entryPath, u, ctx.warnings)
        const file = resolved ? ctx.map.get(resolved) : undefined
        if (file) rewritten.push([await fileToDataUrl(file), ...desc].join(' '))
        else rewritten.push(part)
      }
      next = setAttr(next, 'srcset', rewritten.join(', '))
    }
    if (next !== tag) html = html.split(tag).join(next)
  }

  // 移除预览桥/工作台专用注入
  html = html.replace(SCRIPT_BLOCK_RE, (full, open: string, body: string) =>
    body.includes('__WORKBENCH_PREVIEW__') || /(?:^|\/)__bridge\.js(?:[?#]|$)/.test(attr(open, 'src')) ? '' : full,
  )

  const unbundled = new Set<string>()
  const markup = html.replace(SCRIPT_BLOCK_RE, '').replace(STYLE_BLOCK_RE, '').replace(/<!--[\s\S]*?-->/g, '')
  for (const [tag] of markup.matchAll(HTML_REF_TAGS)) {
    const name = tagName(tag)
    const ref = name === 'iframe' ? attr(tag, 'src') : name === 'object' ? attr(tag, 'data') :
      name === 'link' && /\b(?:preload|modulepreload)\b/i.test(attr(tag, 'rel')) ? attr(tag, 'href') : ''
    if (!ref || isExternalRef(ref)) continue
    const path = safeResolve(analysis.entryPath, ref, ctx.warnings)
    unbundled.add(path ?? ref)
  }

  const warnings = Array.from(new Set([...ctx.moduleIssues, ...ctx.warnings]))
  if (unbundled.size) warnings.push(`单 HTML 未打包这些本地引用：${[...unbundled].join('、')}`)
  if (analysis.external.length) warnings.push(`导出仍依赖 ${analysis.external.length} 个外部资源`)
  if (analysis.missing.length) warnings.push(`导出缺少 ${analysis.missing.length} 个本地资源`)

  return {
    ...analysis,
    ok: analysis.ok && ctx.moduleIssues.size === 0 && unbundled.size === 0,
    unbundled: [...unbundled],
    moduleIssues: Array.from(ctx.moduleIssues),
    warnings,
    html,
    size: new TextEncoder().encode(html).length,
  }
}
