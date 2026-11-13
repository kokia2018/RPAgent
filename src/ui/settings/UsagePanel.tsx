import { useMemo, useState } from 'react'
import { useLiveQueryValue } from '../hooks'
import { useToast } from '../toast'
import { Icon } from '../icons'
import { Modal } from '../Modal'
import { downloadText } from '../../export/exportHtml'
import {
  aggregateUsage,
  cacheHitRate,
  clearUsageEvents,
  dayKey,
  emptyTotals,
  listUsageEvents,
  listUsageModels,
  type UsageFilter,
  type UsageSummary,
} from '../../db/usage'
import type { UsageSource } from '../../db/types'

/**
 * API 用量统计。
 *
 * 数据来源是 `usageEvents`（每次模型请求一条），这里只做筛选和展示：
 * 时间范围 + 模型两个维度，汇总卡片、按天条、按模型表、最近明细。
 */

const RANGES = [
  { key: 'today', label: '今天' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'all', label: '全部' },
] as const

type RangeKey = (typeof RANGES)[number]['key']

const SOURCE_LABEL: Record<UsageSource, string> = {
  agent: '对话',
  compaction: '摘要',
  character: '角色卡',
  component: '组件',
}

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function rangeToFilter(range: RangeKey, model: string): UsageFilter {
  const today = startOfToday()
  const day = 24 * 60 * 60 * 1000
  const base: UsageFilter = { model: model || undefined }
  if (range === 'today') return { ...base, from: today }
  if (range === '7d') return { ...base, from: today - 6 * day }
  if (range === '30d') return { ...base, from: today - 29 * day }
  return base
}

