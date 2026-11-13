import bridgeSource from './bridge.js?raw'
import { listWorkspaceFiles } from '../db/repo'
import type { ProjectFile } from './compiler'
import { normalizePath } from '../lib/path'
import { mimeFromPath } from '../lib/mime'
import {
  clearPreviewFiles,
  previewFileKey,
  putPreviewFiles,
  putPreviewSession,
  type PreviewCacheFile,
} from './cache'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 80 * 1024 * 1024

export interface SyncResult {
  fileCount: number
  totalBytes: number
  skipped: string[]
  warnings: string[]
}

function rewriteRootAbsoluteHtml(html: string, base: string): string {
  return html.replace(
    /(\s(?:src|href|poster|data)\s*=\s*["'])\/(?!\/|__vfs__\/)([^"']*)(["'])/gi,
    (_m, pre: string, rest: string, quote: string) => `${pre}${base}${rest}${quote}`,
  )
}

function rewriteRootAbsoluteCss(css: string, base: string): string {
  let out = css.replace(
    /url\(\s*(['"]?)\/(?!\/|__vfs__\/)([^'")]+)\1\s*\)/gi,
    (_m, quote: string, rest: string) => `url(${quote}${base}${rest}${quote})`,
  )
  out = out.replace(
    /@import\s+(['"])\/(?!\/|__vfs__\/)([^'"]+)\1/gi,
    (_m, quote: string, rest: string) => `@import ${quote}${base}${rest}${quote}`,
  )
  return out
}

function injectBridge(html: string, sessionId: string, buildVersion: number, virtualOrigin: boolean): string {
  if (html.includes('__WORKBENCH_PREVIEW__')) return html
  const base = `/__vfs__/s/${encodeURIComponent(sessionId)}/`
  const boot = {
    sessionId,
    buildVersion,
    virtualOrigin,
  }
  const injection =
    `<script>window.__WORKBENCH_PREVIEW__=${JSON.stringify(boot)};</script>` +
    `<script src="${base}__bridge.js"></script>`
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => m + injection)
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${injection}</head>`)
  }
  return injection + html
}

export function transformPreviewHtml(
  html: string,
  sessionId: string,
  buildVersion: number,
  virtualOrigin: boolean,
): string {
  const base = `/__vfs__/s/${encodeURIComponent(sessionId)}/`
  let out = rewriteRootAbsoluteHtml(html, base)
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (full, css: string) => {
    return full.replace(css, rewriteRootAbsoluteCss(css, base))
  })
  out = injectBridge(out, sessionId, buildVersion, virtualOrigin)
  return out
}

export function transformPreviewCss(css: string, sessionId: string): string {
  return rewriteRootAbsoluteCss(css, `/__vfs__/s/${encodeURIComponent(sessionId)}/`)
}

/** file:// 或 SW 不可用时，把桥直接内联进单文档预览。 */
export function injectInlineBridge(html: string, sessionId: string, buildVersion: number): string {
  if (html.includes('__WORKBENCH_PREVIEW__')) return html
  const boot = {
    sessionId,
    buildVersion,
    virtualOrigin: false,
  }
  const safeBridge = bridgeSource.replace(/<\/script>/gi, '<\\/script>')
  const injection =
    `<script>window.__WORKBENCH_PREVIEW__=${JSON.stringify(boot)};</script>` +
    `<script>${safeBridge}</script>`
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + injection)
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${injection}</head>`)
  return injection + html
}

export interface SyncOpts {
  taskId: string
  sessionId: string
  entryPath: string
  buildVersion: number
  virtualOrigin: boolean
  /** Original source snapshot shared with this build's export. */
  files?: readonly ProjectFile[]
}

export async function syncPreviewFiles(opts: SyncOpts): Promise<SyncResult> {
  const { taskId, sessionId, entryPath, buildVersion, virtualOrigin } = opts
  const files = opts.files ?? await listWorkspaceFiles(taskId)
  const skipped: string[] = []
  const warnings: string[] = []
  const out: PreviewCacheFile[] = []
  let total = 0

  await clearPreviewFiles(sessionId)

  for (const f of files) {
    const path = normalizePath(f.path)
    if (f.size > MAX_FILE_BYTES) {
      skipped.push(path)
      warnings.push(`文件超过 20MB，未加入试玩：${path}`)
      continue
    }
    if (total + f.size > MAX_TOTAL_BYTES) {
      skipped.push(path)
      warnings.push(`试玩缓存超过 80MB，后续文件未加入：${path}`)
      continue
    }
    total += f.size
    const mime = f.mime || mimeFromPath(path)
    const lower = path.toLowerCase()
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      const text = typeof f.text === 'string' ? f.text : f.blob ? await f.blob.text() : ''
      const transformed = transformPreviewHtml(text, sessionId, buildVersion, virtualOrigin)
      out.push({
        key: previewFileKey(sessionId, path),
        sessionId,
        path,
        mime: 'text/html; charset=utf-8',
        text: transformed,
        size: new TextEncoder().encode(transformed).length,
      })
    } else if (lower.endsWith('.css')) {
      const text = typeof f.text === 'string' ? f.text : f.blob ? await f.blob.text() : ''
      const transformed = transformPreviewCss(text, sessionId)
      out.push({
        key: previewFileKey(sessionId, path),
        sessionId,
        path,
        mime: 'text/css; charset=utf-8',
        text: transformed,
        size: new TextEncoder().encode(transformed).length,
      })
    } else if (typeof f.text === 'string') {
      out.push({
        key: previewFileKey(sessionId, path),
        sessionId,
        path,
        mime,
        text: f.text,
        size: f.size,
      })
    } else if (f.blob) {
      out.push({
        key: previewFileKey(sessionId, path),
        sessionId,
        path,
        mime,
        blob: f.blob,
        size: f.size,
      })
    }
  }

  const bridgeBytes = new TextEncoder().encode(bridgeSource).length
  out.push({
    key: previewFileKey(sessionId, '/__bridge.js'),
    sessionId,
    path: '/__bridge.js',
    mime: 'text/javascript; charset=utf-8',
    text: bridgeSource,
    size: bridgeBytes,
  })

  await putPreviewFiles(out)
  await putPreviewSession({
    sessionId,
    taskId,
    entryPath: normalizePath(entryPath),
    buildVersion,
    virtualOrigin,
    createdAt: Date.now(),
  })

  return { fileCount: out.length, totalBytes: total + bridgeBytes, skipped, warnings }
}
