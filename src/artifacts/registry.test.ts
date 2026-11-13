import { describe, expect, it } from 'vitest'
import { assembleCharacterArtifact, checkComponents, detectArtifact } from './registry'
import { exportCharacterCardJson, patchCharacterSource, validateCharacterCardV2, validateCharacterSource } from './cardCodec'

const raw = { vendorEnvelope: { flag: true }, spec: 'chara_card_v2', spec_version: '2.0', data: { name: '角色', first_mes: '开场', description: '长'.repeat(50000), customNested: { secretStory: ['x', { untouched: 42 }] }, extensions: { customUI: '<script>x()</script>' } } }

describe('实际组件注册、检测与编码', () => {
  it('对完整同源固定版本确定性装配，并保留长字段/未知信封及扩展', () => {
    const one = assembleCharacterArtifact(raw, { artifactId: 'stable-id' })
    const two = assembleCharacterArtifact(JSON.parse(JSON.stringify(raw)), { artifactId: 'stable-id' })
    expect(two).toEqual(one)
    expect(JSON.parse(one.sourceText)).toEqual(raw)
    expect(one.html).toContain('长'.repeat(50000))
    expect(one.html).toContain('customNested')
    expect(one.manifest.source.hash).toBe(one.manifest.revision)
    expect(one.manifest.components.map(c => c.id)).toEqual(['workbench-runtime', 'character-base'])
    expect(one.manifest.config.saveKey).toBe('character:stable-id')
    expect(one.path).not.toBe(one.sourcePath)
    expect(() => checkComponents([{ id: 'character-base', version: '999' }])).toThrow('缺少组件')
    expect(() => assembleCharacterArtifact(raw, { artifactId: '../escape' })).toThrow()
  })

  it('检测角色之外的 txt/md/json/HTML/无卡图片，不请求网络或执行源', async () => {
    expect((await detectArtifact({ name: 'notes.txt', text: 'notes' })).format).toBe('txt')
    expect((await detectArtifact({ name: 'notes.md', text: '# notes' })).kind).toBe('document')
    expect((await detectArtifact({ name: 'config.json', text: '{"name":"config","description":"not a card"}' })).format).toBe('json')
    expect((await detectArtifact({ name: 'app.html', text: '<button>test</button>' })).status).toBe('runnable')
    expect((await detectArtifact({ name: 'image.png', blob: new Blob(['not a png'], { type: 'image/png' }) })).kind).toBe('image')
    expect((await detectArtifact({ name: 'doc.pdf', blob: new Blob(['binary']) })).status).toBe('unsupported')
    expect((await detectArtifact({ name: 'bad.json', text: '{broken' })).warnings).toHaveLength(1)
    expect((await detectArtifact({ name: 'card.json', text: JSON.stringify(raw) })).status).toBe('assemblable')
  })

  it('original roundtrip 保结构，仅编辑指定字段，不将 V2 转换冒充原格式', () => {
    const patched = patchCharacterSource(raw, { firstMes: '新开场', name: '新名字' }) as typeof raw
    expect(patched.data.customNested).toEqual(raw.data.customNested)
    expect(patched.vendorEnvelope).toEqual(raw.vendorEnvelope)
    expect(patched.data.description.length).toBe(50000)
    expect(raw.data.first_mes).toBe('开场')
    const original = exportCharacterCardJson(patched, 'original')
    expect(JSON.parse(original.text)).toEqual(patched)
    const v1 = { name: 'Legacy', firstMessage: 'Hi', custom: { kept: true } }
    const modified = patchCharacterSource(v1, { firstMes: 'Changed' }) as typeof v1
    expect(modified.firstMessage).toBe('Changed')
    const v2 = exportCharacterCardJson(modified, 'v2')
    const decoded = JSON.parse(v2.text)
    expect(decoded.spec).toBe('chara_card_v2')
    expect(decoded.spec_version).toBe('2.0')
    expect(decoded.data.first_mes).toBe('Changed')
    expect(decoded.data.custom).toEqual(v1.custom)
    expect(decoded.data.extensions).toEqual({})
    expect(validateCharacterSource(decoded).name).toBe('Legacy')
    expect(() => validateCharacterCardV2(decoded)).not.toThrow()
    expect(() => validateCharacterCardV2(raw)).toThrow('必需字符串')
    expect(v2.warnings.join()).toContain('不是原格式写回')
  })

  it('拒绝错误字段类型、伪规范与未经验证的降版', () => {
    expect(() => validateCharacterSource({ spec: 'chara_card_v2', data: { name: 42 } })).toThrow('字符串')
    expect(() => validateCharacterSource({ name: 'n', first_mes: 'hi', alternate_greetings: [42] })).toThrow('字符串数组')
    expect(() => exportCharacterCardJson({ ...raw, spec: 'chara_card_v3' }, 'v2')).toThrow('降版')
    expect(() => validateCharacterSource({ spec: 'something_chara_card', data: { name: 'wrong' } })).toThrow()
  })
})
