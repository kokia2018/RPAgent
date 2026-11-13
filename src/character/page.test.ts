import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { addTaskAttachment, attachmentWorkspacePath, importAttachmentsToWorkspace } from '../db/assets'
import { createTask, getWorkspaceFile, listWorkspaceFiles, writeWorkspaceText } from '../db/repo'
import { prepareHtmlExport } from '../export/exportHtml'
import { createCharacterPage, generateCharacterHtml, updateCharacterArtifact } from './page'
import { parseCharacterCardJson } from './card'
import player from './player.js?raw'

const raw = { spec: 'chara_card_v2', data: { name: '森林向导', description: '测试角色', first_mes: '你好，{{user}}。', character_book: { entries: [
  { keys: ['森林'], content: '前方有一座灯塔。', enabled: true },
] } } }

beforeEach(async () => { await db.open(); await Promise.all(db.tables.map((t) => t.clear())) })
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.useRealTimers(); delete (window as any).Workbench; delete (window as any).CharacterArtifact })

async function mount(card = parseCharacterCardJson(raw)!) {
  document.documentElement.innerHTML = generateCharacterHtml(card, 'character:test').replace(/<script>[\s\S]*?<\/script>/g, '')
  const saved = new Map<string, unknown>()
  const chat = vi.fn(async (request: any) => { request.onChunk('你好，冒险者。'); return { text: '你好，冒险者。' } })
  const set = vi.fn(async (key: string, value: unknown) => { saved.set(key, structuredClone(value)) })
  const getProfiles = vi.fn(async () => [{ profileId: 'test-profile', name: '测试玩法', model: 'test-model', baseUrl: 'https://configured.invalid' }])
  ;(window as any).Workbench = { storage: { get: async (key: string) => saved.get(key), set }, ai: { chat, getProfiles } }
  new Function(player)()
  await vi.waitFor(() => expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false))
  return { chat, saved, set, getProfiles }
}

