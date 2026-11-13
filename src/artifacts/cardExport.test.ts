import { describe, expect, it } from 'vitest'
import { buildV3Envelope, embedCardInPng, encodeCardFile, readPngChunks } from './cardExport'

const cover = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='), c => c.charCodeAt(0))
const raw = { name: '中性测试', description: '', personality: '', scenario: '', first_mes: '你好', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', creator: '', character_version: '', alternate_greetings: [], tags: [], extensions: { custom: { unchanged: true } } }
const metadata = (bytes: Uint8Array) => {
  const data = readPngChunks(bytes).find(c => c.type === 'tEXt')!.data
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(new TextDecoder().decode(data.subarray(data.indexOf(0) + 1))), c => c.charCodeAt(0))))
}

describe('工作区角色卡产物', () => {
  it('封面图像块保持不变，当前数据写入 chara 并能往返', () => {
    const out = encodeCardFile(raw, 'png', cover)
    expect(metadata(out.bytes).data.extensions).toEqual(raw.extensions)
    expect(metadata(out.bytes).data.first_mes).toBe('你好')
    expect(readPngChunks(out.bytes).filter(c => c.type !== 'tEXt')).toEqual(readPngChunks(cover))
  })
  it('大卡分段编码且替换旧卡元数据', () => {
    const old = embedCardInPng(cover, { old: true }, 'ccv3')
    const card = { ...raw, description: '中文'.repeat(300000) }
    const out = encodeCardFile(card, 'png', old)
    expect(metadata(out.bytes).data.description).toBe(card.description)
    expect(readPngChunks(out.bytes).filter(c => c.type === 'tEXt')).toHaveLength(1)
  })
  it('拒绝校验失败、截断与缺少结束块的封面', () => {
    const bad = new Uint8Array(cover); bad[29] ^= 1
    expect(() => readPngChunks(bad)).toThrow('校验')
    expect(() => readPngChunks(cover.subarray(0, cover.length - 12))).toThrow('IEND')
    expect(() => readPngChunks(cover.subarray(0, 40))).toThrow()
  })
  it('V3 补齐核心字段并保留未知扩展，已有 V3 类型不正确则拒绝', () => {
    const { card } = buildV3Envelope(raw)
    expect(card.spec).toBe('chara_card_v3')
    expect((card.data as any).extensions).toEqual(raw.extensions)
    expect((card.data as any).assets).toEqual([])
    expect(() => buildV3Envelope({ ...card, data: { ...(card.data as any), assets: [42] } })).toThrow('assets')
    expect(() => buildV3Envelope({ ...card, data: { ...(card.data as any), source: [42] } })).toThrow('source')
  })
})
