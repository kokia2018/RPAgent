import { db } from './db'
import type { UsageEventRecord, UsageSource } from './types'
import type { UsageInfo, UsageOutcome } from '../agent/types'
import { normalizeBaseUrl } from '../lib/url'

/**
 * API 用量统计。
 *
 * 每次模型请求结束（成功或失败）都写一条 `usageEvents`，设置页按模型和时间段聚合。
 * 写失败绝不影响对话本身：统计是旁路，不能因为 IndexedDB 写不进就中断运行。
 */

export interface UsageMeta {
  source: UsageSource
  model: string
  baseUrl: string
  taskId?: string
  conversationId?: string
  runId?: string
  round?: number
}

export function endpointHost(baseUrl: string): string {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).host
  } catch {
    return ''
  }
}

export async function recordUsage(event: UsageEventRecord): Promise<void> {
  try {
    await db.usageEvents.add(event)
  } catch {
    // 旁路统计，失败不冒泡。配额满时宁可丢统计，也不能影响对话。
  }
}

/**
 * 生成 streamChat 的 onUsage 回调：把 usage 归一成一条记录。
 * 用 `void recordUsage(...)` 调用，不阻塞流。
 */
export function usageSink(meta: UsageMeta) {
  const host = endpointHost(meta.baseUrl)
  const model = String(meta.model || '').trim() || '未知模型'
  return (usage: UsageInfo | undefined, outcome: UsageOutcome) => {
    const prompt = usage?.prompt ?? 0
    const completion = usage?.completion ?? 0
    void recordUsage({
      at: Date.now(),
      model,
      host,
      source: meta.source,
      prompt,
      completion,
      cached: usage?.cached ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      reasoning: usage?.reasoning ?? 0,
      total: usage?.total ?? prompt + completion,
      ok: outcome.ok,
      ms: outcome.ms,
      errorCode: outcome.errorCode,
      taskId: meta.taskId,
      conversationId: meta.conversationId,
      runId: meta.runId,
      round: meta.round,
    })
  }
}

export interface UsageTotals {
  requests: number
  failed: number
  prompt: number
  completion: number
  cached: number
  cacheWrite: number
  reasoning: number
  total: number
  ms: number
}

export function emptyTotals(): UsageTotals {
  return { requests: 0, failed: 0, prompt: 0, completion: 0, cached: 0, cacheWrite: 0, reasoning: 0, total: 0, ms: 0 }
}

function addToTotals(totals: UsageTotals, event: UsageEventRecord): void {
  totals.requests += 1
  if (!event.ok) totals.failed += 1
  totals.prompt += event.prompt || 0
  totals.completion += event.completion || 0
  totals.cached += event.cached || 0
  totals.cacheWrite += event.cacheWrite || 0
  totals.reasoning += event.reasoning || 0
  totals.total += event.total || 0
  totals.ms += event.ms || 0
}

export interface UsageFilter {
  /** 起止时间戳（含）。不传表示不限。 */
  from?: number
  to?: number
  /** 空字符串或省略表示全部模型。 */
  model?: string
  source?: UsageSource
}

export interface UsageSummary {
  totals: UsageTotals
  byModel: { model: string; host: string; totals: UsageTotals }[]
  bySource: { source: UsageSource; totals: UsageTotals }[]
  byDay: { day: string; totals: UsageTotals }[]
  firstAt?: number
  lastAt?: number
}

/** 本地时区的 YYYY-MM-DD。按天统计必须用本地日期，否则跨时区会错开。 */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function matches(event: UsageEventRecord, filter: UsageFilter): boolean {
  if (filter.from != null && event.at < filter.from) return false
  if (filter.to != null && event.at > filter.to) return false
  if (filter.model && event.model !== filter.model) return false
  if (filter.source && event.source !== filter.source) return false
  return true
}

/**
 * 聚合统计。用游标累加而不是 toArray，长期使用后条数上万也不会一次性占满内存。
 */
export async function aggregateUsage(filter: UsageFilter = {}): Promise<UsageSummary> {
  const totals = emptyTotals()
  const modelMap = new Map<string, { model: string; host: string; totals: UsageTotals }>()
  const sourceMap = new Map<UsageSource, UsageTotals>()
  const dayMap = new Map<string, UsageTotals>()
  let firstAt: number | undefined
  let lastAt: number | undefined

  const table = filter.from != null || filter.to != null
    ? db.usageEvents.where('at').between(filter.from ?? 0, filter.to ?? Number.MAX_SAFE_INTEGER, true, true)
    : db.usageEvents.toCollection()

  await table.each((event) => {
    if (!matches(event, filter)) return
    addToTotals(totals, event)

    const key = `${event.model}\u0000${event.host}`
    const bucket = modelMap.get(key) || { model: event.model, host: event.host, totals: emptyTotals() }
    addToTotals(bucket.totals, event)
    modelMap.set(key, bucket)

    const sourceTotals = sourceMap.get(event.source) || emptyTotals()
    addToTotals(sourceTotals, event)
    sourceMap.set(event.source, sourceTotals)

    const day = dayKey(event.at)
    const dayTotals = dayMap.get(day) || emptyTotals()
    addToTotals(dayTotals, event)
    dayMap.set(day, dayTotals)

    if (firstAt == null || event.at < firstAt) firstAt = event.at
    if (lastAt == null || event.at > lastAt) lastAt = event.at
  })

  return {
    totals,
    byModel: [...modelMap.values()].sort((a, b) => b.totals.total - a.totals.total),
    bySource: [...sourceMap.entries()]
      .map(([source, totalsOfSource]) => ({ source, totals: totalsOfSource }))
      .sort((a, b) => b.totals.total - a.totals.total),
    byDay: [...dayMap.entries()].map(([day, totalsOfDay]) => ({ day, totals: totalsOfDay })).sort((a, b) => a.day.localeCompare(b.day)),
    firstAt,
    lastAt,
  }
}

/** 出现过的模型（带请求数），用于筛选下拉。 */
export async function listUsageModels(): Promise<{ model: string; host: string; requests: number }[]> {
  const map = new Map<string, { model: string; host: string; requests: number }>()
  await db.usageEvents.each((event) => {
    const key = `${event.model}\u0000${event.host}`
    const cur = map.get(key) || { model: event.model, host: event.host, requests: 0 }
    cur.requests += 1
    map.set(key, cur)
  })
  return [...map.values()].sort((a, b) => b.requests - a.requests)
}

/** 最近的请求明细（新的在前）。 */
export async function listUsageEvents(filter: UsageFilter = {}, limit = 200): Promise<UsageEventRecord[]> {
  const rows = await db.usageEvents.orderBy('at').reverse().toArray()
  return rows.filter((event) => matches(event, filter)).slice(0, limit)
}

export async function clearUsageEvents(filter: UsageFilter = {}): Promise<number> {
  if (!filter.from && !filter.to && !filter.model && !filter.source) {
    const count = await db.usageEvents.count()
    await db.usageEvents.clear()
    return count
  }
  const ids: number[] = []
  await db.usageEvents.each((event) => {
    if (matches(event, filter) && event.id != null) ids.push(event.id)
  })
  await db.usageEvents.bulkDelete(ids)
  return ids.length
}

/** 命中率：cached / prompt。没有输入时返回 0。 */
export function cacheHitRate(totals: UsageTotals): number {
  if (!totals.prompt) return 0
  return Math.min(1, totals.cached / totals.prompt)
}
