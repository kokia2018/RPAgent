import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import {
  aggregateUsage,
  cacheHitRate,
  clearUsageEvents,
  dayKey,
  endpointHost,
  emptyTotals,
  listUsageEvents,
  listUsageModels,
  recordUsage,
  usageSink,
} from './usage'
import type { UsageEventRecord } from './types'

const DAY = 24 * 60 * 60 * 1000

function event(partial: Partial<UsageEventRecord>): UsageEventRecord {
  return {
    at: Date.now(),
    model: 'm1',
    host: 'api.example.test',
    source: 'agent',
    prompt: 100,
    completion: 50,
    cached: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 150,
    ok: true,
    ms: 1000,
    ...partial,
  }
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('API 用量统计', () => {
  it('按模型与按天聚合，总数等于分项之和', async () => {
    const now = Date.now()
    await recordUsage(event({ at: now, model: 'a', prompt: 100, completion: 20, total: 120 }))
    await recordUsage(event({ at: now, model: 'a', prompt: 300, completion: 30, total: 330, cached: 200 }))
    await recordUsage(event({ at: now - DAY, model: 'b', prompt: 40, completion: 10, total: 50 }))

    const summary = await aggregateUsage()
    expect(summary.totals.requests).toBe(3)
    expect(summary.totals.prompt).toBe(440)
    expect(summary.totals.completion).toBe(60)
    expect(summary.totals.total).toBe(500)
    expect(summary.byModel.map((m) => m.model)).toEqual(['a', 'b'])
    expect(summary.byModel[0].totals.requests).toBe(2)
    expect(summary.byDay).toHaveLength(2)
    expect(summary.bySource[0].source).toBe('agent')
    expect(cacheHitRate(summary.totals)).toBeCloseTo(200 / 440, 5)
  })

  it('按时间段与模型筛选', async () => {
    const now = Date.now()
    await recordUsage(event({ at: now, model: 'a', total: 10, prompt: 10, completion: 0 }))
    await recordUsage(event({ at: now - 3 * DAY, model: 'b', total: 20, prompt: 20, completion: 0 }))
    await recordUsage(event({ at: now - 20 * DAY, model: 'a', total: 30, prompt: 30, completion: 0 }))

    const last7 = await aggregateUsage({ from: now - 7 * DAY })
    expect(last7.totals.requests).toBe(2)
    expect(last7.totals.total).toBe(30)

    const onlyA = await aggregateUsage({ model: 'a' })
    expect(onlyA.totals.requests).toBe(2)
    expect(onlyA.byModel).toHaveLength(1)

    const both = await aggregateUsage({ from: now - 7 * DAY, model: 'a' })
    expect(both.totals.requests).toBe(1)
  })

  it('失败请求计次数但不计 token，按来源与模型可列出', async () => {
    await recordUsage(event({ ok: false, errorCode: 'rate', prompt: 0, completion: 0, total: 0, ms: 300 }))
    await recordUsage(event({ source: 'compaction', model: 'sum', prompt: 500, completion: 40, total: 540 }))
    await recordUsage(event({ source: 'character', model: 'role', prompt: 20, completion: 10, total: 30 }))

    const summary = await aggregateUsage()
    expect(summary.totals.requests).toBe(3)
    expect(summary.totals.failed).toBe(1)
    expect(summary.totals.prompt).toBe(520)
    expect(summary.bySource.map((s) => s.source).sort()).toEqual(['agent', 'character', 'compaction'])

    const models = await listUsageModels()
    expect(models).toHaveLength(3)

    const failedOnly = await aggregateUsage({ source: 'agent' })
    expect(failedOnly.totals.failed).toBe(1)
  })

  it('明细按时间倒序，支持条数上限', async () => {
    const now = Date.now()
    for (let i = 0; i < 5; i++) await recordUsage(event({ at: now - i * 1000, total: i }))
    const rows = await listUsageEvents({}, 3)
    expect(rows).toHaveLength(3)
    expect(rows[0].at).toBeGreaterThan(rows[1].at)
  })

  it('清空可以只清当前筛选', async () => {
    await recordUsage(event({ model: 'a' }))
    await recordUsage(event({ model: 'b' }))
    const removed = await clearUsageEvents({ model: 'a' })
    expect(removed).toBe(1)
    expect(await db.usageEvents.count()).toBe(1)
    await clearUsageEvents()
    expect(await db.usageEvents.count()).toBe(0)
  })

  it('usageSink 把 usage 与结局写成一条记录', async () => {
    const sink = usageSink({
      source: 'agent',
      model: 'deepseek-v4',
      baseUrl: 'https://api.example.test/v1',
      taskId: 'task_1',
      conversationId: 'conv_1',
      runId: 'run_1',
      round: 3,
    })
    sink({ prompt: 900, completion: 100, total: 1000, cached: 400, reasoning: 20 }, { ok: true, ms: 1234 })
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    const rows = await db.usageEvents.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      model: 'deepseek-v4',
      host: 'api.example.test',
      source: 'agent',
      prompt: 900,
      completion: 100,
      cached: 400,
      reasoning: 20,
      total: 1000,
      ok: true,
      ms: 1234,
      taskId: 'task_1',
      conversationId: 'conv_1',
      runId: 'run_1',
      round: 3,
    })
  })

  it('空统计与主机名解析不会抛错', async () => {
    const summary = await aggregateUsage()
    expect(summary.totals).toEqual(emptyTotals())
    expect(summary.firstAt).toBeUndefined()
    expect(endpointHost('https://api.example.test/v1')).toBe('api.example.test')
    expect(endpointHost('')).toBe('')
    expect(dayKey(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('2026-01-02')
  })
})
