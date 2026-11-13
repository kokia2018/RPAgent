/**
 * 角色卡在工作区里的最终产物编码：JSON（原格式 / V2 / V3 信封）与带封面的 PNG。
 * 这是 Agent 可调用的工具层，不是作品页自带按钮。
 */

import { exportCharacterCardJson, validateCharacterCardV2 } from './cardCodec'

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const encoder = new TextEncoder()

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = encoder.encode(type)
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes, 0)
  body.set(data, typeBytes.length)
  const out = new Uint8Array(4 + body.length + 4)
  out.set(u32(data.length), 0)
  out.set(body, 4)
  out.set(u32(crc32(body)), 4 + body.length)
  return out
}

interface PngChunk { type: string; data: Uint8Array }

export function readPngChunks(bytes: Uint8Array): PngChunk[] {
  if (bytes.length < 8 || !SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('封面不是有效的 PNG 文件')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: PngChunk[] = []
  let offset = 8
  let sawIdat = false
  let endedIdat = false
  let ended = false
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    if (offset + 12 + length > bytes.length) throw new Error('PNG 数据被截断')
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('PNG 块类型无效')
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length)) throw new Error(`PNG ${type} 校验失败`)
    if (!chunks.length && type !== 'IHDR') throw new Error('PNG 首块必须为 IHDR')
    if (type === 'IHDR') {
      if (chunks.length || length !== 13) throw new Error('PNG IHDR 无效')
      const width = view.getUint32(offset + 8), height = view.getUint32(offset + 12)
      if (!width || !height || width > 16384 || height > 16384 || width * height > 64_000_000) throw new Error('PNG 封面尺寸无效或过大')
    }
    if (type === 'IDAT') {
      if (endedIdat) throw new Error('PNG IDAT 块必须连续')
      sawIdat = true
    } else if (sawIdat) endedIdat = true
    chunks.push({ type, data })
    offset += 12 + length
    if (type === 'IEND') {
      if (length || !sawIdat) throw new Error('PNG 缺少图片数据或 IEND 无效')
      ended = true
      break
    }
  }
  if (!ended || offset !== bytes.length) throw new Error('PNG 缺少 IEND、数据被截断或包含尾随数据')
  return chunks
}

function textData(keyword: string, text: string): Uint8Array {
  const key = encoder.encode(keyword)
  const value = encoder.encode(text)
  const out = new Uint8Array(key.length + 1 + value.length)
  out.set(key, 0)
  out[key.length] = 0
  out.set(value, key.length + 1)
  return out
}

/** 把当前卡 JSON 以 base64 tEXt 写入封面 PNG；替换旧的 chara/ccv3，保留其他块与图片本体。 */
export function embedCardInPng(cover: Uint8Array, card: unknown, keyword: 'chara' | 'ccv3'): Uint8Array {
  const chunks = readPngChunks(cover)
  const json = JSON.stringify(card)
  const bytes = encoder.encode(json)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  const base64 = btoa(binary)
  const out: Uint8Array[] = [SIGNATURE]
  let inserted = false
  for (const c of chunks) {
    if (c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt') {
      const end = c.data.indexOf(0)
      const key = end >= 0 && end <= 79 ? String.fromCharCode(...c.data.subarray(0, end)).toLowerCase() : ''
      if (key === 'chara' || key === 'ccv3') continue
    }
    if (c.type === 'IEND' && !inserted) {
      out.push(chunk('tEXt', textData(keyword, base64)))
      inserted = true
    }
    out.push(chunk(c.type, c.data))
  }
  if (!inserted) out.push(chunk('tEXt', textData(keyword, base64)))
  const total = out.reduce((n, part) => n + part.length, 0)
  const merged = new Uint8Array(total)
  let at = 0
  for (const part of out) { merged.set(part, at); at += part.length }
  return merged
}

/** 无封面时生成中性封面：雾白底、柔紫图形和角色名，不使用外部资源。 */
export async function makeDefaultCover(name: string, subtitle: string): Promise<Uint8Array> {
  const doc = document.createElement('canvas')
  doc.width = 512
  doc.height = 768
  const ctx = doc.getContext('2d')
  if (!ctx) throw new Error('当前浏览器无法生成封面')
  const bg = ctx.createLinearGradient(0, 0, 0, 768)
  bg.addColorStop(0, '#F7F7FC')
  bg.addColorStop(1, '#EDE7F7')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, 512, 768)
  ctx.fillStyle = '#7963AD'
  ctx.globalAlpha = 0.9
  ctx.beginPath()
  ctx.roundRect(118, 168, 276, 276, 64)
  ctx.fill()
  ctx.fillStyle = '#E7A5C3'
  ctx.globalAlpha = 0.85
  ctx.beginPath()
  ctx.roundRect(196, 246, 198, 198, 48)
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.fillStyle = '#F7F7FC'
  ctx.beginPath()
  ctx.roundRect(166, 216, 180, 180, 36)
  ctx.fill()
  ctx.fillStyle = '#302D40'
  ctx.font = 'bold 34px system-ui, sans-serif'
  ctx.textAlign = 'center'
  const clipped = name.length > 14 ? `${name.slice(0, 13)}…` : name
  ctx.fillText(clipped, 256, 560)
  ctx.fillStyle = '#706A80'
  ctx.font = '20px system-ui, sans-serif'
  ctx.fillText(subtitle.slice(0, 24), 256, 602)
  const blob = await new Promise<Blob | null>((resolve) => doc.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('封面生成失败')
  return new Uint8Array(await blob.arrayBuffer())
}

