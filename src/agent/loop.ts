import type { ApiSettings, MessageRecord, ToolCallRecord } from '../db/types'
import {
  appendMessage,
  getTask,
  listMessages,
  listPreviewSessions,
  listWorkspaceFiles,
  updateMessage,
  updateTask,
} from '../db/repo'
import { previewManager } from '../preview/manager'
import { queueWorkspaceRun } from '../lib/runLock'
import { db } from '../db/db'
import { listConversationMessages, saveConversationSummary } from '../db/conversations'
import { usageSink } from '../db/usage'
import { buildSystemPrompt } from './prompt'
import { configFromSettings, streamChat } from './llm'
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  findCutIndex,
  isContextOverflow,
  shouldCompact,
  summarizeMessages,
  summaryMessage,
  type CompactionSettings,
  type UsageAnchor,
} from './compaction'
import { createToolRegistry, TOOL_DEFS } from './tools'
import { LLMError, type AgentEvent, type ChatMessage, type ChatToolCall, type ToolResult } from './types'
import { randomId } from '../lib/hash'
import { truncate } from '../lib/text'
import { describeTaskLibraryRefs, listTaskAttachments } from '../db/assets'

export interface RunAgentOptions {
  taskId: string
  conversationId?: string
  sessionId?: string
  userText: string
  settings: ApiSettings
  signal: AbortSignal
  onEvent?: (event: AgentEvent) => void
}

export interface RunAgentResult {
  runId: string
  status: 'done' | 'aborted' | 'error' | 'budget'
  summary: string
  rounds: number
  tools: number
  error?: string
}

const MAX_TOOL_RESULT_CHARS = 12_000
const WRITE_TOOLS = new Set(['fs_write', 'fs_edit', 'fs_delete'])
/** 0 = 不限，和本地 Agent 一致；只有用户主动填了正数才在到达时停。 */
const DEFAULT_ROUNDS = 0
const DEFAULT_TOOL_CALLS = 0
/** 不限轮数时的软提醒：跑到这里提示一次"可以随时停止 / 你的 key 在计费"。 */
const LONG_RUN_NOTICE = 100
/** 完全相同（工具+参数+结果）的调用连续出现这么多次，就判定卡死。 */
const STALL_REPEATS = 6

function rowToChat(row: MessageRecord): ChatMessage | null {
  if (row.role === 'user') {
    return { role: 'user', content: row.content || '' }
  }
  if (row.role === 'assistant') {
    const msg: ChatMessage = { role: 'assistant', content: row.content || '', ...(row.reasoning !== undefined ? { reasoning_content: row.reasoning } : {}), ...(row.reasoningText !== undefined ? { reasoning_text: row.reasoningText } : {}) }
    const calls = (row.toolCalls || []).filter((c) => c.id && c.name)
    if (calls.length) {
      msg.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments || '{}' },
      }))
    }
    return msg
  }
  if (row.role === 'tool') {
    if (!row.toolCallId) return null
    return {
      role: 'tool',
      content: row.content || '',
      tool_call_id: row.toolCallId,
      name: row.name || 'tool',
    }
  }
  return null
}

interface HistoryEntry {
  message: ChatMessage
  /** 对应的消息行 id；从摘要里恢复出来的消息没有 id。 */
  rowId?: number
}

function sanitizeHistory(rows: MessageRecord[]): HistoryEntry[] {
  let out: HistoryEntry[] = rows
    .map((row) => ({ message: rowToChat(row), rowId: row.id }))
    .filter((entry): entry is { message: ChatMessage; rowId: number | undefined } => Boolean(entry.message))

  // 去掉没有对应工具结果的 assistant tool_calls
  for (let i = 0; i < out.length; i++) {
    const m = out[i].message
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue
    const ids = new Set(m.tool_calls.map((t) => t.id))
    const seen = new Set<string>()
    let j = i + 1
    while (j < out.length && out[j].message.role === 'tool') {
      seen.add(out[j].message.tool_call_id || '')
      j++
    }
    if (Array.from(ids).some((id) => !seen.has(id))) {
      out[i] = { ...out[i], message: { role: 'assistant', content: m.content || '' } }
    }
  }

  const validIds = new Set<string>()
  for (const entry of out) {
    if (entry.message.role === 'assistant' && entry.message.tool_calls) {
      for (const t of entry.message.tool_calls) validIds.add(t.id)
    }
  }
  out = out.filter((entry) => entry.message.role !== 'tool' || validIds.has(entry.message.tool_call_id || ''))

  // 不再按条数硬截断：上下文由 compaction 按 token 预算处理，
  // 硬截断会把早期决定悄悄丢掉，压缩至少会留下摘要。
  while (out.length && out[0].message.role === 'tool') out.shift()
  return out
}

