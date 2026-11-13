import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  detectRuntimeNeeds,
  injectBeforeFirstScript,
  injectStandaloneRuntime,
  standaloneAiShim,
  standaloneStorageShim,
} from './standaloneRuntime'
import { computeDeliveryLevel } from './exportHtml'

function emptyChecks() {
  return { missing: [], external: [], workbenchRefs: [], blobRefs: [], secrets: [] }
}

function scriptBody(shim: string): string {
  return shim.replace(/^<script>/, '').replace(/<\/script>$/, '')
}

describe('运行时需求检测', () => {
  it('区分子页面 API 与预览桥', () => {
    expect(detectRuntimeNeeds('<script>Workbench.storage.get("a")</script>')).toEqual({
      storage: true,
      ai: false,
      preview: false,
      vfs: false,
    })
    expect(detectRuntimeNeeds('<script>Workbench.ai.chat({})</script>').ai).toBe(true)
    const both = detectRuntimeNeeds('<script>Workbench.preview.sessionId; Workbench.storage</script>')
    expect(both.preview).toBe(true)
    expect(both.storage).toBe(true)
    expect(detectRuntimeNeeds('<div>纯静态</div>')).toEqual({ storage: false, ai: false, preview: false, vfs: false })
  })
})

describe('交付等级', () => {
  it('独立 AI 运行时不算离线但也不是工作台依赖', () => {
    expect(computeDeliveryLevel(emptyChecks(), { networkRuntime: true })).toBe('needs-network')
    expect(computeDeliveryLevel(emptyChecks())).toBe('offline-static')
    expect(computeDeliveryLevel({ ...emptyChecks(), workbenchRefs: ['Workbench API'] })).toBe('needs-workbench')
    expect(computeDeliveryLevel({ ...emptyChecks(), missing: ['/a.png'] })).toBe('incomplete')
  })
})

describe('注入位置与组合', () => {
  it('注入早于页面首个脚本', () => {
    const html = '<html><head><script>window.order=1</script></head><body></body></html>'
    const out = injectBeforeFirstScript(html, '<script>window.before=1</script>')
    expect(out.indexOf('window.before')).toBeLessThan(out.indexOf('window.order'))
  })

  it('没有脚本时插入 head，没有 head 时插入 body 开头', () => {
    expect(injectBeforeFirstScript('<html><head></head></html>', '<script>x</script>')).toContain('<script>x</script></head>')
    expect(injectBeforeFirstScript('<body class="a"></body>', '<script>x</script>')).toContain('<body class="a"><script>x</script>')
  })

  it('只注入页面实际用到的运行时', () => {
    const storageOnly = injectStandaloneRuntime('<script>Workbench.storage</script>', {
      prefix: 'workbench:t:',
      appName: 't',
    })
    expect(storageOnly.injected).toEqual(['storage'])
    expect(storageOnly.html).not.toContain('Workbench.ai=')

    const aiOnly = injectStandaloneRuntime('<script>Workbench.ai</script>', { prefix: 'workbench:t:', appName: 't' })
    expect(aiOnly.injected).toEqual(['ai'])
    expect(aiOnly.html).not.toContain('window.Workbench.storage=')

    const none = injectStandaloneRuntime('<div>x</div>', { prefix: 'workbench:t:', appName: 't' })
    expect(none.injected).toEqual([])
    expect(none.html).toBe('<div>x</div>')
  })

  it('shim 使用传入命名空间，不包含密钥占位以外的敏感内容', () => {
    const shim = standaloneAiShim({ prefix: 'workbench:demo:', appName: 'demo' })
    expect(shim).toContain('workbench:demo:ai:config')
    expect(shim).toContain('AI 设置')
    expect(shim).not.toContain('__WORKBENCH_PREVIEW__')
  })
})

