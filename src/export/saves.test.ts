import { describe, expect, it } from 'vitest'
import {
  SAVE_MAX_ENTRIES,
  createSaveBundle,
  isReservedSaveKey,
  readSaveBundle,
} from './saves'

describe('存档包', () => {
  it('导出时剔除 AI 配置', () => {
    const bundle = createSaveBundle(
      { score: 3, name: '阿岚', 'ai:config': { apiKey: 'sk-secret' }, 'ai:extra': 1 },
      { source: 'standalone', app: 'demo', now: 0 },
    )
    expect(bundle.format).toBe('rpagent-saves')
    expect(bundle.version).toBe(1)
    expect(bundle.exportedAt).toBe(new Date(0).toISOString())
    expect(Object.keys(bundle.entries)).toEqual(['score', 'name'])
    expect(isReservedSaveKey('ai:config')).toBe(true)
    expect(isReservedSaveKey('aiff')).toBe(false)
  })

  it('导入时校验格式与版本', () => {
    expect(() => readSaveBundle(null)).toThrow(/JSON 对象/)
    expect(() => readSaveBundle({ format: 'other', version: 1, entries: {} })).toThrow(/format/)
    expect(() => readSaveBundle({ format: 'rpagent-saves', version: 2, entries: {} })).toThrow(/版本/)
    expect(() => readSaveBundle({ format: 'rpagent-saves', version: 1 })).toThrow(/entries/)
  })

  it('保留合法条目并跳过保留键', () => {
    const result = readSaveBundle({
      format: 'rpagent-saves',
      version: 1,
      entries: { score: 3, list: [1, 2], 'ai:config': { apiKey: 'k' } },
    })
    expect(result.entries).toEqual({ score: 3, list: [1, 2] })
    expect(result.skipped).toEqual(['ai:config'])
    expect(result.warnings.join(' ')).toContain('跳过 1 个条目')
  })

  it('拒绝超量条目与超大单条', () => {
    const tooMany: Record<string, number> = {}
    for (let i = 0; i <= SAVE_MAX_ENTRIES; i++) tooMany[`k${i}`] = i
    expect(() => readSaveBundle({ format: 'rpagent-saves', version: 1, entries: tooMany })).toThrow(/条目过多/)

    const big = 'x'.repeat(300 * 1024)
    const result = readSaveBundle({ format: 'rpagent-saves', version: 1, entries: { big, small: 1 } })
    expect(result.entries).toEqual({ small: 1 })
    expect(result.skipped).toEqual(['big'])
  })
})
