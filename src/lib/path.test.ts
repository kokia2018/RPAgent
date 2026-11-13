import { describe, expect, it } from 'vitest'
import { normalizePath, resolveProjectPath, sanitizeFileName } from './path'

describe('路径隔离', () => {
  it('规范化重复斜杠与 .', () => {
    expect(normalizePath('/a//b/./c.css')).toBe('/a/b/c.css')
    expect(normalizePath('index.html')).toBe('/index.html')
    expect(normalizePath('')).toBe('/')
  })

  it('拒绝越出工作区根的 ..', () => {
    expect(() => normalizePath('/../secret.txt')).toThrow()
    expect(() => normalizePath('/a/../../secret.txt')).toThrow()
    expect(() => normalizePath('/a/./b/../c')).toThrow()
  })

  it('拒绝反斜杠逃逸与 NUL', () => {
    expect(normalizePath('\\a\\b.txt')).toBe('/a/b.txt')
    expect(() => normalizePath('/a/\0b')).toThrow()
  })

  it('相对引用可以在根内使用 ..', () => {
    expect(resolveProjectPath('/src/app.js', '../style.css')).toBe('/style.css')
    expect(resolveProjectPath('/src/ui/app.js', './util.js')).toBe('/src/ui/util.js')
    expect(resolveProjectPath('/index.html', '/assets/a.png')).toBe('/assets/a.png')
  })

  it('相对引用不允许越出根', () => {
    expect(() => resolveProjectPath('/index.html', '../secret.txt')).toThrow()
    expect(() => resolveProjectPath('/a.html', '../../x')).toThrow()
  })

  it('导出文件名清理非法字符', () => {
    expect(sanitizeFileName('a/b:c*?"<>|.html')).toBe('a-b-c------.html')
    expect(sanitizeFileName('   ')).toBe('app')
  })
})