describe('上传与角色网页路径', () => {
  it('多文件导入后重复打开保留已改副本并可补传资源', async () => {
    const task = await createTask('上传')
    const a = await addTaskAttachment(task.id, new File(['<script src="app.js"></script>'], 'index.html', { type: 'text/html' }), 'demo/index.html')
    await importAttachmentsToWorkspace(task.id)
    const path = attachmentWorkspacePath(a.name)
    await writeWorkspaceText(task.id, path, '<h1>修改后</h1>')
    await addTaskAttachment(task.id, new File(['console.log(1)'], 'app.js', { type: 'text/javascript' }), 'demo/app.js')
    const again = await importAttachmentsToWorkspace(task.id)
    expect(again.kept).toContain(path)
    expect(again.replaced).toEqual([])
    expect(again.htmlEntries).toContain(path)
    expect((await getWorkspaceFile(task.id, path))?.text).toBe('<h1>修改后</h1>')
    expect((await getWorkspaceFile(task.id, '/uploads/demo/app.js'))?.text).toContain('console.log')
  })

  it('生成两个可编辑入口，不覆盖原卡且导出有独立 AI 与存储', async () => {
    const task = await createTask('角色生成')
    const attachment = await addTaskAttachment(task.id, new File([JSON.stringify(raw)], 'card.json', { type: 'application/json' }))
    const first = await createCharacterPage(task.id, attachment.id)
    const second = await createCharacterPage(task.id, attachment.id)
    expect(first.path).not.toBe(second.path)
    expect(await listWorkspaceFiles(task.id)).toHaveLength(6)
    expect(JSON.parse((await getWorkspaceFile(task.id, first.sourcePath!))!.text!)).toEqual(raw)
    expect(JSON.parse((await getWorkspaceFile(task.id, first.manifestPath!))!.text!).revision).toBe(first.revision)
    const out = await prepareHtmlExport(task.id, first.path)
    expect(out.report.level).toBe('needs-network')
    expect(out.report.capabilities).toEqual({ ai: true, storage: true })
    expect(out.html).toContain('character-data')
    expect(out.html).not.toContain('/__vfs__/')
    expect((await db.attachments.get(attachment.id))?.hash).toBe(attachment.hash)
    const other = await createTask('另一个任务')
    await expect(createCharacterPage(other.id, attachment.id)).rejects.toThrow('不属于')
  })

  it('卡内标记作为文本，不产生脚本节点；无模型请求也能看开场', async () => {
    const card = parseCharacterCardJson({ ...raw, data: { ...raw.data, first_mes: '</script><img src=x onerror=alert(1)> {{user}}', extensions: { regex_scripts: [{ regex: 'x', replacement: '<script>bad()</script>' }] } } })!
    const { chat } = await mount(card)
    expect(document.querySelectorAll('#messages img')).toHaveLength(0)
    expect(document.getElementById('messages')?.textContent).toContain('<img src=x onerror=alert(1)> 玩家')
    expect(chat).not.toHaveBeenCalled()
    expect(document.getElementById('card-details')?.textContent).toContain('1 条')
  })

  it('真实表单事件请求基础世界书，保存历史，重新装载仍可续玩', async () => {
    const { chat, saved } = await mount()
    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = '进入森林'
    document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(saved.has('character:test')).toBe(true))
    expect(chat).toHaveBeenCalledOnce()
    expect(chat.mock.calls[0][0].messages[0].content).toContain('灯塔')
    expect(document.getElementById('messages')?.textContent).toContain('你好，冒险者。')
    new Function(player)()
    await vi.waitFor(() => expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false))
    expect(document.getElementById('messages')?.textContent).toContain('进入森林')
  })

  it('源驱动重组保留稳定存档键，重复幂等，分叉/过期 revision 拒绝而保旧文件', async () => {
    const task = await createTask('重组')
    const attachment = await addTaskAttachment(task.id, new File([JSON.stringify(raw)], 'card.json'))
    const first = await createCharacterPage(task.id, attachment.id)
    const oldManifest = JSON.parse((await getWorkspaceFile(task.id, first.manifestPath!))!.text!)
    const updatedRaw = { ...raw, data: { ...raw.data, first_mes: '新开场', unrecognized: { x: 123 } } }
    const changed = await updateCharacterArtifact(task.id, first.manifestPath!, updatedRaw, { expectedRevision: first.revision })
    expect(JSON.parse((await getWorkspaceFile(task.id, first.manifestPath!))!.text!).config.saveKey).toBe(oldManifest.config.saveKey)
    expect(JSON.parse((await getWorkspaceFile(task.id, first.sourcePath!))!.text!)).toEqual(updatedRaw)
    const repeated = await updateCharacterArtifact(task.id, first.manifestPath!, updatedRaw, { expectedRevision: changed.revision })
    expect(repeated.revision).toBe(changed.revision)
    await expect(updateCharacterArtifact(task.id, first.manifestPath!, raw, { expectedRevision: first.revision })).rejects.toThrow('revision')
    await writeWorkspaceText(task.id, first.path, '<h1>custom fork</h1>')
    await expect(updateCharacterArtifact(task.id, first.manifestPath!, raw)).rejects.toThrow('自定义分叉')
    expect((await getWorkspaceFile(task.id, first.path))!.text).toBe('<h1>custom fork</h1>')
    expect(JSON.parse((await getWorkspaceFile(task.id, first.sourcePath!))!.text!)).toEqual(updatedRaw)
  })

  it('请求系统替换/后指令顺序/助手开场/结构化示例与世界书位置正确，长字段不截断', async () => {
    const card = parseCharacterCardJson({ ...raw, data: { ...raw.data, description: '长'.repeat(19000), system_prompt: '定制 {{original}}', post_history_instructions: '最后 {{original}}', mes_example: '<START>\n{{user}}: 示例问\n{{char}}: 示例答', character_book: { entries: [
      { name: '前', keys: [], content: '设定前', constant: true, position: 'before_char' },
      { name: '后', keys: [], content: '示例后', constant: true, position: 'after_example' },
      { name: '深', keys: [], content: '历史深度', constant: true, position: 'at_depth', depth: 0, role: 'user' },
    ] } } })!
    const { chat, saved } = await mount(card)
    ;(document.getElementById('post-preset') as HTMLTextAreaElement).value = '原始后指令'
    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = '请求'
    document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(saved.size).toBe(1))
    const req = chat.mock.calls[0][0].messages
    expect(req[0].content).toContain('定制 你在互动故事')
    expect(req[0].content).toContain('长'.repeat(19000))
    expect(req[0].content.indexOf('设定前')).toBeLessThan(req[0].content.indexOf('# Character'))
    expect(req.slice(1, 4)).toEqual([{ role: 'user', content: '示例问' }, { role: 'assistant', content: '示例答' }, { role: 'system', content: '## 后\n示例后' }])
    expect(req).toContainEqual({ role: 'assistant', content: '你好，玩家。' })
    expect(req[req.length - 2]).toEqual({ role: 'user', content: '历史深度' })
    expect(req.at(-1)).toEqual({ role: 'system', content: '最后 原始后指令' })
  })

  it('超预算请求拒绝不静默砍设定；近期遗漏有提示且全本地历史保留', async () => {
    const { chat, saved } = await mount(parseCharacterCardJson({ ...raw, data: { ...raw.data, description: 'x'.repeat(60001) } })!)
    ;(document.getElementById('chat-input') as HTMLTextAreaElement).value = 'hi'
    document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(chat).not.toHaveBeenCalled()
    expect(saved.size).toBe(0)
    expect(document.getElementById('notice')!.textContent).toContain('未截断')
    await mount()
    const built = (window as any).CharacterArtifact.buildRequest(Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) })))
    expect(built.omitted).toBe(6)
    expect(built.messages.at(-1).content).toBe('29')
  })

  it('流式停止取消底层且拒绝迟到成功，不写存档；超时相同', async () => {
    const { chat, set } = await mount()
    let complete!: (result: any) => void
    const transport = new Promise(resolve => { complete = resolve }) as Promise<any> & { cancel: ReturnType<typeof vi.fn> }
    transport.cancel = vi.fn()
    chat.mockImplementationOnce((req: any) => { req.onChunk('部分'); return transport })
    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'stop test'
    document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    ;(document.getElementById('stop') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(document.getElementById('notice')!.textContent).toContain('已停止'))
    complete({ text: 'late success' })
    await Promise.resolve()
    expect(set).not.toHaveBeenCalled()
    expect(transport.cancel).toHaveBeenCalledOnce()
    expect(input.value).toBe('stop test')
    vi.useFakeTimers()
    const never = new Promise<any>(() => {}) as Promise<any> & { cancel: ReturnType<typeof vi.fn> }
    never.cancel = vi.fn()
    chat.mockImplementationOnce(() => never)
    document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.advanceTimersByTimeAsync(120001)
    expect(never.cancel).toHaveBeenCalledOnce()
    expect(set).not.toHaveBeenCalled()
    expect(document.getElementById('notice')!.textContent).toContain('超时')
    vi.useRealTimers()
  })

  it('选 profileId 每请求冻结；基础编辑为显式未提交草稿且未知字段留在 JSON', async () => {
    const { chat } = await mount()
    const profile = document.getElementById('profile') as HTMLSelectElement
    expect(profile.textContent).toContain('测试玩法')
    expect(profile.textContent).toContain('test-model')
    profile.innerHTML = '<option value="one">one</option><option value="two">two</option>'
    profile.value = 'one'
    ;(document.getElementById('chat-input') as HTMLTextAreaElement).value = 'hi'
    document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    profile.value = 'two'
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce())
    expect(chat.mock.calls[0][0].profileId).toBe('one')
    await vi.waitFor(() => expect((document.getElementById('apply-card') as HTMLButtonElement).disabled).toBe(false))
    ;(document.getElementById('field-firstMes') as HTMLTextAreaElement).value = '新稿'
    ;(document.getElementById('apply-card') as HTMLButtonElement).click()
    expect(document.getElementById('edit-status')!.textContent).toContain('未提交草稿')
    expect((window as any).CharacterArtifact.getContent()).toEqual(raw)
    expect(JSON.parse((window as any).CharacterArtifact.encodeJson('original')).data.first_mes).toBe('新稿')
  })

  it('未授权错误不写坏历史，保留输入供授权后重试', async () => {
    const { chat, saved } = await mount()
    chat.mockRejectedValueOnce(new Error('此试玩尚未获得共享 AI 授权'))
    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = '你好'
    document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(document.getElementById('notice')?.textContent).toContain('尚未获得'))
    expect(saved.size).toBe(0)
    expect(input.value).toBe('你好')
    expect(document.getElementById('messages')?.textContent).toContain('你好，玩家')
  })
})
