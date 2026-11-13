import { describe, expect, it } from 'vitest'
import { apiEndpoint, describeChatEndpoint, normalizeBaseUrl } from './url'

describe('normalizeBaseUrl', () => {
  it('补协议与 /v1', () => {
    expect(normalizeBaseUrl('https://ai.varud.asia')).toBe('https://ai.varud.asia/v1')
    expect(normalizeBaseUrl('https://ai.varud.asia/')).toBe('https://ai.varud.asia/v1')
  })

  it('只有域名时补 https://', () => {
    expect(normalizeBaseUrl('ai.varud.asia')).toBe('https://ai.varud.asia/v1')
  })

  it('本机地址补 http://', () => {
    expect(normalizeBaseUrl('localhost:8000')).toBe('http://localhost:8000/v1')
    expect(normalizeBaseUrl('127.0.0.1:8000/v1')).toBe('http://127.0.0.1:8000/v1')
  })

  it('已有版本段就不重复补', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('https://open.bigmodel.cn/api/paas/v4')).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta')).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    )
  })

  it('清理误贴的尾巴与重复 /v1', () => {
    expect(normalizeBaseUrl('https://x.test/v1/chat/completions')).toBe('https://x.test/v1')
    expect(normalizeBaseUrl('https://x.test/chat/completions')).toBe('https://x.test/v1')
    expect(normalizeBaseUrl('https://x.test/v1/v1/')).toBe('https://x.test/v1')
    expect(normalizeBaseUrl('https://x.test/models')).toBe('https://x.test/v1')
  })

  it('自定义前缀也补在末尾', () => {
    expect(normalizeBaseUrl('https://relay.test/openai')).toBe('https://relay.test/openai/v1')
  })

  it('空值保持空', () => {
    expect(normalizeBaseUrl('')).toBe('')
    expect(normalizeBaseUrl('   ')).toBe('')
  })
})

describe('apiEndpoint / describeChatEndpoint', () => {
  it('拼出完整请求地址', () => {
    expect(apiEndpoint('https://ai.varud.asia', 'chat/completions')).toBe('https://ai.varud.asia/v1/chat/completions')
    expect(apiEndpoint('https://ai.varud.asia/v1/', '/models')).toBe('https://ai.varud.asia/v1/models')
  })

  it('空 Base URL 不产出地址', () => {
    expect(describeChatEndpoint('')).toBe('')
    expect(describeChatEndpoint('https://ai.varud.asia')).toBe('https://ai.varud.asia/v1/chat/completions')
  })
})