function toolCallsForDb(calls: ChatToolCall[]): ToolCallRecord[] {
  return calls.map((c) => ({
    id: c.id,
    name: c.name,
    arguments: c.argsRaw || JSON.stringify(c.args ?? {}),
    status: 'running',
  }))
}

function summarizeToolResult(result: ToolResult): string {
  return truncate(JSON.stringify(result), MAX_TOOL_RESULT_CHARS)
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const frozen = { ...opts, sessionId: opts.sessionId ?? previewManager.getActiveSession(opts.taskId), settings: { ...opts.settings, profiles: opts.settings.profiles.map(p => ({ ...p })) } }
  if (frozen.conversationId) {
    const conversation = await db.conversations.get(frozen.conversationId)
    if (!conversation || conversation.workspaceId !== frozen.taskId) throw new Error('对话未绑定此工作空间')
  }
  return queueWorkspaceRun(frozen.taskId, frozen.signal, () => executeAgent(frozen))
}

async function executeAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { taskId, userText, settings, signal, conversationId } = opts
  let targetSessionId = opts.sessionId
  const emit = (event: AgentEvent) => {
    try {
      opts.onEvent?.(event)
    } catch {
      /* UI 回调异常不影响 Agent */
    }
  }

  const task = await getTask(taskId)
  if (!task) throw new Error('任务不存在')

  const runId = randomId('run_')
  const appendRunMessage = (input: Parameters<typeof appendMessage>[0]) => appendMessage({ ...input, conversationId })
  let rounds = 0
  let toolsUsed = 0
  let status: RunAgentResult['status'] = 'done'
  let summary = ''
  let fatalError = ''
  let wroteAny = false
  let wroteHtml = false
  let previewAttempted = false
  let finishCalled = false
  let finishSummary = ''
  let finishNudges = 0
  let noWriteNudges = 0
  let readOnlyStreak = 0
  let readOnlyNudgeGiven = false
  // 同一工具 + 同一参数 + 同一结果连续重复，说明模型在原地打转（不是"又改了一版"）。
  let lastCallSignature = ''
  let repeatedCalls = 0
  let stalled = false

  const wantsModify =
    /创建|生成|制作|写|修改|修复|新增|添加|删除|重写|实现|开发|搭建|做一|build|create|make|fix|update|implement/i.test(
      userText,
    )

  emit({ type: 'run_start', taskId, runId })
  await updateTask(taskId, { status: 'running', lastRunId: runId, lastRunAt: Date.now() })
  await appendRunMessage({
    taskId,
    conversationId,
    runId,
    role: 'user',
    content: userText,
    status: 'done',
  })

  // 同空间的多个对话共享文件，但各自只读自己的消息历史。
  const persisted = conversationId ? await db.conversations.get(conversationId) : undefined
  const allRows = conversationId ? await listConversationMessages(conversationId) : await listMessages(taskId)
  // 摘要覆盖过的消息不再送进模型（但界面里仍然保留，可翻看）。
  const cutId = persisted?.summary ? (persisted.summaryUpToId ?? 0) : 0
  const history = sanitizeHistory(cutId ? allRows.filter((row) => (row.id ?? 0) > cutId) : allRows)
  let conversation: ChatMessage[] = persisted?.summary
    ? [summaryMessage(persisted.summary), ...history.map((entry) => entry.message)]
    : history.map((entry) => entry.message)
  let rowIds: (number | undefined)[] = persisted?.summary
    ? [undefined, ...history.map((entry) => entry.rowId)]
    : history.map((entry) => entry.rowId)
  let usageAnchor: UsageAnchor | null = null
  let previousSummary = persisted?.summary
  const pushHistory = (message: ChatMessage, rowId?: number) => {
    conversation.push(message)
    rowIds.push(rowId)
  }

  const registry = createToolRegistry({
    taskId,
    conversationId,
    get targetSessionId() { return targetSessionId },
    locked: true,
    runId,
    signal,
    emit,
  })

  let normalAnswer = false
  let dirtyPreview = false
  const previewNotes: string[] = []
  const flushPreview = async () => {
    if (!dirtyPreview || signal.aborted) return
    dirtyPreview = false
    try {
      // 只刷新运行开始时固定的窗口；用户中途切到别的窗口不会改变目标。
      const result = targetSessionId ? await previewManager.refreshTaskSession(taskId, targetSessionId) : null
      if (!result) {
        emit({ type: 'warning', message: '文件已保存；当前没有正在显示的试玩，请先打开正确入口。' })
        previewNotes.push('文件已保存；当前没有正在显示的试玩，请先 open 正确入口再 observe。')
      } else if (result.ready) {
        // 面向用户只说一句"已更新"；面向模型保留"还没验证"的硬要求。
        emit({ type: 'warning', message: `试玩已更新到 build ${result.buildVersion}。` })
        previewNotes.push(
          `当前试玩已更新到本批改动（build ${result.buildVersion}）；尚未验证关键交互，请 observe 当前构建。`,
        )
      } else {
        emit({ type: 'warning', message: '改动已保存，但新构建没有就绪，请检查日志，不要宣称试玩通过。' })
        previewNotes.push('改动已保存，但新构建没有就绪，请检查日志，不要宣称试玩通过。')
      }
    } catch (e) {
      const message = `改动已保存，自动更新试玩失败：${String(e)}`
      emit({ type: 'warning', message })
      previewNotes.push(message)
    }
  }

  const maxRounds = Number.isFinite(settings.maxRounds) && settings.maxRounds > 0
    ? Math.round(settings.maxRounds)
    : DEFAULT_ROUNDS
  const maxTools = Number.isFinite(settings.maxToolCalls) && settings.maxToolCalls > 0
    ? Math.round(settings.maxToolCalls)
    : DEFAULT_TOOL_CALLS

  const compaction: CompactionSettings = {
    enabled: true,
    contextWindow: settings.contextWindow || DEFAULT_COMPACTION_SETTINGS.contextWindow,
    reserveTokens: settings.reserveTokens || DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens: settings.keepRecentTokens || DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  }
  const canCompress = () => Boolean(settings.baseUrl && settings.model)
  let overflowRetried = false

  /**
   * 把较早的一段历史压成摘要。返回 false 表示这次没压（没有可切点/没配模型/模型报错）。
   * 压完把检查点写进对话记录，下次运行直接复用，不用重复花钱。
   */
  const compactHistory = async (reason: 'threshold' | 'overflow'): Promise<boolean> => {
    // 阈值压缩可以被"窗口填 0"关掉；接口已经报超限时不受这个开关影响。
    if (!compaction.enabled || !canCompress()) return false
    if (reason === 'threshold' && compaction.contextWindow <= 0) return false
    if (signal.aborted) return false
    const before = estimateContextTokens(conversation, usageAnchor)
    const cut = findCutIndex(conversation, compaction.keepRecentTokens)
    if (cut <= 0) return false

    const head = conversation.slice(0, cut)
    const recent = conversation.slice(cut)
    const recentIds = rowIds.slice(cut)
    const upToId = rowIds.slice(0, cut).reverse().find((id): id is number => typeof id === 'number')

    if (reason === 'overflow') {
      emit({ type: 'warning', message: '接口报告上下文超限，压缩较早的历史后重试一次。' })
    }

    let summary: string
    try {
      summary = await summarizeMessages(head, {
        config: configFromSettings(settings),
        signal,
        previousSummary,
        usage: { taskId, conversationId, runId },
      })
    } catch (e) {
      emit({ type: 'warning', message: `上下文压缩失败：${String((e as Error)?.message || e)}` })
      return false
    }

    conversation = [summaryMessage(summary), ...recent]
    rowIds = [undefined, ...recentIds]
    usageAnchor = null
    previousSummary = summary
    if (conversationId && upToId) {
      try {
        await saveConversationSummary(conversationId, summary, upToId)
      } catch {
        /* 摘要写库失败不影响本次运行，只是下次要重新压 */
      }
    }
    const after = estimateContextTokens(conversation)
    emit({ type: 'compaction', tokensBefore: before, tokensAfter: after, summarized: head.length })
    return true
  }

  while (maxRounds === 0 || rounds < maxRounds) {
    if (signal.aborted) {
      status = 'aborted'
      summary = '已停止；已写入的文件保留在工作区。'
      break
    }

    rounds++
    emit({ type: 'round', round: rounds, maxRounds: maxRounds || undefined })
    if (maxRounds === 0 && rounds === LONG_RUN_NOTICE) {
      emit({
        type: 'warning',
        message: `已连续运行 ${rounds} 轮（未设上限）。可以随时停止；上下文到阈值会自动压缩，不会因为轮数被强制中断。`,
      })
    }

    // 发请求前先看上下文余量：越过 window - reserve 就压一次。
    if (shouldCompact(estimateContextTokens(conversation, usageAnchor), compaction)) {
      await compactHistory('threshold')
    }

    let systemPrompt = ''
    try {
      const [latestTask, files, previews, attachments, libraryRefs, spaces] = await Promise.all([
        getTask(taskId),
        listWorkspaceFiles(taskId),
        listPreviewSessions(taskId),
        listTaskAttachments(taskId),
        describeTaskLibraryRefs(taskId),
        db.tasks.toArray(),
      ])
      if (!latestTask) throw new Error('任务已被删除')
      systemPrompt = buildSystemPrompt({
        task: latestTask,
        files,
        previews,
        attachments,
        libraryRefs,
        workspaces: spaces.map((t) => ({ id: t.id, title: t.title })),
      })
    } catch (e) {
      status = 'error'
      fatalError = String((e as Error)?.message || e)
      emit({ type: 'error', message: fatalError, fatal: true })
      break
    }

    const requestMessages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...conversation]

    let streamedText = ''
    let streamedReasoning = ''
    let result: Awaited<ReturnType<typeof streamChat>>
    try {
      result = await streamChat(requestMessages, configFromSettings(settings), {
        signal,
        tools: TOOL_DEFS,
        toolChoice: 'auto',
        maxRetries: 2,
        timeoutMs: 180_000,
        temperature: settings.temperature,
        onUsage: usageSink({
          source: 'agent',
          model: settings.model,
          baseUrl: settings.baseUrl,
          taskId,
          conversationId,
          runId,
          round: rounds,
        }),
        onText: (text) => {
          streamedText += text
          emit({ type: 'text', text })
        },
        onReasoning: (text) => {
          streamedReasoning += text
          emit({ type: 'reasoning', text })
        },
      })
    } catch (e) {
      const err = e as LLMError
      if (err.code === 'aborted' || signal.aborted) {
        status = 'aborted'
        summary = '已停止；已写入的文件保留在工作区。'
        if (streamedText) {
          await appendRunMessage({
            taskId,
            runId,
            role: 'assistant',
            content: streamedText,
            reasoning: streamedReasoning || undefined,
            status: 'aborted',
          })
        }
        break
      }
      // 上下文超限：压一次再重试，成功后这一轮不算（rounds 退回）。
      if (!overflowRetried && isContextOverflow(String(err.message || e))) {
        overflowRetried = true
        const compacted = await compactHistory('overflow')
        if (compacted) {
          rounds--
          continue
        }
      }
      status = 'error'
      fatalError = String(err.message || e)
      emit({ type: 'error', message: fatalError, fatal: err.code === 'auth' || err.code === 'bad_request' })
      if (streamedText) {
        await appendRunMessage({
          taskId,
          runId,
          role: 'assistant',
          content: streamedText,
          reasoning: streamedReasoning || undefined,
          status: 'error',
        })
      }
      break
    }

    if (result.usage) emit({ type: 'usage', usage: result.usage })

    const dbCalls = toolCallsForDb(result.toolCalls)
    const assistantRow = await appendRunMessage({
      taskId,
      runId,
      role: 'assistant',
      content: result.text || '',
      reasoning: result.reasoning,
      reasoningText: result.reasoningText ?? '',
      toolCalls: dbCalls.length ? dbCalls : undefined,
      status: 'done',
      usage: result.usage,
    })
    pushHistory({
      role: 'assistant',
      content: result.text || '',
      reasoning_content: result.reasoning,
      reasoning_text: result.reasoningText ?? '',
      ...(result.toolCalls.length
        ? {
            tool_calls: result.toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.argsRaw || JSON.stringify(c.args ?? {}) },
            })),
          }
        : {}),
    }, assistantRow.id)
    // 真实 usage 是目前最准的上下文占用；之后的消息只用估算补上。
    if (result.usage) {
      const total = result.usage.total || result.usage.prompt + result.usage.completion
      if (total > 0) usageAnchor = { index: conversation.length - 1, tokens: total }
    }

    if (result.text && result.text.trim()) summary = result.text.trim()

    if (!result.toolCalls.length) {
      if (wantsModify && !wroteAny && noWriteNudges < 1) {
        noWriteNudges++
        emit({
          type: 'warning',
          message: '模型只回复了文字，没有写文件；已提醒它必须真实落盘。',
        })
        pushHistory({
          role: 'system',
          content:
            '你还没有对工作区执行任何写入。用户要求创建或修改网页应用，请立即调用 fs_write/fs_edit 把真实文件写进工作区，然后 build_project、preview、observe。不要只在聊天里输出代码。',
        })
        continue
      }
      normalAnswer = true
      status = 'done'
      summary = result.text?.trim() || summary || '任务完成。'
      break
    }

    let roundHadWrite = false
    let roundPreview = false
    let budgetHit = false

    for (let index = 0; index < result.toolCalls.length; index++) {
      const call = result.toolCalls[index]
      if (maxTools > 0 && toolsUsed >= maxTools) {
        budgetHit = true
        const resultErr: ToolResult = {
          success: false,
          error: { code: 'budget_exceeded', message: '工具调用次数达到上限', recoverable: false },
        }
        const budgetRow = await appendRunMessage({
          taskId,
          runId,
          role: 'tool',
          content: summarizeToolResult(resultErr),
          toolCallId: call.id,
          name: call.name,
          status: 'error',
        })
        pushHistory({
          role: 'tool',
          content: summarizeToolResult(resultErr),
          tool_call_id: call.id,
          name: call.name,
        }, budgetRow.id)
        continue
      }

      if (signal.aborted) {
        const resultAbort: ToolResult = {
          success: false,
          error: { code: 'aborted', message: '任务已中止，未执行该工具', recoverable: false },
        }
        const abortRow = await appendRunMessage({
          taskId,
          runId,
          role: 'tool',
          content: summarizeToolResult(resultAbort),
          toolCallId: call.id,
          name: call.name,
          status: 'aborted',
        })
        pushHistory({
          role: 'tool',
          content: summarizeToolResult(resultAbort),
          tool_call_id: call.id,
          name: call.name,
        }, abortRow.id)
        continue
      }

      toolsUsed++
      emit({ type: 'tool_start', id: call.id, name: call.name, args: call.args })

      const started = performance.now()
      let toolResult: ToolResult
      if (call.argsError) {
        toolResult = {
          success: false,
          error: {
            code: 'bad_arguments',
            message: `工具参数 JSON 解析失败：${call.argsError}`,
            recoverable: true,
          },
        }
      } else {
        const runner = registry[call.name]
        if (!runner) {
          toolResult = {
            success: false,
            error: { code: 'unknown_tool', message: `未知工具：${call.name}`, recoverable: true },
          }
        } else {
          try {
            const args = (call.args || {}) as Record<string, unknown>
            const handlesRefresh = call.name === 'preview' &&
              (args.action === 'open' || (args.action === 'refresh' && (!targetSessionId || !args.sessionId || args.sessionId === targetSessionId)))
            if (handlesRefresh) {
              dirtyPreview = false
            } else if (call.name === 'preview' || call.name === 'page_action' || call.name === 'export_html' || call.name === 'finish') {
              await flushPreview()
            }
            if (signal.aborted) throw new Error('任务已停止，未执行后续工具')
            toolResult = await runner((call.args || {}) as Record<string, unknown>)
            // Agent 显式打开的窗口成为本次运行的新目标；用户切换查看不会影响它。
            if (call.name === 'preview' && args.action === 'open' && toolResult.success) {
              const opened = (toolResult.data as { sessionId?: string } | undefined)?.sessionId
              if (opened) targetSessionId = opened
            }
          } catch (e) {
            toolResult = {
              success: false,
              error: { code: 'tool_exception', message: String((e as Error)?.message || e), recoverable: true },
            }
          }
        }
      }
      const durationMs = Math.round(performance.now() - started)

      const callArgs = (call.args || {}) as Record<string, unknown>
      const isAssetWrite =
        (call.name === 'library' && callArgs.action === 'copy_to_workspace') ||
        (call.name === 'attachment' && callArgs.action === 'import_to_workspace') ||
        (call.name === 'component' && (callArgs.action === 'assemble' || callArgs.action === 'reassemble'))
      if ((WRITE_TOOLS.has(call.name) || isAssetWrite || (call.name === 'snapshot' && callArgs.action === 'restore')) && toolResult.success) {
        wroteAny = true
        dirtyPreview = true
        previewAttempted = false
        roundHadWrite = true
        const path =
          typeof callArgs.path === 'string'
            ? callArgs.path
            : typeof callArgs.targetPath === 'string'
              ? callArgs.targetPath
              : ''
        if (/\.html?$/i.test(path)) wroteHtml = true
        if (call.name === 'attachment' && isAssetWrite) {
          const data = toolResult.data as { htmlEntries?: string[] } | undefined
          if (data?.htmlEntries?.length) wroteHtml = true
        }
      }
      if (call.name === 'preview') {
        const action = String((call.args as Record<string, unknown> | undefined)?.action || '')
        if (toolResult.success && action === 'observe') {
          const data = toolResult.data as { ready?: boolean; dom?: unknown; sessionId?: string; buildVersion?: number; errors?: unknown[] } | undefined
          previewAttempted = data?.ready === true && data.dom != null && !data.errors?.length &&
            data.sessionId === targetSessionId
          roundPreview = true
        }
      }

      if (call.name === 'finish' && toolResult.success) {
        if (wroteHtml && !previewAttempted && finishNudges < 1) {
          finishNudges++
          toolResult = {
            success: false,
            error: {
              code: 'need_preview',
              message:
                '检测到你写了 HTML 但还没有打开或观察试玩。请先调用 preview({action:"open"}) 并用 preview({action:"observe"}) 读取真实运行结果，再 finish。',
              recoverable: true,
            },
          }
        } else {
          finishCalled = true
          const args = (call.args || {}) as Record<string, unknown>
          if (typeof args.summary === 'string') finishSummary = args.summary
        }
      }

      const callStatus: ToolCallRecord['status'] = toolResult.success ? 'ok' : 'error'
      const callRecord = dbCalls.find((c) => c.id === call.id)
      if (callRecord) {
        callRecord.status = callStatus
        callRecord.result = truncate(JSON.stringify(toolResult), 4000)
        callRecord.durationMs = durationMs
      }
      if (assistantRow.id) {
        await updateMessage(assistantRow.id, { toolCalls: dbCalls })
      }

      const content = summarizeToolResult(toolResult)
      const toolRow = await appendRunMessage({
        taskId,
        runId,
        role: 'tool',
        content,
        toolCallId: call.id,
        name: call.name,
        status: toolResult.success ? 'done' : 'error',
      })
      pushHistory({
        role: 'tool',
        content,
        tool_call_id: call.id,
        name: call.name,
      }, toolRow.id)
      emit({ type: 'tool_end', id: call.id, name: call.name, result: toolResult, durationMs })

      const signature = `${call.name}|${call.argsRaw || JSON.stringify(call.args ?? {})}|${content}`
      if (signature === lastCallSignature) repeatedCalls++
      else {
        lastCallSignature = signature
        repeatedCalls = 1
      }
      if (repeatedCalls >= STALL_REPEATS) stalled = true
    }

    await flushPreview()
    if (previewNotes.length) pushHistory({ role: 'system', content: previewNotes.splice(0).join('\n') })

    if (finishCalled) {
      status = 'done'
      summary = finishSummary || summary || '任务完成。'
      break
    }

    if (stalled) {
      status = 'budget'
      summary = `检测到连续 ${STALL_REPEATS} 次完全相同的工具调用和相同结果（${lastCallSignature.split('|')[0]}），判断为原地打转，已停止。已写入的文件保留在工作区；可以换个说法描述目标，或自己先改一处再让它继续。`
      emit({ type: 'warning', message: `连续 ${STALL_REPEATS} 次相同调用，已停止以免空烧请求。` })
      break
    }

    if (budgetHit) {
      status = 'budget'
      summary = `工具调用次数达到上限（${maxTools}），任务停止。已写入的文件保留在工作区；可在设置里提高「最大工具次数」，或直接说「继续」接着做。`
      break
    }

    if (signal.aborted) {
      status = 'aborted'
      summary = '已停止；已写入的文件保留在工作区。'
      break
    }

    if (wantsModify && !roundHadWrite && !roundPreview && result.toolCalls.length) {
      readOnlyStreak++
      if (readOnlyStreak >= 2 && !readOnlyNudgeGiven) {
        readOnlyNudgeGiven = true
        readOnlyStreak = 0
        emit({
          type: 'warning',
          message: '连续两轮只调用只读工具；已提醒 Agent 要么写文件，要么结束。',
        })
        pushHistory({
          role: 'system',
          content:
            '你已经连续两轮只调用只读工具，没有任何写入或试玩动作。请立即选择：1) 用 fs_write/fs_edit 写入文件；2) 如果任务已完成，调用 finish 并总结。不要再反复读取。',
        })
      }
    } else if (roundHadWrite || roundPreview) {
      readOnlyStreak = 0
    }
  }

  if (maxRounds > 0 && rounds >= maxRounds && !normalAnswer && !finishCalled && status === 'done' && !fatalError) {
    status = 'budget'
    summary = `已达到你设置的轮数上限（${maxRounds} 轮），任务在这里停下。已写入的文件保留在工作区；可以把设置里的上限改大、清空成 0（不限）后重发，或直接说「继续」从当前文件接着做。`
  }

  if (wroteAny) {
    const verification = previewAttempted ? '当前构建已读取页面状态；关键交互仍请实际试玩。' : '改动已写入，但当前构建尚未完成有效试玩观察；不代表作品已验证。'
    summary = [summary, verification].filter(Boolean).join('\n\n')
    emit({ type: 'warning', message: verification })
  }

  const finalStatus: RunAgentResult['status'] = fatalError ? 'error' : status
  const finalSummary =
    summary ||
    (finalStatus === 'error'
      ? fatalError || '运行失败'
      : finalStatus === 'aborted'
        ? '已停止；已写入的文件保留在工作区。'
        : '任务完成。')

  await updateTask(taskId, {
    status:
      finalStatus === 'done' || finalStatus === 'budget'
        ? 'idle'
        : finalStatus === 'aborted'
          ? 'interrupted'
          : 'error',
  })

  emit({
    type: 'run_end',
    status: finalStatus,
    summary: finalSummary,
    rounds,
    tools: toolsUsed,
  })

  return {
    runId,
    status: finalStatus,
    summary: finalSummary,
    rounds,
    tools: toolsUsed,
    error: fatalError || undefined,
  }
}
