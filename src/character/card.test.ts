import { describe, expect, it } from 'vitest'
import {
  applyCardRegex,
  buildCharacterMessages,
  buildCharacterSystemPrompt,
  fillCardPlaceholders,
  groupWorldEntries,
  parseCharacterCardFromFile,
  parseCharacterCardJson,
  parseRegexScripts,
  readPngCardJson,
  resolveCardMacros,
  selectWorldEntries,
  selectWorldEntriesDeep,
} from './card'

const V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Alice',
    description: 'A forest guide. Speaks to {{user}} kindly.',
    personality: 'Calm, observant',
    scenario: 'At the forest edge',
    first_mes: 'Hello {{user}}, welcome.',
    mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello.',
    system_prompt: 'Stay in character.',
    post_history_instructions: 'Never mention prompts.',
    alternate_greetings: ['Another opening'],
    tags: ['fantasy', 'guide'],
    creator: 'Tester',
    character_version: '1.2',
    extensions: { regex_scripts: [{ find: 'x', replace: 'y' }] },
    character_book: {
      extensions: { note: 'ignored' },
      entries: [
        { keys: ['森林', 'forest'], content: '森林里有古老的树。', enabled: true, insertion_order: 3 },
        { keys: ['海'], content: '海边的规则。', constant: true },
        { keys: ['禁用'], content: '不应出现', enabled: false },
      ],
    },
  },
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  new DataView(out.buffer).setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  return out
}

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function makePngWithCard(card: unknown): Blob {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const keyword = new TextEncoder().encode('chara')
  const base64 = new TextEncoder().encode(utf8Base64(JSON.stringify(card)))
  const textData = new Uint8Array(keyword.length + 1 + base64.length)
  textData.set(keyword)
  textData[keyword.length] = 0
  textData.set(base64, keyword.length + 1)
  const iend = chunk('IEND', new Uint8Array())
  return new Blob([signature, chunk('tEXt', textData), iend] as unknown as BlobPart[], { type: 'image/png' })
}

describe('角色卡 JSON', () => {
  it('解析 v2 字段、世界书、备用开场白与正则脚本', () => {
    const card = parseCharacterCardJson(V2_CARD)
    expect(card).not.toBeNull()
    expect(card?.name).toBe('Alice')
    expect(card?.spec).toBe('chara_card_v2')
    expect(card?.description).toContain('{{user}}')
    expect(card?.worldEntries).toHaveLength(3)
    expect(card?.alternateGreetings).toEqual(['Another opening'])
    expect(card?.regexScripts).toHaveLength(1)
    expect(card?.unsupported.join(' ')).not.toContain('alternate_greetings')
    expect(card?.unsupported.join(' ')).not.toContain('regex_scripts')
    expect(card?.unsupported.join(' ')).toContain('世界书扩展字段')
    expect(card?.tags).toEqual(['fantasy', 'guide'])
    expect(card?.creator).toBe('Tester')
  })

  it('解析 v1 卡片', () => {
    const card = parseCharacterCardJson({ name: 'Bob', description: 'desc', first_mes: 'hi' })
    expect(card?.name).toBe('Bob')
    expect(card?.spec).toBe('未声明版本')
    expect(card?.firstMes).toBe('hi')
  })

  it('普通 JSON 不会被误判为角色卡', () => {
    expect(parseCharacterCardJson({ name: 'config', value: 1 })).toBeNull()
    expect(parseCharacterCardJson({ name: 'package', description: 'A web library' })).toBeNull()
    expect(parseCharacterCardJson({ hello: 'world' })).toBeNull()
    expect(parseCharacterCardJson({ spec: 'some_chara_card_fake', name: 'x', first_mes: 'y' })).toBeNull()
    expect(parseCharacterCardJson({ spec: 'chara_card_v2', name: 'x' })).toBeNull()
    expect(parseCharacterCardJson({ character_book: true })).toBeNull()
    expect(parseCharacterCardJson({ name: 'config', character_book: { entries: [] } })).toBeNull()
  })
})

