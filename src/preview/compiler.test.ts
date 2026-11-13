import { describe, expect, it } from 'vitest'
import { analyzeProject, compileInline, type ProjectFile } from './compiler'

function file(path: string, text: string, mime = 'text/plain'): ProjectFile {
  return { path, text, mime, size: new TextEncoder().encode(text).length }
}

describe('项目分析与内联编译', () => {
  const files: ProjectFile[] = [
    file(
      '/index.html',
      `<!doctype html><html><head>
        <link rel="stylesheet" href="/style.css">
        <script src="/game.js"></script>
        <script src="https://cdn.example.com/lib.js"></script>
      </head><body>
        <img src="/pic.svg">
        <img src="missing.png">
      </body></html>`,
      'text/html',
    ),
    file('/style.css', 'body{background:url("/pic.svg")} .x{color:red}', 'text/css'),
    file('/game.js', 'console.log("hello")', 'text/javascript'),
    file('/pic.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>', 'image/svg+xml'),
  ]

  it('分析缺失资源与外部依赖', async () => {
    const result = await analyzeProject('/index.html', files)
    expect(result.missing).toContain('/missing.png')
    expect(result.external).toContain('https://cdn.example.com/lib.js')
    expect(result.ok).toBe(false)
    expect(result.referenced).toBeGreaterThanOrEqual(3)
  })

  it('内联 CSS / JS / 图片，并移除本地 src', async () => {
    const result = await compileInline('/index.html', files)
    expect(result.html).toContain('<style')
    expect(result.html).toContain('color:red')
    expect(result.html).toContain('console.log("hello")')
    expect(result.html).toContain('data:image/svg+xml;base64,')
    expect(result.html).not.toContain('src="/style.css"')
    expect(result.html).not.toContain('src="/game.js"')
    expect(result.html).toContain('https://cdn.example.com/lib.js')
    expect(result.missing).toContain('/missing.png')
  })

  it('模块 import 递归重写为 data URL', async () => {
    const moduleFiles: ProjectFile[] = [
      file('/index.html', '<script type="module" src="/main.js"></script>', 'text/html'),
      file('/main.js', "import { x } from './util.js'; console.log(x)", 'text/javascript'),
      file('/util.js', 'export const x = 1', 'text/javascript'),
    ]
    const result = await compileInline('/index.html', moduleFiles)
    expect(result.html).toContain('data:text/javascript;base64,')
    expect(result.html).toContain('console.log(x)')
  })

  it.each(["import './lib/main.js'", "export * from './lib/main.js'", "import('./lib/main.js')"])(
    '子目录内联模块递归重写 %s', async (statement) => {
      const entry = '/pages/index.html'
      const leaf = 'export const value = 42'
      const { html } = await compileInline(entry, [
        file(entry, `<script type="module">${statement}</script>`),
        file('/pages/lib/main.js', "export * from '../leaf.js'"),
        file('/pages/leaf.js', leaf),
      ])
      const dataRef = /(['"])data:text\/javascript;base64,([\w+/=]+)\1/
      expect(html.replace(dataRef, "'./lib/main.js'")).toContain(statement)
      expect(html).toMatch(dataRef)
      const nested = atob(html.match(dataRef)![2])
      expect(nested.replace(dataRef, "'../leaf.js'")).toContain("export * from '../leaf.js'")
      expect(nested).toMatch(dataRef)
      expect(atob(nested.match(dataRef)![2])).toBe(leaf)
    },
  )

  it('不改写模块注释、字符串、普通内联脚本或 JSON', async () => {
    const entry = '/pages/index.html'
    const ref = "import('./real.js')"
    const literals = `// ${ref}\nconst example = "${ref}"; /* import './absent.js' */`
    const classic = `<script>${ref}</script>`
    const json = `<script type="application/json">{"example":"${ref}"}</script>`
    const result = await compileInline(entry, [
      file(entry, `<script type="module">${ref};\n${literals}</script>${classic}${json}`),
      file('/pages/real.js', 'export {}'),
    ])
    expect(result.missing).toEqual([])
    for (const unchanged of [literals, classic, json]) expect(result.html).toContain(unchanged)
    expect(result.html).toMatch(/import\(['"]data:text\/javascript;base64,/)
  })

  it('检测工作台专用引用与 blob 引用', async () => {
    const wb = await analyzeProject('/index.html', [
      file(
        '/index.html',
        '<script>window.Workbench.storage.get("x"); fetch("/__vfs__/s/1/a.js")</script><img src="blob:abc">',
        'text/html',
      ),
    ])
    expect(wb.workbenchRefs.length).toBeGreaterThan(0)
    expect(wb.blobRefs.length).toBeGreaterThan(0)
  })

  it('根路径引用按工作区根解析', async () => {
    const result = await compileInline('/index.html', [
      file('/index.html', '<link rel="stylesheet" href="/assets/app.css">', 'text/html'),
      file('/assets/app.css', 'body{margin:0}', 'text/css'),
    ])
    expect(result.html).toContain('body{margin:0}')
    expect(result.ok).toBe(true)
  })
})