describe('注入后的运行时行为（jsdom）', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    cleanups.splice(0).forEach((fn) => fn())
    localStorage.clear()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  function install(shim: string) {
    document.body.innerHTML = ''
    localStorage.clear()
    // jsdom 默认不执行动态插入的脚本，这里直接求值整段 shim。
    new Function(scriptBody(shim))()
  }

  it('storage 适配按前缀读写 localStorage', async () => {
    install(standaloneStorageShim('workbench:demo:'))
    const wb = (window as unknown as { Workbench: any }).Workbench
    await wb.storage.set('score', 3)
    expect(localStorage.getItem('workbench:demo:score')).toBe('3')
    await expect(wb.storage.get('score')).resolves.toBe(3)
    await wb.storage.remove('score')
    await expect(wb.storage.get('score')).resolves.toBeUndefined()
  })

  it('存档可导出与导入，且不触碰 AI 配置', async () => {
    install(standaloneStorageShim('workbench:demo:', 'demo'))
    const wb = (window as unknown as { Workbench: any }).Workbench
    await wb.storage.set('score', 5)
    localStorage.setItem('workbench:demo:ai:config', JSON.stringify({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-keep' }))

    const bundle = await wb.storage.export()
    expect(bundle.format).toBe('rpagent-saves')
    expect(bundle.entries).toEqual({ score: 5 })
    expect(await wb.storage.keys()).toEqual(['score'])

    const result = await wb.storage.import({
      format: 'rpagent-saves',
      version: 1,
      exportedAt: '',
      source: 'preview',
      entries: { score: 9, extra: 'x', 'ai:config': { apiKey: 'sk-bad' } },
    })
    expect(result.imported).toBe(2)
    await expect(wb.storage.get('score')).resolves.toBe(9)
    await expect(wb.storage.get('extra')).resolves.toBe('x')
    expect(JSON.parse(localStorage.getItem('workbench:demo:ai:config') || '{}').apiKey).toBe('sk-keep')
  })

  it('拒绝非法存档包', async () => {
    install(standaloneStorageShim('workbench:demo:', 'demo'))
    const wb = (window as unknown as { Workbench: any }).Workbench
    await expect(wb.storage.import({ hello: 'world' })).rejects.toThrow(/不是存档包/)
    await expect(wb.storage.import({ format: 'rpagent-saves', version: 9, entries: {} })).rejects.toThrow(/版本/)
  })

  it('独立模型列表不泄露 Key，拒绝继承宿主档案 ID', async () => {
    install(standaloneAiShim({ prefix: 'workbench:demo:', appName: 'demo' }))
    localStorage.setItem('workbench:demo:ai:config', JSON.stringify({ baseUrl: 'https://api.test/v1', model: 'm', apiKey: 'private-key' }))
    const wb = (window as any).Workbench
    expect(await wb.ai.getProfiles()).toEqual([{ profileId: 'default', name: '本作品配置', model: 'm', baseUrl: 'https://api.test/v1' }])
    await expect(wb.ai.chat({ profileId: 'host-profile', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('default')
  })
  it('未配置时拒绝请求并给出可操作提示', async () => {
    install(standaloneAiShim({ prefix: 'workbench:demo:', appName: 'demo' }))
    const wb = (window as unknown as { Workbench: any }).Workbench
    await expect(wb.ai.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/AI 设置/)
    expect(document.querySelector('[data-workbench-ai-ui]')).toBeTruthy()
  })

  it('配置后按 SSE 解析流式片段', async () => {
    install(standaloneAiShim({ prefix: 'workbench:demo:', appName: 'demo' }))
    localStorage.setItem(
      'workbench:demo:ai:config',
      JSON.stringify({ baseUrl: 'https://api.test/v1/', model: 'm', apiKey: 'k' }),
    )
    const sse = [
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const encoder = new TextEncoder()
    let index = 0
    const body = {
      getReader: () => ({
        read: async () =>
          index < sse.length
            ? { done: false, value: encoder.encode(sse[index++]) }
            : { done: true, value: undefined },
      }),
    }
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const wb = (window as unknown as { Workbench: any }).Workbench
    const chunks: string[] = []
    const reply = await wb.ai.chat({
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: (text: string) => chunks.push(text),
    })
    expect(chunks).toEqual(['你', '好'])
    expect(reply.text).toBe('你好')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    expect(String(init.body)).toContain('"stream":true')
  })

  it('拒绝非法消息与工作台专属字段', async () => {
    install(standaloneAiShim({ prefix: 'workbench:demo:', appName: 'demo' }))
    localStorage.setItem(
      'workbench:demo:ai:config',
      JSON.stringify({ baseUrl: 'https://api.test/v1', model: 'm', apiKey: '' }),
    )
    const wb = (window as unknown as { Workbench: any }).Workbench
    await expect(wb.ai.chat({ messages: [] })).rejects.toThrow(/不能为空/)
    await expect(wb.ai.chat({ messages: [{ role: 'tool', content: 'x' }] })).rejects.toThrow(/角色/)
  })
})
