/** 角色卡识别与世界书基础选择。纯函数，不依赖 IndexedDB，便于测试与后续扩展。 */

import type { CharacterCardSummary } from '../db/types'

/** 世界书条目插入位置：角色设定前/后、示例前/后，或按深度插入为对话消息。 */
export type WorldPosition = 'before_char' | 'after_char' | 'before_example' | 'after_example' | 'at_depth'
export type WorldRole = 'system' | 'user' | 'assistant'

export interface WorldBookEntry {
  id: string
  name: string
  keys: string[]
  content: string
  enabled: boolean
  constant: boolean
  order: number
  /** at_depth 时表示距对话末尾的轮数 */
  depth?: number
  position: WorldPosition
  /** at_depth 时注入消息的角色 */
  role: WorldRole
  /** 0-100；仅当 useProbability 为真时参与筛选 */
  probability?: number
  useProbability?: boolean
}

const POSITION_BY_CODE: Record<number, WorldPosition> = {
  0: 'before_char',
  1: 'after_char',
  2: 'before_example',
  3: 'after_example',
  4: 'at_depth',
}

const ROLE_BY_CODE: Record<number, WorldRole> = { 0: 'system', 1: 'user', 2: 'assistant' }

function parsePosition(value: unknown): WorldPosition {
  if (typeof value === 'number') return POSITION_BY_CODE[value] || 'before_char'
  const text = String(value || '').toLowerCase()
  if (text === 'after_char' || text === 'after_character') return 'after_char'
  if (text === 'before_example' || text === 'before_an') return 'before_example'
  if (text === 'after_example' || text === 'after_an') return 'after_example'
  if (text === 'at_depth' || text === 'depth') return 'at_depth'
  return 'before_char'
}

function parseRole(value: unknown): WorldRole {
  if (typeof value === 'number') return ROLE_BY_CODE[value] || 'system'
  const text = String(value || '').toLowerCase()
  if (text === 'user' || text === 'assistant') return text
  return 'system'
}

/** 角色卡自带的正则脚本（SillyTavern 的 regex_scripts 字段）。 */
export interface CardRegexScript {
  name: string
  find: string
  replace: string
  /** 1 = 用户输入，2 = 模型输出；空数组表示两者都应用 */
  placement: number[]
  disabled: boolean
  flags: string
}

export interface CharacterCardData {
  spec: string
  name: string
  description: string
  personality: string
  scenario: string
  firstMes: string
  mesExample: string
  creatorNotes: string
  systemPrompt: string
  postHistoryInstructions: string
  alternateGreetings: string[]
  tags: string[]
  creator: string
  version: string
  worldEntries: WorldBookEntry[]
  /** 原卡声明的规则数，独立于旧对话阅读器可解析的格式和上限。 */
  regexRuleCount: number
  regexScripts: CardRegexScript[]
  unsupported: string[]
  unknownFields: string[]
  raw: unknown
}

export interface ParsedCharacterCard {
  summary: CharacterCardSummary
  data: CharacterCardData
  format: 'json' | 'png'
  avatarBlob?: Blob
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && Boolean(v.trim()))
}

function firstNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const KNOWN_CARD_FIELDS = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'tags',
  'creator',
  'character_version',
  'character_book',
  'extensions',
  'group_only_greetings',
  'assets',
  'avatar',
  'creation_date',
  'modification_date',
  'spec',
  'spec_version',
  'data',
])

function parseWorldEntries(book: unknown): WorldBookEntry[] {
  const obj = asObject(book)
  if (!obj) return []
  const rawEntries = Array.isArray(obj.entries) ? obj.entries : []
  const out: WorldBookEntry[] = []
  for (let i = 0; i < rawEntries.length; i++) {
    const entry = asObject(rawEntries[i])
    if (!entry) continue
    const keys = strArray(entry.keys).length
      ? strArray(entry.keys)
      : str(entry.keys)
          .split(/[,，、]/)
          .map((k) => k.trim())
          .filter(Boolean)
    const content = str(entry.content)
    if (!content) continue
    const name = str(entry.name) || str(entry.comment) || keys[0] || `世界书条目 ${i + 1}`
    out.push({
      id: String(entry.id ?? entry.uid ?? i),
      name,
      keys,
      content,
      enabled: entry.enabled !== false && entry.disable !== true,
      constant: Boolean(entry.constant),
      order: firstNumber(entry.insertion_order ?? entry.order),
      depth: typeof (entry.depth ?? asObject(entry.extensions)?.depth) === 'number' ? Number(entry.depth ?? asObject(entry.extensions)?.depth) : undefined,
      position: parsePosition(entry.position ?? asObject(entry.extensions)?.position),
      role: parseRole(entry.role ?? asObject(entry.extensions)?.role),
      probability: typeof entry.probability === 'number' ? entry.probability : undefined,
      useProbability: entry.useProbability === true || entry.use_probability === true,
    })
  }
  return out
}

