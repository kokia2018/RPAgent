import { compileInline, type ProjectFile } from '../preview/compiler'
import { getWorkspaceFile, listWorkspaceFiles, writeWorkspaceText } from '../db/repo'
import { sanitizeFileName } from '../lib/path'
import { byteSize } from '../lib/text'
import { detectRuntimeNeeds, injectStandaloneRuntime, standaloneNamespace } from './standaloneRuntime'

export interface ExportChecks {
  missing: string[]
  moduleIssues?: string[]
  unbundled?: string[]
  external: string[]
  workbenchRefs: string[]
  blobRefs: string[]
  secrets: string[]
}

export type DeliveryLevel = 'offline-static' | 'needs-network' | 'needs-workbench' | 'incomplete'

export interface DeliveryContext {
  /** 注入了独立 AI 运行时：静态部分可离线，但对话必须联网 */
  networkRuntime?: boolean
}

export function computeDeliveryLevel(checks: ExportChecks, context: DeliveryContext = {}): DeliveryLevel {
  if (checks.missing.length || checks.unbundled?.length || checks.moduleIssues?.length) return 'incomplete'
  if (checks.workbenchRefs.length || checks.blobRefs.length) return 'needs-workbench'
  if (checks.external.length || context.networkRuntime) return 'needs-network'
  return 'offline-static'
}

export interface ExportCapabilities {
  storage: boolean
  ai: boolean
}

export interface ExportResult {
  path: string
  size: number
  level: DeliveryLevel
  checks: ExportChecks
  capabilities: ExportCapabilities
  warnings: string[]
}

const SECRET_RE = /\bsk-[A-Za-z0-9._:-]{12,}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\bBearer\s+[A-Za-z0-9._:-]{16,}\b/g

export interface PreparedExport {
  entryPath: string
  html: string
  report: ExportResult
}

export async function prepareHtmlExport(taskId: string, entryPath: string, name?: string, title?: string): Promise<PreparedExport> {
  return prepareHtmlExportFromFiles(await listWorkspaceFiles(taskId), entryPath, name, title, { identity: `${taskId}:${entryPath}` })
}

/** Prepare exclusively from original source files; never reads or writes the workspace. */
export async function prepareHtmlExportFromFiles(
  files: readonly ProjectFile[], entryPath: string, name?: string, title?: string,
  options: { identity?: string } = {},
): Promise<PreparedExport> {
  // Capture metadata before compileInline yields. Blob content is immutable.
  const snapshot = files.map((file) => ({ ...file }))
  const needs = { storage: false, ai: false, preview: false, vfs: false }
  const maskedSecrets = new Set<string>()
  const inspectSecrets = (text: string) => {
    for (const match of text.matchAll(SECRET_RE)) maskedSecrets.add(match[0].slice(0, 12) + '…')
  }
  const inspectNeeds = (text: string) => {
    const found = detectRuntimeNeeds(text)
    needs.storage ||= found.storage
    needs.ai ||= found.ai
    needs.preview ||= found.preview
    needs.vfs ||= found.vfs
  }
  const compiled = await compileInline(
    entryPath,
    snapshot,
    {
      inspectModule(source) {
        inspectNeeds(source)
        inspectSecrets(source)
      },
    },
  )
  if (!compiled.html) throw new Error('导出失败：入口 HTML 为空')

  const baseName = sanitizeFileName(name || title || 'app', 'app').replace(/\.html?$/i, '')
  inspectNeeds(compiled.html)
  // 预览桥与虚拟源（Workbench.preview / __vfs__）仍属于工作台依赖，不做独立化。
  const standalone = !needs.preview && !needs.vfs && (needs.storage || needs.ai)
  const runtime = standalone
    ? injectStandaloneRuntime(compiled.html, {
        prefix: options.identity ? standaloneNamespace(options.identity) : `workbench:${baseName}:`,
        appName: baseName,
        needs,
      })
    : { html: compiled.html, injected: [] as ('storage' | 'ai')[] }
  const html = runtime.html
  const capabilities: ExportCapabilities = {
    storage: runtime.injected.includes('storage'),
    ai: runtime.injected.includes('ai'),
  }
  const workbenchRefs = standalone
    ? compiled.workbenchRefs.filter((ref) => ref !== 'Workbench API')
    : compiled.workbenchRefs

  inspectSecrets(html)
  const secrets = Array.from(maskedSecrets)
  const checks: ExportChecks = {
    missing: compiled.missing,
    moduleIssues: compiled.moduleIssues,
    unbundled: compiled.unbundled,
    external: compiled.external,
    workbenchRefs,
    blobRefs: compiled.blobRefs,
    secrets,
  }

  const level = computeDeliveryLevel(checks, { networkRuntime: capabilities.ai })

  const outPath = `/dist/${baseName}.html`

  const warnings = [...compiled.warnings]
  if (capabilities.storage) warnings.push('已注入独立 localStorage 存储适配；导出作品不会继承工作台试玩存档')
  if (capabilities.ai) {
    warnings.push('已注入作品自己的 AI 设置面板与直连端点实现；不含工作台密钥，首次对话需在作品内填写配置')
  }
  if (checks.missing.length) warnings.push('导出缺少本地资源，作品可能无法完整运行')
  if (level === 'needs-workbench') warnings.push('作品仍引用工作台专用能力或 blob URL，不能独立运行')
  if (level === 'needs-network') warnings.push('作品仍依赖外部网络资源或模型端点')
  if (secrets.length) warnings.push('检测到疑似密钥字符串，请确认导出文件是否安全')

  return {
    entryPath: compiled.entryPath,
    html,
    report: { path: outPath, size: new TextEncoder().encode(html).length, level, checks, capabilities, warnings },
  }
}