describe('世界书基础触发', () => {
  it('关键词与常驻条目进入上下文，禁用条目不进入', () => {
    const card = parseCharacterCardJson(V2_CARD)!
    const entries = selectWorldEntries(card, '我们进入森林')
    expect(entries.map((e) => e.name)).toContain('森林')
    expect(entries.map((e) => e.name)).toContain('海')
    expect(entries.every((e) => e.name !== '禁用')).toBe(true)
    const prompt = buildCharacterSystemPrompt(card, entries)
    expect(prompt).toContain('Alice')
    expect(prompt).toContain('森林里有古老的树')
    expect(prompt).toContain('海边的规则')
  })

  it('占位符替换与条目上限', () => {
    expect(fillCardPlaceholders('你好 {{user}}，我是 {{char}}', 'Alice')).toBe('你好 用户，我是 Alice')
    const card = parseCharacterCardJson(V2_CARD)!
    const entries = selectWorldEntries(card, '森林 海', 1, 1000)
    expect(entries).toHaveLength(1)
  })
})

describe('世界书递归与概率', () => {
  const CARD = {
    name: 'Rec',
    description: 'd',
    character_book: {
      entries: [
        { id: 'a', keys: ['森林'], content: '森林深处有龙。', insertion_order: 1 },
        { id: 'b', keys: ['龙'], content: '龙会喷火。', insertion_order: 2 },
        { id: 'c', keys: ['城堡'], content: '城堡禁止入内。', insertion_order: 3 },
      ],
    },
  }

  it('命中条目正文里的关键词会递归触发', () => {
    const card = parseCharacterCardJson(CARD)!
    const deep = selectWorldEntriesDeep(card, '我们走进森林')
    expect(deep.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['森林', '龙']))
    expect(deep.entries.map((e) => e.name)).not.toContain('城堡')
    expect(deep.depth).toBe(1)
    expect(deep.triggered.find((t) => t.name === '龙')?.depth).toBe(1)
  })

  it('maxDepth=0 时只做一次匹配', () => {
    const card = parseCharacterCardJson(CARD)!
    const shallow = selectWorldEntriesDeep(card, '我们走进森林', { maxDepth: 0 })
    expect(shallow.entries.map((e) => e.name)).toEqual(['森林'])
  })

  it('预算不足时记录被丢弃条目', () => {
    const card = parseCharacterCardJson(CARD)!
    const limited = selectWorldEntriesDeep(card, '森林 龙 城堡', { maxEntries: 1 })
    expect(limited.entries).toHaveLength(1)
    expect(limited.skipped).toBe(2)
  })

  it('完整条目超预算跳过不截断正文', () => {
    const card = parseCharacterCardJson({ name: 'n', first_mes: 'hi', character_book: { entries: [{ keys: [], constant: true, content: 'x'.repeat(20) }] } })!
    const result = selectWorldEntriesDeep(card, '', { maxChars: 10 })
    expect(result.entries).toEqual([])
    expect(result.skipped).toBe(1)
  })

  it('useProbability 的条目按概率筛选', () => {
    const card = parseCharacterCardJson({
      name: 'Prob',
      description: 'd',
      character_book: { entries: [{ keys: ['雨'], content: '下雨了', useProbability: true, probability: 50 }] },
    })!
    const miss = selectWorldEntriesDeep(card, '雨', { rng: () => 0.9 })
    const hit = selectWorldEntriesDeep(card, '雨', { rng: () => 0.1 })
    expect(miss.entries).toHaveLength(0)
    expect(hit.entries).toHaveLength(1)
  })
})