const MAX_REGEX_SCRIPTS = 20

function parseFlags(find: string): { source: string; flags: string } {
  const literal = /^\/([\s\S]+)\/([a-z]*)$/i.exec(find.trim())
  if (literal) return { source: literal[1], flags: literal[2] || 'g' }
  return { source: find, flags: 'g' }
}

/** 解析 cards 的 regex_scripts；字段命名兼容 findRegex/find_regex 等写法。 */
export function parseRegexScripts(raw: unknown): CardRegexScript[] {
  if (!Array.isArray(raw)) return []
  const out: CardRegexScript[] = []
  for (const item of raw.slice(0, MAX_REGEX_SCRIPTS)) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const findRaw = str(obj.findRegex) || str(obj.find_regex) || str(obj.find)
    if (!findRaw) continue
    const replace = str(obj.replaceString) || str(obj.replace_string) || str(obj.replace)
    const placementRaw = obj.placement ?? obj.placements
    const placement = Array.isArray(placementRaw)
      ? placementRaw.filter((n): n is number => typeof n === 'number')
      : []
    const disabled = obj.disabled === true || obj.enabled === false
    out.push({
      name: str(obj.scriptName) || str(obj.script_name) || str(obj.name) || findRaw.slice(0, 24),
      find: findRaw,
      replace,
      placement,
      disabled,
      flags: str(obj.flags) || parseFlags(findRaw).flags,
    })
  }
  return out
}

export type RegexPlacement = 'user' | 'ai'

const PLACEMENT_CODE: Record<RegexPlacement, number> = { user: 1, ai: 2 }

export interface RegexApplyResult {
  text: string
  applied: string[]
  errors: string[]
}

/** 应用角色卡正则脚本；单个脚本出错只记录，不中断整体流程。 */
export function applyCardRegex(
  scripts: CardRegexScript[],
  text: string,
  placement: RegexPlacement,
): RegexApplyResult {
  const applied: string[] = []
  const errors: string[] = []
  let out = String(text ?? '')
  if (!out) return { text: out, applied, errors }
  const code = PLACEMENT_CODE[placement]
  for (const script of scripts) {
    if (script.disabled) continue
    if (script.placement.length && !script.placement.includes(code)) continue
    const { source, flags } = parseFlags(script.find)
    const safeFlags = Array.from(new Set((flags.includes('g') ? flags : flags + 'g').replace(/[^gimsuy]/g, ''))).join('')
    try {
      const re = new RegExp(source, safeFlags)
      const before = out
      out = out.replace(re, script.replace)
      if (out !== before) applied.push(script.name)
    } catch (e) {
      errors.push(`${script.name}：${String((e as Error)?.message || e)}`)
    }
  }
  return { text: out, applied, errors }
}