export async function exportHtml(taskId: string, entryPath: string, name?: string, title?: string): Promise<ExportResult> {
  const prepared = await prepareHtmlExport(taskId, entryPath, name, title)
  const { report, html } = prepared
  const existing = await getWorkspaceFile(taskId, report.path)
  if (existing && (existing.source !== 'export' || existing.path === prepared.entryPath)) {
    throw new Error(`导出路径与作品源文件冲突：${report.path}。请更换导出名称。`)
  }
  await writeWorkspaceText(taskId, report.path, html, 'export')
  return report
}

export function deliveryLevelText(level: DeliveryLevel): string {
  switch (level) {
    case 'offline-static':
      return '单 HTML，静态部分可离线运行'
    case 'needs-network':
      return '单 HTML，需要联网加载外部资源或模型'
    case 'needs-workbench':
      return '仍依赖工作台能力，未完成独立化'
    case 'incomplete':
      return '依赖未完整打包，无法确认独立运行'
  }
}

export function exportSummaryText(result: ExportResult): string {
  const caps = [
    result.capabilities.storage ? '独立存储（localStorage）' : '',
    result.capabilities.ai ? '独立 AI 设置（需联网）' : '',
  ].filter(Boolean)
  return [
    `导出：${result.path}（${byteSize(result.size)}）`,
    `交付等级：${deliveryLevelText(result.level)}`,
    caps.length ? `已注入独立运行时：${caps.join('、')}` : '',
    result.checks.missing.length ? `缺失资源：${result.checks.missing.slice(0, 8).join('、')}` : '',
    result.checks.external.length ? `外部依赖：${result.checks.external.slice(0, 5).join('、')}` : '',
    result.checks.workbenchRefs.length ? `工作台依赖：${result.checks.workbenchRefs.join('、')}` : '',
    result.checks.secrets.length ? `疑似密钥：${result.checks.secrets.join('、')}` : '',
    ...result.warnings.slice(0, 6),
  ]
    .filter(Boolean)
    .join('\n')
}

export function downloadText(filename: string, content: string, mime = 'text/html;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function downloadWorkspaceText(taskId: string, path: string, filename?: string): Promise<void> {
  const files = await listWorkspaceFiles(taskId)
  const file = files.find((f) => f.path === path)
  if (!file) throw new Error('文件不存在：' + path)
  const text = typeof file.text === 'string' ? file.text : file.blob ? await file.blob.text() : ''
  downloadText(filename || path.split('/').pop() || 'download.txt', text, file.mime)
}
