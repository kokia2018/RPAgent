import { afterEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { createTask, getWorkspaceFile, listWorkspaceFiles, writeWorkspaceText } from '../db/repo'
import { computeDeliveryLevel, exportHtml, prepareHtmlExport } from './exportHtml'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('导出交付检查', () => {
  it('准备阶段不写 dist，冻结检查过的字节而非再次读取工作区', async () => {
    const { id } = await createTask('指定入口')
    await writeWorkspaceText(id, '/a.html', '<h1>A</h1>')
    await writeWorkspaceText(id, '/b.html', '<h1>B</h1>')
    const prepared = await prepareHtmlExport(id, '/b.html', 'page')
    expect(prepared.entryPath).toBe('/b.html')
    expect(prepared.html).toContain('<h1>B</h1>')
    expect(await listWorkspaceFiles(id)).toHaveLength(2)
    await writeWorkspaceText(id, '/b.html', '<h1>B changed</h1>')
    expect(prepared.html).not.toContain('changed')
    expect(await getWorkspaceFile(id, prepared.report.path)).toBeUndefined()
  })

  it.each(['<iframe src="child.html"></iframe>', '<object data="child.html"></object>', '<link rel="preload" href="child.html">'])(
    '工作区存在但未嵌入的引用不能报离线：%s', async (html) => {
      const { id } = await createTask('未打包引用')
      await writeWorkspaceText(id, '/index.html', html)
      await writeWorkspaceText(id, '/child.html', '<p>child</p>')
      const { report } = await prepareHtmlExport(id, '/index.html')
      expect(report.level).toBe('incomplete')
      expect(report.checks.missing).toEqual([])
      expect(report.checks.unbundled).toEqual(['/child.html'])
    },
  )

  it('Agent 导出不能覆盖已有源码', async () => {
    const { id } = await createTask('路径冲突')
    await writeWorkspaceText(id, '/index.html', '<p>new</p>')
    await writeWorkspaceText(id, '/dist/app.html', '<p>原作品</p>')
    await expect(exportHtml(id, '/index.html', 'app')).rejects.toThrow('源文件冲突')
    expect((await getWorkspaceFile(id, '/dist/app.html'))?.text).toBe('<p>原作品</p>')
  })
  it.each([
    ['./missing.js', 'incomplete', ['/pages/lib/missing.js'], []],
    ['https://cdn.example.com/lib.js', 'needs-network', [], ['https://cdn.example.com/lib.js']],
  ] as const)('内联模块的传递依赖 %s 决定交付评级', async (ref, level, missing, external) => {
    const { id } = await createTask('模块导出')
    const entry = '/pages/index.html'
    await writeWorkspaceText(id, entry, `<script type="module">import './lib/main.js'</script>`)
    await writeWorkspaceText(id, '/pages/lib/main.js', `export * from '${ref}'`)
    expect(await exportHtml(id, entry)).toMatchObject({ level, checks: { missing, external } })
  })

  it.each([
    ["import('./' + name)", '无法静态确定动态 import'],
    ["import './main.js'", '循环依赖'],
  ])('未完整打包的模块不标为可离线运行：%s', async (code, reason) => {
    const { id } = await createTask('模块限制')
    await writeWorkspaceText(id, '/index.html', `<script type="module">import './main.js'</script>`)
    await writeWorkspaceText(id, '/main.js', code)
    const result = await exportHtml(id, '/index.html')
    expect(result.level).toBe('incomplete')
    expect(result.checks.missing).toEqual([])
    expect(result.warnings.join('\n')).toContain(reason)
  })

  it.each([
    ['Workbench.storage.get("count")', true, false, 'offline-static'],
    ['Workbench.ai.chat({})', false, true, 'needs-network'],
    ['Workbench.storage; Workbench.ai', true, true, 'needs-network'],
    ['Workbench.preview.sessionId', false, false, 'needs-workbench'],
    ['Workbench.storage; Workbench.preview.sessionId', false, false, 'needs-workbench'],
    ['Workbench.ai; fetch("/__vfs__/file")', false, false, 'needs-workbench'],
    ['42', false, false, 'offline-static'],
  ] as const)('按被打包的叶子模块判断运行时：%s', async (expression, storage, ai, level) => {
    const { id } = await createTask('独立模块')
    await writeWorkspaceText(id, '/index.html', `<script type="module">import './lib/start.js'</script>`)
    await writeWorkspaceText(id, '/lib/start.js', `import('./leaf.js')`)
    await writeWorkspaceText(id, '/lib/leaf.js', expression)
    await writeWorkspaceText(id, '/unused.js', 'Workbench.preview; Workbench.ai; Workbench.storage')
    const result = await exportHtml(id, '/index.html')
    expect(result.capabilities).toEqual({ storage, ai })
    expect(result.level).toBe(level)
    if (level === 'needs-workbench') expect(result.checks.workbenchRefs.length).toBeGreaterThan(0)
  })

  it('模块编码前检查疑似密钥，报告去重脱敏且忽略未引用文件', async () => {
    const { id } = await createTask('导出检查')
    const sample = 'sk-test-fixture-12345678'
    await writeWorkspaceText(id, '/index.html', `<script type="module">import './leaf.js'; import './other.js'</script>`)
    for (const path of ['/leaf.js', '/other.js']) await writeWorkspaceText(id, path, `export default '${sample}'`)
    await writeWorkspaceText(id, '/unused.js', `export default 'sk-unused-fixture-12345678'`)
    const result = await exportHtml(id, '/index.html')
    expect(result.checks.secrets).toEqual([sample.slice(0, 12) + '…'])
    expect(JSON.stringify(result)).not.toContain(sample)
  })

  it('缺失资源优先判定为不完整', () => {
    expect(
      computeDeliveryLevel({
        missing: ['/a.png'],
        external: ['https://x'],
        workbenchRefs: ['Workbench API'],
        blobRefs: ['blob:x'],
        secrets: [],
      }),
    ).toBe('incomplete')
  })

  it('工作台依赖高于外部网络', () => {
    expect(
      computeDeliveryLevel({
        missing: [],
        external: ['https://x'],
        workbenchRefs: ['Workbench API'],
        blobRefs: [],
        secrets: [],
      }),
    ).toBe('needs-workbench')
  })

  it('仅有外部资源时标记需要联网', () => {
    expect(
      computeDeliveryLevel({
        missing: [],
        external: ['https://x'],
        workbenchRefs: [],
        blobRefs: [],
        secrets: [],
      }),
    ).toBe('needs-network')
  })

  it('纯本地资源为离线静态', () => {
    expect(
      computeDeliveryLevel({
        missing: [],
        external: [],
        workbenchRefs: [],
        blobRefs: [],
        secrets: [],
      }),
    ).toBe('offline-static')
  })
})