/** 从 JSON 角色卡（v1 / v2）提取字段；无法识别时返回 null。 */
export function parseCharacterCardJson(raw: unknown): CharacterCardData | null {
  const root = asObject(raw)
  if (!root) return null
  const explicitSpec = str(root.spec)
  const spec = explicitSpec || str(root.spec_version) || '未声明版本'
  const data = asObject(root.data) || root
  const name = str(data.name) || str(root.name)
  const description = str(data.description)
  const personality = str(data.personality)
  const scenario = str(data.scenario)
  const firstMes = str(data.first_mes) || str(data.firstMessage)
  const mesExample = str(data.mes_example) || str(data.mesExample)
  const systemPrompt = str(data.system_prompt) || str(data.systemPrompt)
  const postHistoryInstructions = str(data.post_history_instructions) || str(data.postHistoryInstructions)
  const characterBook = data.character_book ?? data.characterBook

  const declaredCard = /^(chara_card_v2|chara_card_v3)$/.test(explicitSpec)
  if (explicitSpec && (!declaredCard || !asObject(root.data))) return null
  const book = asObject(characterBook)
  const validBook = Array.isArray(book?.entries) && book.entries.some((entry) => {
    const obj = asObject(entry)
    return obj && typeof obj.content === 'string' && (Array.isArray(obj.keys) || typeof obj.keys === 'string')
  })
  const looksLikeCard =
    declaredCard ||
    Boolean(name && validBook) ||
    Boolean(name && (personality || scenario || firstMes || mesExample || systemPrompt || postHistoryInstructions))
  if (!looksLikeCard) return null

  const alternateGreetings = strArray(data.alternate_greetings ?? data.alternateGreetings)
  const tags = strArray(data.tags)
  const creator = str(data.creator)
  const version = str(data.character_version) || str(data.characterVersion)
  const creatorNotes = str(data.creator_notes) || str(data.creatorNotes)
  const worldEntries = parseWorldEntries(characterBook)
  const extensions = asObject(data.extensions) || asObject(root.extensions)
  const rules = extensions?.regex_scripts ?? extensions?.regexScripts ?? data.regex_scripts ?? data.regexScripts
  const regexRuleCount = Array.isArray(rules) ? rules.length : 0
  const regexScripts = parseRegexScripts(rules)

  const unknownFields = Object.keys(data).filter((key) => !KNOWN_CARD_FIELDS.has(key))
  const unsupported: string[] = []
  const unusedExtensions = extensions
    ? Object.keys(extensions).filter((key) => key !== 'regex_scripts' && key !== 'regexScripts')
    : []
  if (unusedExtensions.length) {
    unsupported.push(`扩展字段（extensions）未启用：${unusedExtensions.slice(0, 6).join('、')}`)
  }
  const bookObj = asObject(characterBook)
  if (regexRuleCount) unsupported.push(`原卡声明 ${regexRuleCount} 条正则规则；生成的试玩页不执行这些规则或其替换文本。`)
  if (Array.isArray(bookObj?.entries)) {
    const top = bookObj.entries.filter((e) => asObject(e)?.position === 'system_top').length
    if (top) unsupported.push(`${top} 条世界书指定 system_top；基础试玩不复现此插入位置。`)
  }
  const bookExtensions = bookObj ? asObject(bookObj.extensions) : null
  if (bookExtensions && Object.keys(bookExtensions).length) unsupported.push('世界书扩展字段未启用')
  if (Array.isArray(data.group_only_greetings) && data.group_only_greetings.length) unsupported.push('群聊专属开场白未启用')
  if (data.assets || data.avatar) unsupported.push('自定义资源字段（assets / avatar）未启用')
  if (unknownFields.length) unsupported.push(`未知字段已保留：${unknownFields.slice(0, 8).join('、')}`)

  return {
    spec,
    name: name || '未命名角色',
    description,
    personality,
    scenario,
    firstMes,
    mesExample,
    creatorNotes,
    systemPrompt,
    postHistoryInstructions,
    alternateGreetings,
    tags,
    creator,
    version,
    worldEntries,
    regexRuleCount,
    regexScripts,
    unsupported,
    unknownFields,
    raw,
  }
}

export function summarizeCard(data: CharacterCardData, format: 'json' | 'png'): CharacterCardSummary {
  return {
    name: data.name,
    spec: data.spec,
    format,
    unsupported: data.unsupported,
    worldEntries: data.worldEntries.length,
  }
}

/* ───────────────────────────── PNG 元数据 ───────────────────────────── */

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const MAX_PNG_SCAN = 25 * 1024 * 1024

