import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
const { JSDOM } = createRequire(import.meta.url)('jsdom')
import bridge from './bridge.js?raw'

describe('默认试玩观察的数据范围', () => {
  it('不采集表单值、私有属性和整页正文，仍提供操作控件', async () => {
    const dom = new JSDOM('<!doctype html><button id="play">继续</button><input id="token" value="private-fixture" data-secret="private-fixture"><textarea>private-fixture</textarea><p>private-body</p>', { url: 'https://fixture.invalid', runScripts: 'outside-only', pretendToBeVisual: true })
    try {
      const w = dom.window
      const replies: any[] = []
      w.postMessage = ((data: unknown) => replies.push(data)) as any
      ;(w as any).__WORKBENCH_PREVIEW__ = { sessionId: 'test', buildVersion: 1 }
      w.eval(bridge)
      w.dispatchEvent(new w.MessageEvent('message', { source: w as any, data: { __wbCmd: 1, sessionId: 'test', requestId: 'snapshot', action: 'snapshot' } }))
      await new Promise((resolve) => setTimeout(resolve, 20))
      const response = replies.find((r) => r.type === 'rpc-result')
      expect(response?.ok).toBe(true)
      expect(response.data.buttons[0].text).toBe('继续')
      expect(JSON.stringify(response.data)).not.toContain('private-fixture')
      expect(JSON.stringify(response.data)).not.toContain('private-body')
      expect(response.data.textNote).toContain('不采集')
    } finally { dom.window.close() }
  })
})