/** 大数字压缩：12345 → 12.3k。统计面板里全写原数很难扫。 */
export function compactNumber(value: number): string {
  const n = Number(value) || 0
  if (Math.abs(n) < 1000) return String(n)
  if (Math.abs(n) < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (Math.abs(n) < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function shortTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const EMPTY_SUMMARY: UsageSummary = { totals: emptyTotals(), byModel: [], bySource: [], byDay: [] }

export function UsagePanel() {
  const { toast } = useToast()
  const [range, setRange] = useState<RangeKey>('7d')
  const [model, setModel] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)

  const filter = useMemo(() => rangeToFilter(range, model), [range, model])
  // 依赖用原始值，避免 filter 每次新建对象导致订阅重建。
  const deps = [range, model]

  const summary = useLiveQueryValue<UsageSummary>(() => aggregateUsage(filter), deps, EMPTY_SUMMARY)
  const models = useLiveQueryValue(() => listUsageModels(), [], [])
  const details = useLiveQueryValue(() => (detailOpen ? listUsageEvents(filter, 100) : Promise.resolve([])), [...deps, detailOpen], [])

  const totals = summary.totals
  const hitRate = cacheHitRate(totals)
  const avgMs = totals.requests ? Math.round(totals.ms / totals.requests) : 0
  const maxDay = summary.byDay.reduce((max, item) => Math.max(max, item.totals.total), 0)

  const doExport = async () => {
    const rows = await listUsageEvents({ from: filter.from, to: filter.to, model: filter.model }, 5000)
    if (!rows.length) {
      toast('当前筛选下没有记录', 'warning')
      return
    }
    const header = ['时间', '模型', '网关', '来源', '输入', '输出', '缓存命中', '缓存写入', '推理', '合计', '状态', '耗时ms']
    const lines = rows.map((row) =>
      [
        new Date(row.at).toISOString(),
        row.model,
        row.host,
        SOURCE_LABEL[row.source] || row.source,
        row.prompt,
        row.completion,
        row.cached,
        row.cacheWrite,
        row.reasoning,
        row.total,
        row.ok ? '成功' : row.errorCode || '失败',
        row.ms,
      ]
        .map((cell) => {
          const text = String(cell)
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
        })
        .join(','),
    )
    downloadText(`api-usage-${dayKey(Date.now())}.csv`, [header.join(','), ...lines].join('\n'), 'text/csv;charset=utf-8')
    toast(`已导出 ${rows.length} 条记录`, 'success')
  }

  const doClear = async () => {
    const count = await clearUsageEvents(filter)
    setConfirmClear(false)
    toast(count ? `已清空 ${count} 条用量记录` : '没有可清空的记录', count ? 'success' : 'warning')
  }

  return (
    <div className="usage-panel">
      <div className="usage-toolbar">
        <div className="usage-range" role="group" aria-label="时间范围">
          {RANGES.map((item) => (
            <button
              key={item.key}
              className={`usage-chip ${range === item.key ? 'is-active' : ''}`}
              onClick={() => setRange(item.key)}
              aria-pressed={range === item.key}
            >
              {item.label}
            </button>
          ))}
        </div>
        <select
          className="usage-model-select"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          aria-label="按模型筛选"
        >
          <option value="">全部模型</option>
          {models.map((item) => (
            <option key={`${item.model}@${item.host}`} value={item.model}>
              {item.model}
              {item.host ? ` · ${item.host}` : ''}（{item.requests}）
            </option>
          ))}
        </select>
        <div className="usage-actions">
          <button className="btn btn-ghost btn-small" onClick={() => void doExport()}>
            <Icon name="download" size={13} /> CSV
          </button>
          <button className="btn btn-ghost btn-small" onClick={() => setConfirmClear(true)} disabled={!totals.requests}>
            <Icon name="trash" size={13} /> 清空
          </button>
        </div>
      </div>

      <div className="usage-totals">
        <UsageStat label="请求" value={String(totals.requests)} hint={totals.failed ? `失败 ${totals.failed}` : '全部成功'} />
        <UsageStat label="输入" value={compactNumber(totals.prompt)} hint={`缓存 ${percent(hitRate)}`} />
        <UsageStat label="输出" value={compactNumber(totals.completion)} hint={totals.reasoning ? `推理 ${compactNumber(totals.reasoning)}` : '含工具调用'} />
        <UsageStat label="合计" value={compactNumber(totals.total)} hint={avgMs ? `均 ${avgMs}ms` : '—'} />
      </div>

      {!totals.requests ? (
        <p className="usage-empty">这段时间还没有请求记录。跑一次对话后这里会自动出现。</p>
      ) : (
        <>
          {summary.byDay.length > 1 || range === 'all' ? (
            <div className="usage-days">
              {summary.byDay.map((item) => (
                <div className="usage-day" key={item.day} title={`${item.day} · ${item.totals.requests} 次 · ${item.totals.total} token`}>
                  <div className="usage-day-bar">
                    <div
                      className="usage-day-fill"
                      style={{ height: `${maxDay ? Math.max(4, (item.totals.total / maxDay) * 100) : 0}%` }}
                    />
                  </div>
                  <span className="usage-day-label">{item.day.slice(5)}</span>
                </div>
              ))}
            </div>
          ) : null}

          <table className="usage-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>请求</th>
                <th>输入</th>
                <th>输出</th>
                <th>缓存命中</th>
                <th>合计</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map((item) => (
                <tr key={`${item.model}@${item.host}`}>
                  <td>
                    <span className="usage-model-name">{item.model}</span>
                    {item.host ? <span className="usage-model-host">{item.host}</span> : null}
                  </td>
                  <td>{item.totals.requests}</td>
                  <td>{compactNumber(item.totals.prompt)}</td>
                  <td>{compactNumber(item.totals.completion)}</td>
                  <td>{percent(cacheHitRate(item.totals))}</td>
                  <td>{compactNumber(item.totals.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {summary.bySource.length > 1 ? (
            <div className="usage-sources">
              {summary.bySource.map((item) => (
                <span className="usage-source" key={item.source}>
                  {SOURCE_LABEL[item.source] || item.source} · {item.totals.requests} 次 · {compactNumber(item.totals.total)}
                </span>
              ))}
            </div>
          ) : null}

          <button className="usage-detail-toggle" onClick={() => setDetailOpen((v) => !v)} aria-expanded={detailOpen}>
            <Icon name="chevron" size={12} /> {detailOpen ? '收起明细' : '查看最近请求明细（最多 100 条）'}
          </button>
          {detailOpen ? (
            <table className="usage-table usage-table-detail">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模型</th>
                  <th>来源</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>缓存</th>
                  <th>合计</th>
                  <th>耗时</th>
                </tr>
              </thead>
              <tbody>
                {details.map((row) => (
                  <tr key={row.id} className={row.ok ? '' : 'is-failed'}>
                    <td>{shortTime(row.at)}</td>
                    <td>{row.model}</td>
                    <td>{SOURCE_LABEL[row.source] || row.source}</td>
                    <td>{row.prompt || '—'}</td>
                    <td>{row.completion || '—'}</td>
                    <td>{row.cached ? compactNumber(row.cached) : '—'}</td>
                    <td>{row.total || '—'}</td>
                    <td>
                      {row.ms ? `${row.ms}ms` : '—'}
                      {row.ok ? '' : <span className="usage-failed-tag">{row.errorCode || '失败'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      )}

      <p className="settings-desc usage-note">
        每次模型请求（含上下文摘要、角色卡对话、组件内 AI）都会记一条。缓存指的是输入里命中提示缓存的 token——各家字段不同，已归一。
        失败的请求只记次数和耗时，token 记 0。数据只存在本机，导出 CSV 方便自己按单价核算。
      </p>

      <Modal
        open={confirmClear}
        title="清空用量记录？"
        subtitle={model ? `只清空「${model}」在当前时间范围内的记录` : '清空当前时间范围内的全部记录'}
        onClose={() => setConfirmClear(false)}
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmClear(false)}>
              取消
            </button>
            <button className="btn btn-danger" onClick={() => void doClear()}>
              确认清空
            </button>
          </div>
        }
      >
        <p>统计只是账本，清空不会影响任何对话、文件或设置。</p>
      </Modal>
    </div>
  )
}

function UsageStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="usage-stat">
      <span className="usage-stat-label">{label}</span>
      <strong className="usage-stat-value">{value}</strong>
      <span className="usage-stat-hint">{hint}</span>
    </div>
  )
}
