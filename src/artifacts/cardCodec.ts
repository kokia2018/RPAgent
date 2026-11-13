import { parseCharacterCardJson, type CharacterCardData } from '../character/card'

export interface CardExport { text: string; mime: 'application/json'; extension: '.json'; warnings: string[]; target: 'original' | 'v2' }
export const CARD_FIELD_MAP = {
  name: 'name', description: 'description', personality: 'personality', scenario: 'scenario',
  firstMes: 'first_mes', mesExample: 'mes_example', creatorNotes: 'creator_notes', systemPrompt: 'system_prompt',
  postHistoryInstructions: 'post_history_instructions', alternateGreetings: 'alternate_greetings',
  tags: 'tags', creator: 'creator', version: 'character_version',
} as const
const aliases: Record<string, string> = { first_mes: 'firstMessage', mes_example: 'mesExample', creator_notes: 'creatorNotes', system_prompt: 'systemPrompt', post_history_instructions: 'postHistoryInstructions', alternate_greetings: 'alternateGreetings', character_version: 'characterVersion', character_book: 'characterBook' }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Validates the supported field mapping without mutating or projecting unknown fields. */
export function validateCharacterSource(raw: unknown): CharacterCardData {
  const card = parseCharacterCardJson(raw)
  if (!card || !object(raw)) throw new Error('不是支持的角色内容源')
  const data = object(raw.data) ? raw.data : raw
  for (const [normalized, key] of Object.entries(CARD_FIELD_MAP)) {
    for (const field of [key, aliases[key]].filter(Boolean)) {
      if (!(field in data)) continue
      const value = data[field]
      if (normalized === 'alternateGreetings' || normalized === 'tags') {
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error(`${field} 必须是字符串数组`)
      } else if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
    }
  }
  if (data.extensions != null && !object(data.extensions)) throw new Error('extensions 必须是对象')
  const book = data.character_book ?? data.characterBook
  if (book != null && (!object(book) || !Array.isArray(book.entries))) throw new Error('character_book.entries 必须是数组')
  if (object(book) && Array.isArray(book.entries)) for (const item of book.entries) {
    if (!object(item) || typeof item.content !== 'string' || (item.keys != null && !Array.isArray(item.keys) && typeof item.keys !== 'string')) throw new Error('世界书条目字段类型不支持')
  }
  return card
}

export function patchCharacterSource(raw: unknown, patch: Partial<Pick<CharacterCardData, keyof typeof CARD_FIELD_MAP>>): unknown {
  validateCharacterSource(raw)
  const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
  const data = object(copy.data) ? copy.data : copy
  for (const [normalized, value] of Object.entries(patch)) {
    const key = CARD_FIELD_MAP[normalized as keyof typeof CARD_FIELD_MAP]
    if (!key) throw new Error(`不支持的编辑字段：${normalized}`)
    const alias = aliases[key]
    const target = !(key in data) && alias && alias in data ? alias : key
    data[target] = value
    // If both spellings exist, keep them consistent rather than masking edits on re-import.
    if (alias && alias in data && key in data) data[alias] = value
  }
  validateCharacterSource(copy)
  return copy
}

export function validateCharacterCardV2(raw: unknown): void {
  if (!object(raw) || raw.spec !== 'chara_card_v2' || raw.spec_version !== '2.0' || !object(raw.data)) throw new Error('V2 必须有 chara_card_v2 / 2.0 标准信封')
  const data = raw.data
  for (const field of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version']) if (typeof data[field] !== 'string') throw new Error(`V2 必需字符串缺失：${field}`)
  for (const field of ['alternate_greetings', 'tags']) if (!Array.isArray(data[field]) || data[field].some((v: unknown) => typeof v !== 'string')) throw new Error(`V2 必需字符串数组缺失：${field}`)
  if (!object(data.extensions)) throw new Error('V2 extensions 必须是对象')
  if (data.character_book != null) {
    if (!object(data.character_book) || !Array.isArray(data.character_book.entries)) throw new Error('V2 character_book 无效')
    for (const e of data.character_book.entries) {
      if (!object(e) || typeof e.content !== 'string' || !Array.isArray(e.keys) || e.keys.some(k => typeof k !== 'string') || typeof e.enabled !== 'boolean' || typeof e.insertion_order !== 'number' || !Number.isFinite(e.insertion_order) || !object(e.extensions)) throw new Error('V2 世界书必需字段无效')
      if (e.position != null && e.position !== 'before_char' && e.position !== 'after_char') throw new Error('V2 世界书 position 必须映射为 before_char/after_char 或保留在扩展中')
    }
  }
}

/** Original is a structure-preserving JSON encoding; V2 is an explicitly different schema. */
export function exportCharacterCardJson(raw: unknown, target: 'original' | 'v2' = 'original'): CardExport {
  const card = validateCharacterSource(raw)
  if (!object(raw)) throw new Error('内容源必须是对象')
  let output: unknown = raw
  const warnings: string[] = []
  if (target === 'v2') {
    if (raw.spec === 'chara_card_v3') throw new Error('V3 到 V2 的降版映射尚未验证；请导出当前 V3 JSON 或 HTML')
    const source = object(raw.data) ? raw.data : raw
    const data: Record<string, unknown> = { ...source }
    for (const [normalized, key] of Object.entries(CARD_FIELD_MAP)) data[key] = card[normalized as keyof CharacterCardData]
    data.extensions = object(source.extensions) ? source.extensions : {}
    if (source.characterBook && !source.character_book) data.character_book = source.characterBook
    if (object(data.character_book) && Array.isArray(data.character_book.entries)) {
      data.character_book = { ...data.character_book, extensions: object(data.character_book.extensions) ? data.character_book.extensions : {}, entries: data.character_book.entries.map((entry, i) => {
        const e = entry as Record<string, unknown>
        const mapped: Record<string, unknown> = { ...e, keys: Array.isArray(e.keys) ? e.keys : String(e.keys || '').split(/[,，、]/).filter(Boolean), content: e.content, extensions: object(e.extensions) ? { ...e.extensions } : {}, enabled: e.enabled !== false && e.disable !== true, insertion_order: typeof e.insertion_order === 'number' ? e.insertion_order : typeof e.order === 'number' ? e.order : i, case_sensitive: e.case_sensitive === true, name: typeof e.name === 'string' ? e.name : '' }
        if (e.position === 0) mapped.position = 'before_char'
        else if (e.position === 1) mapped.position = 'after_char'
        else if (e.position != null && e.position !== 'before_char' && e.position !== 'after_char') {
          throw new Error(`世界书条目 ${i} 的位置不能无损映射为 V2 标准；请导出当前 JSON 或 HTML`)
        }
        return mapped
      }) }
    }
    output = { ...(object(raw.data) ? raw : {}), spec: 'chara_card_v2', spec_version: '2.0', data }
    warnings.push('此交付是指定 V2 JSON，不是原格式写回；组件运行层与聊天存档不在卡内。未知源字段及扩展保留，不保证其他宿主执行。')
  }
  const text = JSON.stringify(output, null, 2) + '\n'
  if (target === 'v2') validateCharacterCardV2(JSON.parse(text))
  const roundtrip = validateCharacterSource(JSON.parse(text))
  if (target === 'original' && JSON.stringify(roundtrip.raw) !== JSON.stringify(raw)) throw new Error('原格式往返验证失败')
  return { text, mime: 'application/json', extension: '.json', warnings, target }
}