function base64ToText(base64: string): string {
  const clean = base64.replace(/\s+/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function decodeCardText(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    try {
      return JSON.parse(base64ToText(trimmed))
    } catch {
      return null
    }
  }
}

function parseTextChunk(type: string, payload: Uint8Array): { keyword: string; text: string } | null {
  const decoder = new TextDecoder()
  const zero = payload.indexOf(0)
  if (zero < 0) return null
  const keyword = decoder.decode(payload.subarray(0, zero))
  if (type === 'tEXt') {
    return { keyword, text: decoder.decode(payload.subarray(zero + 1)) }
  }
  // iTXt：keyword\0 compressionFlag compressionMethod languageTag\0 translatedKeyword\0 text
  let p = zero + 1
  if (p + 2 > payload.length) return null
  const compressed = payload[p] !== 0
  p += 2
  const langEnd = payload.indexOf(0, p)
  if (langEnd < 0) return null
  p = langEnd + 1
  const transEnd = payload.indexOf(0, p)
  if (transEnd < 0) return null
  p = transEnd + 1
  if (compressed) return { keyword, text: '' }
  return { keyword, text: decoder.decode(payload.subarray(p)) }
}

export async function readPngCardJson(blob: Blob): Promise<unknown | null> {
  if (blob.size > MAX_PNG_SCAN) return null
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.length < 20) return null
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  const candidates: { priority: number; json: unknown }[] = []
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) break
    if (type === 'tEXt' || type === 'iTXt') {
      const parsed = parseTextChunk(type, bytes.subarray(dataStart, dataEnd))
      if (parsed && ['chara', 'ccv3', 'character'].includes(parsed.keyword.toLowerCase()) && parsed.text) {
        const json = decodeCardText(parsed.text)
        if (json != null && parseCharacterCardJson(json)) candidates.push({ priority: parsed.keyword.toLowerCase() === 'ccv3' ? 0 : parsed.keyword.toLowerCase() === 'chara' ? 1 : 2, json })
      }
    }
    offset = dataEnd + 4
  }
  return candidates.sort((a, b) => a.priority - b.priority)[0]?.json ?? null
}

/* ───────────────────────────── 文件识别 ───────────────────────────── */

/** 从上传/资料文件识别角色卡：JSON 文本或 PNG 元数据。 */
export async function parseCharacterCardFromFile(
  name: string,
  mime: string,
  text: string | undefined,
  blob: Blob | undefined,
): Promise<ParsedCharacterCard | null> {
  const lowerName = String(name || '').toLowerCase()
  const lowerMime = String(mime || '').toLowerCase()

  if (text && (lowerName.endsWith('.json') || lowerMime.includes('json') || text.trim().startsWith('{'))) {
    try {
      const data = parseCharacterCardJson(JSON.parse(text))
      if (data) return { data, summary: summarizeCard(data, 'json'), format: 'json' }
    } catch {
      /* 不是合法 JSON */
    }
  }

  if (blob && (lowerName.endsWith('.png') || lowerMime === 'image/png')) {
    try {
      const json = await readPngCardJson(blob)
      if (json != null) {
        const data = parseCharacterCardJson(json)
        if (data) return { data, summary: summarizeCard(data, 'png'), format: 'png', avatarBlob: blob }
      }
    } catch {
      /* PNG 元数据不可读 */
    }
  }
  return null
}

/* ───────────────────────────── 世界书触发（关键词 + 递归） ───────────────────────────── */

export interface WorldSelectOptions {
  maxEntries?: number
  maxChars?: number
  /** 递归展开轮数上限；0 表示只做一次关键词匹配 */
  maxDepth?: number
  /** 概率条目使用；测试可注入确定性随机 */
  rng?: () => number
}

export interface WorldSelection {
  entries: WorldBookEntry[]
  /** 实际用到的递归轮数（0 = 只有首次匹配） */
  depth: number
  triggered: { name: string; depth: number; constant: boolean }[]
  /** 因预算被丢弃的条目数 */
  skipped: number
}

export const DEFAULT_WORLD_MAX_ENTRIES = 4
export const DEFAULT_WORLD_MAX_CHARS = 4000
export const DEFAULT_WORLD_MAX_DEPTH = 2

/** 关键词命中后再扫描已命中条目正文，最多展开 maxDepth 轮。 */
export function selectWorldEntriesDeep(
  data: CharacterCardData,
  text: string,
  options: WorldSelectOptions = {},
): WorldSelection {
  const maxEntries = options.maxEntries ?? DEFAULT_WORLD_MAX_ENTRIES
  const maxChars = options.maxChars ?? DEFAULT_WORLD_MAX_CHARS
  const maxDepth = Math.max(0, options.maxDepth ?? DEFAULT_WORLD_MAX_DEPTH)
  const rng = options.rng || Math.random

  const picked = new Map<string, { entry: WorldBookEntry; depth: number }>()
  let scan = String(text || '').toLowerCase()
  let usedDepth = 0

  for (let depth = 0; depth <= maxDepth; depth++) {
    const added: WorldBookEntry[] = []
    for (const entry of data.worldEntries) {
      if (!entry.enabled || !entry.content) continue
      if (picked.has(entry.id)) continue
      const hit = entry.constant || entry.keys.some((key) => key && scan.includes(key.toLowerCase()))
      if (!hit) continue
      if (entry.useProbability && typeof entry.probability === 'number' && rng() * 100 >= entry.probability) continue
      added.push(entry)
    }
    if (!added.length) break
    for (const entry of added) picked.set(entry.id, { entry, depth })
    usedDepth = depth
    scan += '\n' + added.map((entry) => entry.content.toLowerCase()).join('\n')
  }

  const candidates = Array.from(picked.values()).sort(
    (a, b) =>
      Number(b.entry.constant) - Number(a.entry.constant) ||
      a.entry.order - b.entry.order ||
      a.entry.name.localeCompare(b.entry.name),
  )

  const entries: WorldBookEntry[] = []
  const triggered: WorldSelection['triggered'] = []
  let chars = 0
  let skipped = 0
  for (const { entry, depth } of candidates) {
    if (entries.length >= maxEntries || chars + entry.content.length > maxChars) {
      skipped++
      continue
    }
    entries.push({ ...entry })
    triggered.push({ name: entry.name, depth, constant: entry.constant })
    chars += entry.content.length
  }

  return { entries, depth: usedDepth, triggered, skipped }
}

