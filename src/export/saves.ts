/** 作品存档包：`Workbench.storage` 的导入/导出格式。
 *
 * 同一份格式同时用于：
 * - 工作台试玩（`preview` 命名空间）
 * - 导出的单 HTML（localStorage 前缀命名空间）
 * 因此用户可以把试玩里的存档导出成 JSON，再在导出作品里导入，反之亦然。
 *
 * 刻意排除 AI 配置：`ai:*` 键里可能含用户的 API Key，绝不进入存档包。
 */

export const SAVE_BUNDLE_FORMAT = 'rpagent-saves'
export const SAVE_BUNDLE_VERSION = 1
export const SAVE_MAX_ENTRIES = 200
export const SAVE_MAX_ENTRY_BYTES = 256 * 1024
export const SAVE_MAX_TOTAL_BYTES = 2 * 1024 * 1024
export const SAVE_MAX_KEY_LENGTH = 200

export interface SaveBundle {
  format: typeof SAVE_BUNDLE_FORMAT
  version: number
  exportedAt: string
  /** 来源：preview = 工作台试玩，standalone = 导出文件 */
  source: 'preview' | 'standalone'
  app?: string
  entries: Record<string, unknown>
}

export interface SaveImportResult {
  entries: Record<string, unknown>
  skipped: string[]
  warnings: string[]
}

/** AI 配置（含 Key）不参与导出/导入。 */
export function isReservedSaveKey(key: string): boolean {
  return key === 'ai:config' || key.startsWith('ai:')
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function createSaveBundle(
  entries: Record<string, unknown>,
  meta: { source: 'preview' | 'standalone'; app?: string; now?: number },
): SaveBundle {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (isReservedSaveKey(key)) continue
    clean[key] = value
  }
  return {
    format: SAVE_BUNDLE_FORMAT,
    version: SAVE_BUNDLE_VERSION,
    exportedAt: new Date(meta.now ?? Date.now()).toISOString(),
    source: meta.source,
    app: meta.app,
    entries: clean,
  }
}

/** 校验并清洗外部存档包；不合法时抛出带中文说明的错误。 */
export function readSaveBundle(input: unknown): SaveImportResult {
  const warnings: string[] = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('存档包必须是 JSON 对象')
  }
  const bundle = input as Partial<SaveBundle>
  if (bundle.format !== SAVE_BUNDLE_FORMAT) {
    throw new Error(`不是存档包：format 应为 ${SAVE_BUNDLE_FORMAT}`)
  }
  if (bundle.version !== SAVE_BUNDLE_VERSION) {
    throw new Error(`不支持的存档包版本：${String(bundle.version)}`)
  }
  const rawEntries = bundle.entries
  if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) {
    throw new Error('存档包缺少 entries 对象')
  }
  const keys = Object.keys(rawEntries)
  if (keys.length > SAVE_MAX_ENTRIES) {
    throw new Error(`存档条目过多（${keys.length} > ${SAVE_MAX_ENTRIES}）`)
  }

  const entries: Record<string, unknown> = {}
  const skipped: string[] = []
  let total = 0
  for (const key of keys) {
    if (!key || key.length > SAVE_MAX_KEY_LENGTH) {
      skipped.push(key.slice(0, 32) || '(空键)')
      continue
    }
    if (isReservedSaveKey(key)) {
      skipped.push(key)
      continue
    }
    const value = (rawEntries as Record<string, unknown>)[key]
    let serialized = ''
    try {
      serialized = JSON.stringify(value)
    } catch {
      skipped.push(key)
      continue
    }
    if (serialized === undefined) {
      skipped.push(key)
      continue
    }
    const size = byteLength(serialized)
    if (size > SAVE_MAX_ENTRY_BYTES) {
      skipped.push(key)
      continue
    }
    total += size
    if (total > SAVE_MAX_TOTAL_BYTES) {
      throw new Error(`存档包过大（超过 ${Math.round(SAVE_MAX_TOTAL_BYTES / 1024)}KB）`)
    }
    entries[key] = value
  }

  if (skipped.length) warnings.push(`已跳过 ${skipped.length} 个条目：${skipped.slice(0, 6).join('、')}`)
  return { entries, skipped, warnings }
}
