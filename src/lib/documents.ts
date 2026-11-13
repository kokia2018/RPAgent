/** 文档识别：扩展名 + MIME + 已知结构，不只看扩展名。 */

import type { AssetParseStatus } from '../db/types'
import { isTextMime, mimeFromPath } from './mime'

export type DocumentKind =
  | 'html'
  | 'markdown'
  | 'json'
  | 'csv'
  | 'text'
  | 'image'
  | 'pdf'
  | 'word'
  | 'audio'
  | 'video'
  | 'binary'

export interface FileProfile {
  kind: DocumentKind
  mime: string
  status: AssetParseStatus
  /** 能否作为文档在阅读器里查看（HTML 可看源码，图片可看画面）。 */
  readable: boolean
  /** 能否导入工作区后直接试玩。 */
  runnable: boolean
  note: string
}

const WORD_EXT = /\.(docx?|odt|rtf)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i
const TEXT_EXT = /\.(txt|log|md|markdown|json|csv|tsv|xml|yaml|yml|css|js|mjs|cjs|ts|tsx|jsx|html?|svg|ini|conf|toml)$/i

function profile(
  mime: string,
  kind: DocumentKind,
  status: AssetParseStatus,
  readable: boolean,
  runnable: boolean,
  note: string,
): FileProfile {
  return { mime, kind, status, readable, runnable, note }
}

export function profileForFile(name: string, mime?: string): FileProfile {
  const path = String(name || '')
  const type = (mime || mimeFromPath(path) || '').toLowerCase()

  if (/\.html?$/i.test(path) || type === 'text/html') {
    return profile(type, 'html', 'runnable', true, true, '可以直接在试玩中运行；阅读器展示渲染结果与源码。')
  }
  if (/\.(md|markdown)$/i.test(path) || type === 'text/markdown') {
    return profile(type, 'markdown', 'readable', true, false, 'Markdown 文档，可阅读渲染结果。')
  }
  if (/\.(csv|tsv)$/i.test(path) || type === 'text/csv' || type === 'text/tab-separated-values') {
    return profile(type, 'csv', 'readable', true, false, '表格文本，可阅读和搜索。')
  }
  if (/\.json$/i.test(path) || type === 'application/json') {
    return profile(type, 'json', 'readable', true, false, 'JSON 文本，可阅读和搜索。')
  }
  if (IMAGE_EXT.test(path) || type.startsWith('image/')) {
    return profile(type, 'image', 'image', true, false, '图片可直接查看；Agent 不能读取像素内容。')
  }
  if (/\.pdf$/i.test(path) || type === 'application/pdf') {
    return profile(
      type,
      'pdf',
      'unsupported',
      false,
      false,
      'PDF 解析暂未支持，工作台无法提取正文。可下载原文件，或交给 Agent 分析文件结构。',
    )
  }
  if (WORD_EXT.test(path) || type.includes('word') || type.includes('opendocument')) {
    return profile(
      type,
      'word',
      'unsupported',
      false,
      false,
      'Word / 文档格式解析暂未支持，工作台无法提取正文。可下载原文件，或交给 Agent 分析。',
    )
  }
  if (type.startsWith('audio/')) {
    return profile(type, 'audio', 'unsupported', false, false, '音频可以在浏览器中播放，但暂不做转写。')
  }
  if (type.startsWith('video/')) {
    return profile(type, 'video', 'unsupported', false, false, '视频暂不支持阅读或转写。')
  }
  if (TEXT_EXT.test(path) || isTextMime(type)) {
    return profile(type, 'text', 'readable', true, false, '纯文本，可阅读和搜索。')
  }
  return profile(
    type,
    'binary',
    'binary',
    false,
    false,
    '此格式暂不支持阅读。可下载原文件，或交给 Agent 分析。',
  )
}

export function isRunnableHtml(name: string, mime?: string): boolean {
  return profileForFile(name, mime).runnable
}

/** 上传路径清洗：统一斜杠、去掉 .. 与盘符、保留相对目录。 */
export function sanitizeUploadPath(name: string): string {
  const cleaned = String(name || '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/[\u0000-\u001f]/g, '')
  const parts = cleaned.split('/').filter((part) => part && part !== '.' && part !== '..')
  return parts.join('/') || 'file'
}

export function baseName(path: string): string {
  const parts = String(path || '').split('/')
  return parts[parts.length - 1] || 'file'
}

/** 文本资料只保留文件名，避免把任意目录结构写进资料库文件夹。 */
export function fileNameForLibrary(name: string): string {
  return baseName(sanitizeUploadPath(name))
}

export function profileStatusText(status: AssetParseStatus): string {
  switch (status) {
    case 'readable':
      return '可阅读'
    case 'image':
      return '图片'
    case 'runnable':
      return '可试玩'
    case 'unsupported':
      return '不支持解析'
    default:
      return '二进制'
  }
}