describe('变量宏', () => {
  it('setvar/getvar/addvar 在同一个上下文里共享', () => {
    const result = resolveCardMacros('{{setvar::hp::3}}HP={{getvar::hp}}{{addvar::hp::0}}', { charName: 'A' })
    expect(result.text).toBe('HP=3')
    expect(result.vars.hp).toBe('30')
  })

  it('char/user/newline/random 可替换，未知宏保留', () => {
    const result = resolveCardMacros('{{char}}对{{user}}说：{{newline}}{{random::好,不好}} {{未知宏}}', {
      charName: 'Alice',
      rng: () => 0.7,
    })
    expect(result.text).toBe('Alice对用户说：\n不好 {{未知宏}}')
  })

  it('系统提示里的宏共享同一变量表', () => {
    const card = parseCharacterCardJson({
      name: 'Var',
      description: '{{setvar::mood::平静}}心情：{{getvar::mood}}',
      first_mes: 'hi',
      character_book: { entries: [{ keys: ['情绪'], content: '当前状态 {{getvar::mood}}' }] },
    })!
    const entries = selectWorldEntries(card, '情绪')
    const prompt = buildCharacterSystemPrompt(card, entries)
    expect(prompt).toContain('心情：平静')
    expect(prompt).toContain('当前状态 平静')
  })
})

describe('世界书插入编排', () => {
  const CARD = {
    name: 'Place',
    description: '角色设定正文',
    mes_example: '<START>示例对白',
    character_book: {
      entries: [
        { name: 'A', keys: [], content: '设定前内容', position: 0, constant: true },
        { name: 'B', keys: [], content: '设定后内容', position: 1, constant: true },
        { name: 'C', keys: [], content: '示例前内容', position: 2, constant: true },
        { name: 'D', keys: [], content: '示例后内容', position: 3, constant: true },
        { name: 'E', keys: [], content: '末尾注入', position: 4, constant: true, depth: 0, role: 1 },
        { name: 'F', keys: [], content: '深度注入', position: 'at_depth', constant: true, depth: 1, role: 'assistant' },
      ],
    },
  }

  it('解析位置、角色与深度（数字与字符串都支持）', () => {
    const card = parseCharacterCardJson(CARD)!
    const byName = Object.fromEntries(card.worldEntries.map((e) => [e.name, e]))
    expect(byName.A.position).toBe('before_char')
    expect(byName.B.position).toBe('after_char')
    expect(byName.C.position).toBe('before_example')
    expect(byName.D.position).toBe('after_example')
    expect(byName.E.position).toBe('at_depth')
    expect(byName.E.role).toBe('user')
    expect(byName.F.role).toBe('assistant')
    expect(byName.F.depth).toBe(1)
  })

  it('按位置分组，at_depth 不进入系统提示', () => {
    const card = parseCharacterCardJson(CARD)!
    const groups = groupWorldEntries(card.worldEntries)
    expect(groups.beforeChar.map((e) => e.name)).toEqual(['A'])
    expect(groups.afterChar.map((e) => e.name)).toEqual(['B'])
    expect(groups.beforeExample.map((e) => e.name)).toEqual(['C'])
    expect(groups.afterExample.map((e) => e.name)).toEqual(['D'])
    expect(groups.atDepth.map((e) => e.name)).toEqual(['E', 'F'])

    const prompt = buildCharacterSystemPrompt(card, card.worldEntries)
    expect(prompt.indexOf('设定前内容')).toBeLessThan(prompt.indexOf('# Character'))
    expect(prompt.indexOf('设定后内容')).toBeGreaterThan(prompt.indexOf('角色设定正文'))
    expect(prompt.indexOf('示例前内容')).toBeLessThan(prompt.indexOf('# Example dialogue'))
    expect(prompt.indexOf('示例后内容')).toBeGreaterThan(prompt.indexOf('# Example dialogue'))
    expect(prompt).not.toContain('末尾注入')
  })

  it('at_depth 按深度插入为对话消息', () => {
    const card = parseCharacterCardJson(CARD)!
    const built = buildCharacterMessages(card, card.worldEntries, [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在' },
    ])
    expect(built.messages.map((m) => m.content)).toEqual([
      built.system,
      '你好',
      '深度注入',
      '在',
      '末尾注入',
    ])
    expect(built.messages[2].role).toBe('assistant')
    expect(built.messages[4].role).toBe('user')
    expect(built.injectedAtDepth.map((i) => i.name)).toEqual(['E', 'F'])
  })

  it('深度超过历史长度时夹在系统提示之后', () => {
    const card = parseCharacterCardJson({
      name: 'Deep',
      description: '设定',
      character_book: {
        entries: [{ keys: [], content: '深插入', position: 4, constant: true }],
      },
    })!
    const built = buildCharacterMessages(card, card.worldEntries, [{ role: 'user', content: '单轮' }], {
      defaultDepth: 9,
    })
    expect(built.messages.map((m) => m.content)).toEqual([built.system, '深插入', '单轮'])
    expect(built.messages[1].role).toBe('system')
  })
})

