import { describe, expect, it } from 'vitest'
import { AI_MAX_MESSAGES, AI_MAX_TOTAL_CHARS, AiRateLimiter, normalizeAiMessages } from './aiBridge'

describe('试玩 AI 桥输入校验', () => {
  it('接受合法消息', () => {
    expect(normalizeAiMessages([{ role: 'user', content: '你好' }])).toEqual([{ role: 'user', content: '你好' }])
  })

  it('拒绝非法结构与超限', () => {
    expect(() => normalizeAiMessages('x')).toThrow('数组')
    expect(() => normalizeAiMessages([])).toThrow('不能为空')
    expect(() => normalizeAiMessages([{ role: 'tool', content: 'x' }])).toThrow('角色')
    expect(() => normalizeAiMessages([{ role: 'user', content: 1 }])).toThrow('字符串')
    expect(() =>
      normalizeAiMessages(Array.from({ length: AI_MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' }))),
    ).toThrow('最多')
    expect(() =>
      normalizeAiMessages([{ role: 'user', content: 'x'.repeat(AI_MAX_TOTAL_CHARS + 1) }]),
    ).toThrow('总长度')
  })
})

describe('试玩 AI 限额', () => {
  it('每分钟最多 10 次，可重置', () => {
    const limiter = new AiRateLimiter()
    const now = 1_000_000
    for (let i = 0; i < 10; i++) expect(limiter.allow('s1', now).ok).toBe(true)
    const blocked = limiter.allow('s1', now)
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toContain('频繁')
    expect(limiter.allow('s2', now).ok).toBe(true)
    limiter.reset('s1')
    expect(limiter.allow('s1', now).ok).toBe(true)
  })

  it('每天最多 100 次', () => {
    const limiter = new AiRateLimiter()
    let now = 2_000_000
    for (let i = 0; i < 100; i++) {
      expect(limiter.allow('s1', now).ok).toBe(true)
      now += 61_000
    }
    const blocked = limiter.allow('s1', now)
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toContain('今天')
  })
})