function validateV3Fields(root: Record<string, unknown>): void {
  if (root.spec !== 'chara_card_v3' || root.spec_version !== '3.0' || !root.data || typeof root.data !== 'object' || Array.isArray(root.data)) throw new Error('V3 信封无效')
  const data = root.data as Record<string, unknown>
  validateCharacterCardV2({ spec: 'chara_card_v2', spec_version: '2.0', data })
  if (typeof data.nickname !== 'string') throw new Error('V3 nickname 必须是字符串')
  const notes = data.creator_notes_multilingual
  if (!notes || typeof notes !== 'object' || Array.isArray(notes) || Object.values(notes).some(v => typeof v !== 'string')) throw new Error('V3 多语言备注必须为字符串字典')
  for (const key of ['source', 'group_only_greetings']) {
    if (!Array.isArray(data[key]) || data[key].some(v => typeof v !== 'string')) throw new Error(`V3 ${key} 必须为字符串数组`)
  }
  if (!Array.isArray(data.assets) || data.assets.some(v => !v || typeof v !== 'object' || ['type', 'uri', 'name', 'ext'].some(key => typeof v[key] !== 'string'))) throw new Error('V3 assets 必须为资源描述数组')
  for (const key of ['creation_date', 'modification_date']) if (data[key] != null && (typeof data[key] !== 'number' || !Number.isFinite(data[key]))) throw new Error(`V3 ${key} 必须为时间戳`)
}

/** V3 信封：保留现有 V2/V3 数据，补齐 V3 要求的容器字段；不声称完整 V3 语义。 */
export function buildV3Envelope(raw: unknown): { card: Record<string, unknown>; warnings: string[] } {
  if (!raw || typeof raw !== 'object') throw new Error('卡数据不是对象')
  const root = raw as Record<string, unknown>
  if (root.spec === 'chara_card_v3') {
    validateV3Fields(root)
    return { card: root, warnings: ['已检查 V3 核心字段与附加容器类型；未验证扩展运行语义或第三方导入兼容性。'] }
  }
  const normalized = JSON.parse(exportCharacterCardJson(raw, 'v2').text) as Record<string, unknown>
  const source = normalized.data as Record<string, unknown>
  const data: Record<string, unknown> = {
    ...source,
    nickname: typeof source.nickname === 'string' ? source.nickname : '',
    creator_notes_multilingual: source.creator_notes_multilingual ?? {},
    source: Array.isArray(source.source) ? source.source : [],
    group_only_greetings: Array.isArray(source.group_only_greetings) ? source.group_only_greetings : [],
    assets: Array.isArray(source.assets) ? source.assets : [],
  }
  const card = { ...normalized, spec: 'chara_card_v3', spec_version: '3.0', data }
  validateV3Fields(card)
  return {
    card,
    warnings: [
      '已按 V3 容器补齐 spec/spec_version 与 V3 附加字段，但未验证原卡扩展在 V3 运行时的语义。',
      'V3 支持程度取决于导入方；保留在 data 中的未知字段不会被删除。',
    ],
  }
}

export interface CardFileExport {
  bytes: Uint8Array
  mime: string
  extension: '.json' | '.png'
  warnings: string[]
}

export function encodeCardFile(raw: unknown, target: 'json-original' | 'json-v2' | 'json-v3' | 'png', cover?: Uint8Array): CardFileExport {
  if (target === 'png') {
    if (!cover) throw new Error('PNG 导出需要封面：请先准备封面 PNG，或让工作台生成默认封面')
    const spec = (raw as { spec?: string })?.spec
    if (spec === 'chara_card_v3') {
      const { card, warnings } = buildV3Envelope(raw)
      return { bytes: embedCardInPng(cover, card, 'ccv3'), mime: 'image/png', extension: '.png', warnings: ['PNG 已写入 ccv3（V3）卡元数据；图片本体与未修改的块保持不变。', ...warnings] }
    }
    // 传统 chara 块承载标准 V2 信封，避免把 V2 卡误标成 V3。
    const v2 = JSON.parse(exportCharacterCardJson(raw, 'v2').text)
    return { bytes: embedCardInPng(cover, v2, 'chara'), mime: 'image/png', extension: '.png', warnings: ['PNG 已写入 chara（V2）卡元数据；图片本体与未修改的块保持不变。', 'V3 语义未写入 PNG；需要 V3 时请另导出 V3 JSON。'] }
  }
  if (target === 'json-v3') {
    const { card, warnings } = buildV3Envelope(raw)
    return { bytes: encoder.encode(JSON.stringify(card, null, 2)), mime: 'application/json', extension: '.json', warnings }
  }
  const out = exportCharacterCardJson(raw, target === 'json-v2' ? 'v2' : 'original')
  return { bytes: encoder.encode(out.text), mime: out.mime, extension: out.extension, warnings: out.warnings }
}