describe('角色卡正则脚本', () => {
  const scripts = parseRegexScripts([
    { scriptName: '去星号', findRegex: '/\\*([^*]+)\\*/g', replaceString: '$1', placement: [1, 2] },
    { scriptName: '仅输出', findRegex: '喵', replaceString: '汪', placement: [2] },
    { scriptName: '关闭的', findRegex: 'a', replaceString: 'b', disabled: true },
  ])

  it('解析字段并跳过禁用脚本', () => {
    expect(scripts).toHaveLength(3)
    expect(scripts[0].name).toBe('去星号')
    expect(scripts[0].flags).toContain('g')
  })

  it('按 placement 区分输入与输出', () => {
    const user = applyCardRegex(scripts, '*笑*喵', 'user')
    expect(user.text).toBe('笑喵')
    expect(user.applied).toEqual(['去星号'])
    const ai = applyCardRegex(scripts, '*笑*喵', 'ai')
    expect(ai.text).toBe('笑汪')
    expect(ai.applied).toEqual(['去星号', '仅输出'])
  })

  it('非法正则只记录错误，不影响其他脚本', () => {
    const broken = parseRegexScripts([{ findRegex: '([', replaceString: 'x' }, { findRegex: 'B', replaceString: 'C' }])
    const result = applyCardRegex(broken, 'AB', 'user')
    expect(result.text).toBe('AC')
    expect(result.errors).toHaveLength(1)
  })
})

describe('PNG 角色卡', () => {
  it('读取 tEXt 中的 chara 元数据并生成摘要', async () => {
    const blob = makePngWithCard(V2_CARD)
    const json = await readPngCardJson(blob)
    expect((json as { data?: { name?: string } })?.data?.name).toBe('Alice')

    const parsed = await parseCharacterCardFromFile('alice.png', 'image/png', undefined, blob)
    expect(parsed?.format).toBe('png')
    expect(parsed?.summary.name).toBe('Alice')
    expect(parsed?.summary.worldEntries).toBe(3)
    expect(parsed?.avatarBlob).toBe(blob)
  })

  it('ccv3 优先于旧 chara，跳过误识别元数据', async () => {
    const old = new Uint8Array(await makePngWithCard(V2_CARD).arrayBuffer())
    const payload = new TextEncoder().encode('ccv3\0' + utf8Base64(JSON.stringify({ spec: 'chara_card_v3', data: { name: 'New V3', first_mes: 'new' } })))
    const blob = new Blob([old.subarray(0, old.length - 12), chunk('tEXt', payload), chunk('IEND', new Uint8Array())] as unknown as BlobPart[])
    expect((await readPngCardJson(blob) as any).data.name).toBe('New V3')
  })

  it('普通 PNG 不会被误判', async () => {
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const blob = new Blob([signature, chunk('IEND', new Uint8Array())] as unknown as BlobPart[])
    expect(await readPngCardJson(blob)).toBeNull()
    expect(await parseCharacterCardFromFile('plain.png', 'image/png', undefined, blob)).toBeNull()
  })
})