export function selectWorldEntries(
  data: CharacterCardData,
  text: string,
  maxEntries = DEFAULT_WORLD_MAX_ENTRIES,
  maxChars = DEFAULT_WORLD_MAX_CHARS,
): WorldBookEntry[] {
  return selectWorldEntriesDeep(data, text, { maxEntries, maxChars }).entries
}

/* ───────────────────────────── 变量宏 ───────────────────────────── */

export interface MacroContext {
  charName: string
  userName?: string
  vars?: Record<string, string>
  rng?: () => number
}

const MACRO_RE = /\{\{\s*([a-zA-Z_]+)((?:::[^{}]*)*)\s*\}\}/g

/** 支持 char/user/newline/getvar/setvar/addvar/random/pick，其余宏原样保留。 */
export function resolveCardMacros(text: string, ctx: MacroContext): { text: string; vars: Record<string, string> } {
  const vars = ctx.vars || (ctx.vars = {})
  const rng = ctx.rng || Math.random
  const out = String(text ?? '').replace(MACRO_RE, (whole, rawName: string, rawArgs: string) => {
    const name = rawName.toLowerCase()
    const args = rawArgs ? rawArgs.split('::').slice(1) : []
    switch (name) {
      case 'char':
        return ctx.charName || ''
      case 'user':
        return ctx.userName || '用户'
      case 'newline':
        return '\n'
      case 'getvar':
        return args[0] ? vars[args[0]] ?? '' : ''
      case 'setvar':
        if (!args[0]) return ''
        vars[args[0]] = args.slice(1).join('::')
        return ''
      case 'addvar': {
        const key = args[0]
        if (!key) return ''
        vars[key] = (vars[key] || '') + args.slice(1).join('::')
        return ''
      }
      case 'random':
      case 'pick': {
        const pool = args
          .join('::')
          .split(/[,，]/)
          .map((item) => item.trim())
          .filter(Boolean)
        if (!pool.length) return ''
        const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)))
        return pool[index]
      }
      default:
        return whole
    }
  })
  return { text: out, vars }
}

export function fillCardPlaceholders(text: string, charName: string, userName = '用户'): string {
  return resolveCardMacros(text, { charName, userName }).text
}

export interface WorldPlacement {
  beforeChar: WorldBookEntry[]
  afterChar: WorldBookEntry[]
  beforeExample: WorldBookEntry[]
  afterExample: WorldBookEntry[]
  atDepth: WorldBookEntry[]
}

/** 按 position 把命中条目分组；at_depth 不进入系统提示，改为对话消息。 */
export function groupWorldEntries(entries: WorldBookEntry[]): WorldPlacement {
  const out: WorldPlacement = { beforeChar: [], afterChar: [], beforeExample: [], afterExample: [], atDepth: [] }
  for (const entry of entries) {
    if (entry.position === 'after_char') out.afterChar.push(entry)
    else if (entry.position === 'before_example') out.beforeExample.push(entry)
    else if (entry.position === 'after_example') out.afterExample.push(entry)
    else if (entry.position === 'at_depth') out.atDepth.push(entry)
    else out.beforeChar.push(entry)
  }
  return out
}

function renderEntries(entries: WorldBookEntry[], fill: (text: string) => string): string {
  if (!entries.length) return ''
  return entries.map((entry) => `## ${entry.name}\n${fill(entry.content)}`).join('\n\n')
}

