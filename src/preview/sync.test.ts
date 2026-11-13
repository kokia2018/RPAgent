import { describe, expect, it } from 'vitest'
import { injectInlineBridge, transformPreviewHtml } from './sync'

describe('试玩桥接注入', () => {
  it('注入 bootstrap 与 bridge，并重写根路径资源', () => {
    const html = `<html><head><script src="/app.js"></script></head>
      <body><img src="/a.png"><img src="https://x.test/a.png"><img src="//cdn.test/a.png"></body></html>`
    const out = transformPreviewHtml(html, 'sess_1', 42, true)
    expect(out).toContain('__WORKBENCH_PREVIEW__')
    expect(out).toContain('"sessionId":"sess_1"')
    expect(out).toContain('"buildVersion":42')
    expect(out).toContain('/__vfs__/s/sess_1/__bridge.js')
    expect(out).toContain('src="/__vfs__/s/sess_1/app.js"')
    expect(out).toContain('src="/__vfs__/s/sess_1/a.png"')
    expect(out).toContain('https://x.test/a.png')
    expect(out).toContain('//cdn.test/a.png')
  })

  it('重写 CSS 中的根路径 url()', () => {
    const html = `<html><head><style>body{background:url(/a.png)}</style></head></html>`
    const out = transformPreviewHtml(html, 's1', 1, true)
    expect(out).toContain('url(/__vfs__/s/s1/a.png)')
  })

  it('内联降级模式把 bridge 源码直接嵌入', () => {
    const out = injectInlineBridge('<html><head></head><body>hi</body></html>', 's2', 7)
    expect(out).toContain('__WORKBENCH_PREVIEW__')
    expect(out).toContain('"virtualOrigin":false')
    expect(out).toContain('window.Workbench')
    expect(out).toContain('storageRequest')
    expect(out).toContain('Unhandled rejection')
  })
})
