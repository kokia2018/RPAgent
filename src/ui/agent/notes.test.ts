import { describe, expect, it } from 'vitest'
import { groupRunNotes, notePreview } from './notes'

describe('groupRunNotes', () => {
  it('相邻同文合并并计数', () => {
    const groups = groupRunNotes([
      { kind: 'warning', message: '构建未就绪' },
      { kind: 'warning', message: '构建未就绪' },
      { kind: 'warning', message: '构建未就绪' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(3)
  })

  it('只有 build 号不同的刷新提示合并成一条并保留最新 build', () => {
    const groups = groupRunNotes([
      { kind: 'warning', message: '试玩已更新到 build 100。' },
      { kind: 'warning', message: '试玩已更新到 build 101。' },
      { kind: 'warning', message: '试玩已更新到 build 102。' },
      { kind: 'warning', message: '试玩已更新到 build 103。' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].message).toBe('试玩已自动更新 4 次（最新 build 103）。')
  })

  it('刷新提示与其他提示混在一起时保留时序位置', () => {
    const groups = groupRunNotes([
      { kind: 'warning', message: '试玩已更新到 build 10。' },
      { kind: 'error', message: '模型请求失败' },
      { kind: 'warning', message: '试玩已更新到 build 11。' },
    ])
    expect(groups.map((g) => g.message)).toEqual([
      '试玩已自动更新 2 次（最新 build 11）。',
      '模型请求失败',
    ])
  })

  it('不相邻的重复不合并，保持时序', () => {
    const groups = groupRunNotes([
      { kind: 'warning', message: 'A' },
      { kind: 'error', message: 'B' },
      { kind: 'warning', message: 'A' },
    ])
    expect(groups.map((g) => g.message)).toEqual(['A', 'B', 'A'])
    expect(groups.map((g) => g.count)).toEqual([1, 1, 1])
  })

  it('空列表返回空', () => {
    expect(groupRunNotes([])).toEqual([])
  })
})

describe('notePreview', () => {
  it('优先展示错误', () => {
    expect(
      notePreview([
        { kind: 'warning', message: '更新' },
        { kind: 'error', message: '构建失败' },
        { kind: 'warning', message: '又更新' },
      ])?.message,
    ).toBe('构建失败')
  })

  it('没有错误时取最近一条', () => {
    expect(notePreview([
      { kind: 'warning', message: '第一条' },
      { kind: 'warning', message: '第二条' },
    ])?.message).toBe('第二条')
  })

  it('空列表返回 null', () => {
    expect(notePreview([])).toBeNull()
  })
})