export interface CharacterChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface CharacterMessagesOptions {
  userName?: string
  vars?: Record<string, string>
  rng?: () => number
  /** at_depth 缺省深度 */
  defaultDepth?: number
}

export interface CharacterMessages {
  system: string
  messages: { role: WorldRole; content: string }[]
  /** 供 UI 说明：被插入为对话消息的条目 */
  injectedAtDepth: { name: string; role: WorldRole; depth: number }[]
}

/**
 * 组装一次请求：系统提示 + 历史 + at_depth 世界书消息。
 * at_depth 的深度按「距最后一条消息的轮数」计算，0 表示追加在末尾。
 */
export function buildCharacterMessages(
  data: CharacterCardData,
  worldEntries: WorldBookEntry[],
  history: CharacterChatTurn[],
  options: CharacterMessagesOptions = {},
): CharacterMessages {
  const system = buildCharacterSystemPrompt(data, worldEntries, options)
  const placement = groupWorldEntries(worldEntries)
  const fill = createFill(data, options)
  const turns: { role: WorldRole; content: string }[] = [{ role: 'system', content: system }]
  for (const turn of history) turns.push({ role: turn.role, content: String(turn.content || '') })

  const defaultDepth = Math.max(0, Math.floor(options.defaultDepth ?? 4))
  const planned = placement.atDepth.map((entry, index) => ({
    entry,
    index,
    depth: Math.max(0, Math.floor(entry.depth ?? defaultDepth)),
    role: entry.role || 'system',
  }))
  const total = turns.length
  const withIndex = planned
    .map((item) => ({ ...item, at: Math.max(1, Math.min(total, total - item.depth)) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)

  let offset = 0
  for (const item of withIndex) {
    const content = fill(item.entry.content)
    if (!content.trim()) continue
    turns.splice(item.at + offset, 0, { role: item.role, content })
    offset++
  }

  if (data.postHistoryInstructions) turns.push({ role: 'system', content: fill(data.postHistoryInstructions).replace(/\{\{\s*original\s*\}\}/gi, '') })
  return {
    system,
    messages: turns,
    injectedAtDepth: planned.map((item) => ({ name: item.entry.name, role: item.role, depth: item.depth })),
  }
}

function createFill(
  data: CharacterCardData,
  ctx?: { userName?: string; vars?: Record<string, string>; rng?: () => number },
): (text: string) => string {
  const macroCtx: MacroContext = { charName: data.name, userName: ctx?.userName, vars: ctx?.vars ?? {}, rng: ctx?.rng }
  return (text: string) => resolveCardMacros(text, macroCtx).text
}

export function buildCharacterSystemPrompt(
  data: CharacterCardData,
  worldEntries: WorldBookEntry[],
  ctx?: { userName?: string; vars?: Record<string, string>; rng?: () => number },
): string {
  const fill = createFill(data, ctx)
  const placement = groupWorldEntries(worldEntries)
  // 先求值角色字段，让 {{setvar}} 在渲染世界书之前生效；输出顺序仍在下面重排。
  const description = fill(data.description)
  const personality = fill(data.personality)
  const scenario = fill(data.scenario)
  const mesExample = fill(data.mesExample)
  const before = renderEntries(placement.beforeChar, fill)
  const after = renderEntries(placement.afterChar, fill)
  const beforeExample = renderEntries(placement.beforeExample, fill)
  const afterExample = renderEntries(placement.afterExample, fill)

  const original = `You are roleplaying as "${data.name}". Stay in character and reply as this character.\nNever speak, decide, or act for the user.`
  const effective = data.systemPrompt ? fill(data.systemPrompt).replace(/\{\{\s*original\s*\}\}/gi, () => original) : original
  const lines: string[] = [effective, '']
  if (before) lines.push('# World info', before, '')
  if (data.description) lines.push('# Character', description, '')
  if (data.personality) lines.push('# Personality', personality, '')
  if (data.scenario) lines.push('# Scenario', scenario, '')
  if (after) lines.push('# World info (after character)', after, '')
  if (beforeExample) lines.push('# World info (before examples)', beforeExample, '')
  if (data.mesExample) lines.push('# Example dialogue', mesExample, '')
  if (afterExample) lines.push('# World info (after examples)', afterExample, '')
  if (placement.atDepth.length) {
    lines.push(
      '# Injected world info',
      `另有 ${placement.atDepth.length} 条世界书条目按深度插入为对话消息，不在系统提示里重复。`,
      '',
    )
  }
  return lines.join('\n')
}
