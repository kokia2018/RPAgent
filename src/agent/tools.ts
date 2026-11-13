import type { AgentEvent, ChatToolDef, ToolResult } from './types'
import type { TodoItem, WorkspaceFile } from '../db/types'
import {
  createSnapshot,
  deleteWorkspaceEntry,
  diffSnapshot,
  getLatestPreviewSession,
  getPreviewSession,
  getSnapshot,
  getTask,
  getWorkspaceFile,
  listPreviewSessions,
  listSnapshots,
  listWorkspaceFiles,
  restoreSnapshot,
  setTaskTodos,
  updateTask,
  writeWorkspaceBinary,
  writeWorkspaceText,
} from '../db/repo'
import {
  descendantFolderIds,
  describeTaskLibraryRefs,
  getSelectedLibraryFile,
  getTaskAttachment,
  importAttachmentsToWorkspace,
  listLibraryFolders,
  listTaskAttachments,
  listTaskLibraryRefs,
  readAttachmentText,
  readLibraryFileText,
  selectedLibraryFiles,
} from '../db/assets'
import { parseCharacterCardFromFile } from '../character/card'
import { db } from '../db/db'
import { componentRegistry, createCharacterPage, detectArtifact, encodeCardFile, makeDefaultCover, updateCharacterArtifact } from '../artifacts'
import { analyzeProject, type ProjectFile } from '../preview/compiler'
import { previewManager } from '../preview/manager'
import { exportHtml, exportSummaryText } from '../export/exportHtml'
import { countLines, lineSlice, truncate } from '../lib/text'
import { mimeFromPath, isTextMime } from '../lib/mime'
import { normalizePath, sanitizeFileName } from '../lib/path'
import JsWorker from './js-worker?worker&inline'

export interface ToolContext {
  taskId: string
  conversationId?: string
  /** 运行开始时冻结的目标窗口；用户之后切换查看窗口不会改变它。 */
  targetSessionId?: string
  /** 工具在已持有空间写锁的运行内调用，组件重组不能再次排队。 */
  locked?: boolean
  runId: string
  signal: AbortSignal
  emit: (event: AgentEvent) => void
}

export type ToolRunner = (args: Record<string, unknown>) => Promise<ToolResult>

const ok = (data?: unknown, warnings?: string[]): ToolResult => ({ success: true, data, warnings })
const fail = (code: string, message: string, recoverable = true): ToolResult => ({
  success: false,
  error: { code, message, recoverable },
})

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key]
  return typeof v === 'boolean' ? v : fallback
}

function arr(args: Record<string, unknown>, key: string): unknown[] {
  const v = args[key]
  return Array.isArray(v) ? v : []
}

function projectFiles(files: Awaited<ReturnType<typeof listWorkspaceFiles>>): ProjectFile[] {
  return files.map((f) => ({
    path: f.path,
    mime: f.mime,
    size: f.size,
    text: f.text,
    blob: f.blob,
  }))
}

async function resolveSessionId(
  taskId: string,
  requested?: string,
  frozen?: string,
  options: { allowOtherWorkspace?: boolean } = {},
): Promise<string> {
  const id = requested ?? frozen ?? previewManager.getActiveSession(taskId)
  const s = id ? await getPreviewSession(id) : await getLatestPreviewSession(taskId)
  if (id && (!s || s.status === 'closed')) throw new Error('试玩会话已关闭或不存在')
  if (!s) throw new Error('当前任务还没有试玩会话，请先调用 preview({action:"open"})')
  if (s.taskId !== taskId && !options.allowOtherWorkspace) {
    throw new Error('该试玩窗口属于其他工作空间：只能 observe 读取，不能刷新、关闭或写入')
  }
  return s.id
}

/**
 * 解析本次读取要落到哪个工作空间。
 * 默认是对话当前选中的空间；给 workspace 参数（id 或标题）时允许跨空间读取。
 * 只有读工具用它——写工具始终写当前空间，避免手滑改到别的作品。
 */
async function resolveWorkspace(
  args: Record<string, unknown>,
  currentTaskId: string,
): Promise<{ id: string; title: string }> {
  const raw = str(args, 'workspace').trim()
  if (!raw || raw === 'current' || raw === 'self') {
    const task = await getTask(currentTaskId)
    return { id: currentTaskId, title: task?.title || '' }
  }
  const spaces = await db.tasks.toArray()
  const hit = spaces.find((t) => t.id === raw) || spaces.find((t) => t.title === raw)
  if (hit) return { id: hit.id, title: hit.title }
  const fuzzy = spaces.filter((t) => t.title.includes(raw))
  if (fuzzy.length === 1) return { id: fuzzy[0].id, title: fuzzy[0].title }
  throw new Error(
    fuzzy.length > 1
      ? `「${raw}」匹配到多个工作空间（${fuzzy.map((t) => t.title).join('、')}），请用 workspace id`
      : `找不到工作空间「${raw}」`,
  )
}

function runJsWorker(
  code: string,
  inputs: Record<string, string>,
  timeoutMs = 6000,
): Promise<{ ok: boolean; result?: unknown; error?: string; logs: string[] }> {
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = new JsWorker()
    } catch (e) {
      resolve({ ok: false, error: String((e as Error)?.message || e), logs: [] })
      return
    }
    let done = false
    const finish = (value: { ok: boolean; result?: unknown; error?: string; logs: string[] }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      worker.terminate()
      resolve(value)
    }
    const timer = window.setTimeout(() => {
      finish({ ok: false, error: `脚本执行超时（${timeoutMs}ms），已终止 Worker`, logs: [] })
    }, timeoutMs)
    worker.onmessage = (e) => finish(e.data)
    worker.onerror = (e) => finish({ ok: false, error: e.message || 'Worker 执行错误', logs: [] })
    worker.postMessage({ code, inputs })
  })
}

export const TOOL_DEFS: ChatToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: '更新当前任务清单，界面会实时展示。开始多步任务时先列 3-6 项，完成后逐项标记 completed。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_list',
      description: '列出工作区的文件。默认当前对话绑定的工作区；传 workspace 可只读查看其他工作区。可选 path 前缀过滤。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '可选路径前缀，如 / 或 /src' },
          workspace: { type: 'string', description: '可选：其他工作区的 id 或标题（跨空间只读）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_read',
      description: '读取文本文件。默认当前工作区；传 workspace 可只读读取其他工作区。支持行范围，超长内容会截断并标注。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '项目内路径，如 /index.html' },
          startLine: { type: 'integer', description: '起始行（从 1 开始，可选）' },
          endLine: { type: 'integer', description: '结束行（可选）' },
          workspace: { type: 'string', description: '可选：其他工作区的 id 或标题（跨空间只读）' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_write',
      description: '写入或创建当前任务工作区的文本文件。这是交付代码的唯一方式；不要只在聊天里输出代码。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '项目内路径，如 /index.html、/src/game.js' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_edit',
      description: '在文本文件中做精确字符串替换（补丁的最小实现）。优先用于局部修改；oldString 必须唯一，除非 replaceAll=true。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldString: { type: 'string', description: '要替换的原文片段' },
          newString: { type: 'string', description: '替换后的内容' },
          replaceAll: { type: 'boolean', description: '是否替换全部匹配，默认 false' },
        },
        required: ['path', 'oldString', 'newString'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_delete',
      description: '删除文件；如果传入目录路径，会删除该目录下的所有文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_search',
      description: '在当前任务工作区的文本文件中搜索。返回文件、行号、行内容。适合改成名、查引用、定位错误。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          scope: { type: 'string', description: '可选路径前缀，如 /src' },
          regex: { type: 'boolean', description: '是否按正则搜索，默认 false' },
          caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
          maxResults: { type: 'integer', description: '默认 60，最大 200' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_project',
      description:
        '检查入口 HTML 与本地资源引用，返回缺失文件、外部依赖、工作台专用引用与警告。写完文件后先跑它，再打开试玩。',
      parameters: {
        type: 'object',
        properties: {
          entryPath: { type: 'string', description: '可选入口 HTML，默认当前任务入口' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'preview',
      description:
        '管理试玩窗口。open 打开入口 HTML；refresh 同步并刷新；close 关闭；list 列出本空间窗口；list_all 列出所有工作空间的窗口；observe 获取任意窗口当前构建的 console/异常/网络失败/DOM 摘要（可跨工作空间只读）。写入仍只发生在当前工作空间。默认作用于本次运行开始时绑定的窗口。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'refresh', 'close', 'list', 'list_all', 'observe'],
          },
          entryPath: { type: 'string', description: 'open 时可指定入口 HTML' },
          sessionId: { type: 'string', description: '对已有会话操作时传入' },
          includeDom: { type: 'boolean', description: 'observe 时是否读取 DOM 摘要，默认 true' },
          logLimit: { type: 'integer', description: 'observe 返回的 console 条数，默认 40' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'page_action',
      description:
        '对当前试玩页面执行受控操作：query 查元素、click 点击、type 输入、text 读文本、snapshot 页面结构、eval 执行页面内脚本。返回页面真实结果；模拟事件 isTrusted=false。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['query', 'click', 'type', 'text', 'snapshot', 'eval'] },
          selector: { type: 'string', description: 'CSS 选择器' },
          text: { type: 'string', description: 'type 时要输入的文字' },
          code: { type: 'string', description: 'eval 时要执行的 JavaScript 表达式或语句' },
          all: { type: 'boolean', description: 'query 是否返回全部匹配' },
          sessionId: { type: 'string', description: '可选试玩会话 ID' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'js_run',
      description:
        '在独立 Web Worker 中执行纯计算 JavaScript，可超时终止。没有 DOM、网络、工作台数据库；需要文件内容时用 inputPaths 指定，读取后作为 inputs[path] 传入。用 return 返回结果。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript 代码，支持 await 与 return' },
          inputPaths: { type: 'array', items: { type: 'string' }, description: '可选：要读取并传入的文件路径' },
          description: { type: 'string', description: '一句话说明脚本目的' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        '获取公开网络资源（受浏览器 CORS 限制）。返回状态码、类型与文本内容。不可用于调用需要密钥的接口。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          maxChars: { type: 'integer', description: '默认 30000' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'component',
      description:
        '标准作品组件。list 列出已注册组件；detect 检测附件或工作区文件可用哪个组件（不调用模型）；assemble 用标准组件把识别成功的角色卡附件确定性组装成 source.json + manifest.json + index.html；reassemble 在修改 source.json 后按 manifest 重新生成页面（生成页被手改时会拒绝覆盖）；export 把当前卡源导出到工作区（原格式 JSON / 标准 V2 / V3 信封 / 带封面 PNG），用户可在文件面板下载。不兼容的内容先 detect 看缺项，再改派生副本适配。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'detect', 'assemble', 'reassemble', 'export'] },
          attachmentId: { type: 'string', description: 'detect/assemble 的附件 ID' },
          path: { type: 'string', description: 'detect 的工作区文件路径' },
          manifestPath: { type: 'string', description: 'reassemble/export 的 manifest.json 路径' },
          target: {
            type: 'string',
            enum: ['json-original', 'json-v2', 'json-v3', 'png'],
            description: 'export：原格式 JSON、标准 V2、V3 信封或带封面的 PNG 卡',
          },
          coverPath: { type: 'string', description: 'export png 时的封面图片路径；省略则生成默认封面' },
          outPath: { type: 'string', description: 'export 的输出路径；默认 /cards/<角色名>.<ext>' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snapshot',
      description:
        '项目版本快照。create 创建；list 列出；diff 对比当前工作区；restore 恢复文本文件（恢复前会自动创建安全快照）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'diff', 'restore'] },
          id: { type: 'string', description: 'diff / restore 时的快照 ID' },
          label: { type: 'string', description: 'create 时的标签' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'library',
      description:
        '使用用户为当前任务选择的常用资料（只读）。list_refs 列出已选资料；list_files 列出资料文件；read 读取文本；search 在已选资料中搜索；copy_to_workspace 复制到工作区后再修改。未选择的资料无法读取。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list_refs', 'list_files', 'read', 'search', 'copy_to_workspace'] },
          refId: { type: 'string', description: 'list_files 时限定某个引用' },
          fileId: { type: 'string', description: 'read / copy_to_workspace 的资料文件 ID' },
          targetPath: {
            type: 'string',
            description: 'copy_to_workspace 的目标工作区路径（含文件名），默认 /library/<文件名>；以 / 结尾表示目录',
          },
          overwrite: { type: 'boolean', description: '目标文件已存在时是否覆盖，默认 false' },
          query: { type: 'string', description: 'search 关键字' },
          maxResults: { type: 'integer', description: 'search 默认 40，最大 100' },
          startLine: { type: 'integer', description: 'read 起始行（从 1 开始）' },
          endLine: { type: 'integer', description: 'read 结束行' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'attachment',
      description:
        '使用当前任务上传的附件（原始输入，不要覆盖）。list 列出附件与解析状态；read 读取文本附件；import_to_workspace 把附件（可多选）导入工作区，保留相对目录，默认 /uploads。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'read', 'import_to_workspace'] },
          id: { type: 'string', description: 'read 的附件 ID' },
          ids: { type: 'array', items: { type: 'string' }, description: '导入指定附件；省略则导入全部' },
          targetDir: { type: 'string', description: '导入目标目录，默认 /uploads' },
          startLine: { type: 'integer', description: 'read 起始行（从 1 开始）' },
          endLine: { type: 'integer', description: 'read 结束行' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'character_card',
      description:
        '识别并读取角色卡（JSON v1/v2 或 PNG 元数据）。action=read 时用 attachmentId / fileId / path 指定来源；action=list 列出当前任务里识别到的角色卡。返回角色字段、世界书摘要、正则脚本与未启用字段；原始字段保留，不要声称完全兼容。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'list'] },
          attachmentId: { type: 'string', description: '任务附件 ID' },
          fileId: { type: 'string', description: '已选常用资料文件 ID' },
          path: { type: 'string', description: '工作区路径，如 /cards/char.json' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_html',
      description:
        '把项目导出为单 HTML（内联 CSS/JS/图片/字体），写入 /dist/ 并返回交付检查。不包含真实密钥；仍依赖外部网络或工作台能力时会明确报告。',
      parameters: {
        type: 'object',
        properties: {
          entryPath: { type: 'string', description: '可选入口 HTML' },
          name: { type: 'string', description: '可选导出文件名（不含扩展名）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '任务完成。给出简明总结：做了什么、入口文件、试玩状态、导出结果、未解决问题。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
        },
        required: ['summary'],
      },
    },
  },
]

export function createToolRegistry(ctx: ToolContext): Record<string, ToolRunner> {
  const taskId = ctx.taskId

  const readEntryPath = async (requested?: string): Promise<string> => {
    if (requested) return normalizePath(requested)
    const task = await getTask(taskId)
    return normalizePath(task?.entryPath || '/index.html')
  }

  // 普通里程碑由 Agent 决定；批量覆盖、二进制及较大文件必须有可恢复的前像。
  const protect = async (targets: WorkspaceFile[], force = false): Promise<void> => {
    if (!targets.length || (!force && targets.length < 2 && targets.every(f => f.size < 64 * 1024 && typeof f.text === 'string'))) return
    const snap = await createSnapshot(taskId, `Agent 改写前：${targets[0].path}${targets.length > 1 ? ` 等 ${targets.length} 个文件` : ''}`)
    const before = new Map(snap.files.map(f => [f.path, f]))
    const unprotected = targets.filter(f => typeof before.get(f.path)?.text !== 'string' || before.get(f.path)?.hash !== f.hash)
    if (unprotected.length) throw new Error(`未执行：文本快照不含以下文件的完整原文（二进制或超出快照预算）：${unprotected.slice(0, 5).map(f => f.path).join('、')}。请改用新路径，或让用户先备份并手动操作。`)
  }

  const tools: Record<string, ToolRunner> = {
    async todo_write(args) {
      try {
        const todos: TodoItem[] = arr(args, 'todos')
          .map((t) => t as { content?: unknown; status?: unknown })
          .filter((t) => typeof t.content === 'string' && t.content.trim())
          .map((t) => ({
            content: String(t.content).slice(0, 300),
            status:
              t.status === 'completed' || t.status === 'in_progress' || t.status === 'pending'
                ? (t.status as TodoItem['status'])
                : ('pending' as TodoItem['status']),
          }))
        await setTaskTodos(taskId, todos)
        ctx.emit({ type: 'todo', todos })
        return ok({ count: todos.length })
      } catch (e) {
        return fail('todo_error', String((e as Error)?.message || e))
      }
    },

    async fs_list(args) {
      try {
        const prefix = normalizePath(str(args, 'path') || '/')
        const space = await resolveWorkspace(args, taskId)
        const files = await listWorkspaceFiles(space.id)
        const filtered = files.filter(
          (f) => prefix === '/' || f.path === prefix || f.path.startsWith(prefix + '/'),
        )
        return ok({
          workspaceId: space.id,
          workspaceTitle: space.title,
          path: prefix,
          count: filtered.length,
          files: filtered.slice(0, 500).map((f) => ({
            path: f.path,
            mime: f.mime,
            size: f.size,
            bytes: f.size,
            updatedAt: f.updatedAt,
          })),
          truncated: filtered.length > 500,
        })
      } catch (e) {
        return fail('fs_list_error', String((e as Error)?.message || e))
      }
    },

    async fs_read(args) {
      try {
        const path = normalizePath(str(args, 'path'))
        const space = await resolveWorkspace(args, taskId)
        const file = await getWorkspaceFile(space.id, path)
        if (!file) return fail('not_found', `文件不存在：${path}${space.id === taskId ? '' : `（工作空间「${space.title}」）`}`)
        let text: string
        if (typeof file.text === 'string') text = file.text
        else if (file.blob && isTextMime(file.mime || mimeFromPath(path))) text = await file.blob.text()
        else return fail('binary_file', `这是二进制文件（${file.mime}，${file.size} bytes），无法按文本读取：${path}`)
        const totalLines = countLines(text)
        const sliced = lineSlice(text, num(args, 'startLine'), num(args, 'endLine'))
        const limited = truncate(sliced, 120_000)
        return ok({
          workspaceId: space.id,
          workspaceTitle: space.title,
          path,
          mime: file.mime,
          size: file.size,
          totalLines,
          startLine: num(args, 'startLine') || 1,
          endLine: num(args, 'endLine') || totalLines,
          content: limited,
          truncated: limited.length < sliced.length,
        })
      } catch (e) {
        return fail('fs_read_error', String((e as Error)?.message || e))
      }
    },

    async fs_write(args) {
      try {
        const path = normalizePath(str(args, 'path'))
        const content = args.content
        if (!path || path === '/') return fail('bad_path', '必须指定文件路径')
        if (typeof content !== 'string') return fail('bad_content', 'content 必须是字符串')
        const old = await getWorkspaceFile(taskId, path)
        if (old && old.text !== content) await protect([old], true)
        const { file, created } = await writeWorkspaceText(taskId, path, content, 'agent')
        const warnings: string[] = []
        if (file.size > 2 * 1024 * 1024) warnings.push('文件超过 2MB，建议拆分或压缩')
        return ok(
          { path, created, bytes: file.size, lines: countLines(content), hash: file.hash },
          warnings,
        )
      } catch (e) {
        return fail('fs_write_error', String((e as Error)?.message || e))
      }
    },

    async fs_edit(args) {
      try {
        const path = normalizePath(str(args, 'path'))
        const oldString = str(args, 'oldString')
        const newString = args.newString
        if (typeof newString !== 'string') return fail('bad_new_string', 'newString 必须是字符串')
        if (!oldString) return fail('bad_old_string', 'oldString 不能为空')
        const file = await getWorkspaceFile(taskId, path)
        if (!file) return fail('not_found', `文件不存在：${path}`)
        const text = typeof file.text === 'string' ? file.text : file.blob ? await file.blob.text() : ''
        const occurrences = text.split(oldString).length - 1
        if (occurrences === 0) {
          return fail('no_match', `未找到 oldString。请先用 fs_read 确认原文：${path}`)
        }
        const replaceAll = bool(args, 'replaceAll')
        if (occurrences > 1 && !replaceAll) {
          return fail('ambiguous_match', `oldString 匹配 ${occurrences} 处；请提供更长的上下文或设置 replaceAll=true`)
        }
        const next = replaceAll
          ? text.split(oldString).join(newString)
          : text.replace(oldString, () => newString)
        if (next !== text && (typeof file.text !== 'string' || oldString.length * (replaceAll ? occurrences : 1) >= 64 * 1024 || !next)) await protect([file], true)
        const result = await writeWorkspaceText(taskId, path, next, 'agent')
        return ok({
          path,
          replacements: replaceAll ? occurrences : 1,
          beforeChars: text.length,
          afterChars: next.length,
          bytes: result.file.size,
        })
      } catch (e) {
        return fail('fs_edit_error', String((e as Error)?.message || e))
      }
    },

    async fs_delete(args) {
      try {
        const path = normalizePath(str(args, 'path'))
        if (path === '/') return fail('bad_path', '不能删除工作区根目录')
        const targets = (await listWorkspaceFiles(taskId)).filter(f => f.path === path || f.path.startsWith(path + '/'))
        await protect(targets, true)
        const deleted = await deleteWorkspaceEntry(taskId, path)
        if (!deleted) return fail('not_found', `没有找到文件：${path}`)
        return ok({ path, deleted })
      } catch (e) {
        return fail('fs_delete_error', String((e as Error)?.message || e))
      }
    },

    async fs_search(args) {
      try {
        const query = str(args, 'query')
        if (!query) return fail('bad_query', 'query 不能为空')
        const scope = str(args, 'scope') ? normalizePath(str(args, 'scope')) : '/'
        const useRegex = bool(args, 'regex')
        const caseSensitive = bool(args, 'caseSensitive')
        const maxResults = Math.min(200, Math.max(1, num(args, 'maxResults') || 60))
        let re: RegExp | null = null
        if (useRegex) {
          try {
            re = new RegExp(query, caseSensitive ? 'g' : 'gi')
          } catch (e) {
            return fail('bad_regex', `正则无效：${String((e as Error)?.message || e)}`)
          }
        }
        const files = await listWorkspaceFiles(taskId)
        const matches: { path: string; line: number; text: string }[] = []
        let filesScanned = 0
        for (const f of files) {
          if (scope !== '/' && !(f.path === scope || f.path.startsWith(scope + '/'))) continue
          if (f.size > 5 * 1024 * 1024) continue
          const text =
            typeof f.text === 'string'
              ? f.text
              : f.blob && isTextMime(f.mime)
                ? await f.blob.text()
                : undefined
          if (text == null) continue
          filesScanned++
          const lines = text.split(/\r\n|\r|\n/)
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            const hit = re ? line.match(re) : caseSensitive ? line.includes(query) : line.toLowerCase().includes(query.toLowerCase())
            if (!hit) continue
            matches.push({ path: f.path, line: i + 1, text: line.slice(0, 500) })
            if (matches.length >= maxResults) break
          }
          if (matches.length >= maxResults) break
        }
        return ok({ query, filesScanned, matches, truncated: matches.length >= maxResults })
      } catch (e) {
        return fail('fs_search_error', String((e as Error)?.message || e))
      }
    },

    async build_project(args) {
      try {
        const entry = await readEntryPath(str(args, 'entryPath') || undefined)
        const files = await listWorkspaceFiles(taskId)
        const analysis = await analyzeProject(entry, projectFiles(files))
        if (str(args, 'entryPath') && analysis.missing.indexOf(entry) < 0) {
          await updateTask(taskId, { entryPath: entry })
        }
        return ok({
          ...analysis,
          fileCount: files.length,
          hint: analysis.missing.length
            ? '先创建缺失文件，再重新 build_project'
            : '可以调用 preview({action:"open"}) 或 refresh 打开试玩',
        })
      } catch (e) {
        return fail('build_error', String((e as Error)?.message || e))
      }
    },

    async preview(args) {
      try {
        const action = str(args, 'action')
        if (action === 'open') {
          const entry = await readEntryPath(str(args, 'entryPath') || undefined)
          const result = await previewManager.open(taskId, entry)
          if (str(args, 'entryPath') && result.ready) await updateTask(taskId, { entryPath: entry })
          return ok(result, result.warnings)
        }
        if (action === 'refresh') {
          const sessionId = await resolveSessionId(taskId, str(args, 'sessionId') || undefined, ctx.targetSessionId)
          const result = await previewManager.refresh(sessionId)
          return ok(result, result.warnings)
        }
        if (action === 'close') {
          const sessionId = await resolveSessionId(taskId, str(args, 'sessionId') || undefined, ctx.targetSessionId)
          await previewManager.close(sessionId)
          return ok({ sessionId, closed: true })
        }
        if (action === 'list') {
          const sessions = await listPreviewSessions(taskId)
          return ok({
            targetSessionId: ctx.targetSessionId,
            sessions: sessions.map((s) => ({
              sessionId: s.id,
              name: s.name,
              entryPath: s.entryPath,
              mode: s.mode,
              status: s.status,
              buildVersion: s.buildVersion,
            })),
          })
        }
        if (action === 'list_all') {
          // 全局发现只返回元数据；读取或操作其他空间仍需用户改绑后在那里运行。
          const [spaces, sessions] = await Promise.all([db.tasks.toArray(), db.previewSessions.toArray()])
          const titles = new Map(spaces.map((t) => [t.id, t.title]))
          return ok({
            boundWorkspaceId: taskId,
            windows: sessions.filter((s) => s.status !== 'closed').map((s) => ({
              sessionId: s.id,
              workspaceId: s.taskId,
              workspaceTitle: titles.get(s.taskId) || '',
              entryPath: s.entryPath,
              status: s.status,
              buildVersion: s.buildVersion,
              writable: s.taskId === taskId,
            })),
            note: '只有当前绑定空间可读写；其他窗口仅供发现，请让用户把对话绑定到目标空间。',
          })
        }
        if (action === 'observe') {
          const sessionId = await resolveSessionId(taskId, str(args, 'sessionId') || undefined, ctx.targetSessionId, {
            allowOtherWorkspace: true,
          })
          const observation = await previewManager.observe(sessionId, {
            includeDom: bool(args, 'includeDom', true),
            logLimit: Math.min(100, Math.max(1, num(args, 'logLimit') || 40)),
            waitMs: 3000,
          })
          return ok(observation)
        }
        return fail('bad_action', `未知 preview action：${action}`)
      } catch (e) {
        return fail('preview_error', String((e as Error)?.message || e))
      }
    },

    async page_action(args) {
      try {
        const sessionId = await resolveSessionId(taskId, str(args, 'sessionId') || undefined, ctx.targetSessionId)
        const action = str(args, 'action')
        const params: Record<string, unknown> = {}
        if (str(args, 'selector')) params.selector = str(args, 'selector')
        if (str(args, 'text')) params.text = str(args, 'text')
        if (str(args, 'code')) params.code = str(args, 'code')
        if (bool(args, 'all')) params.all = true
        if (action === 'query') params.selector = str(args, 'selector') || 'body'
        if (action === 'text' && !params.selector) params.selector = 'body'
        if (action === 'click' && !params.selector) return fail('bad_selector', 'click 需要 selector')
        if (action === 'type' && !params.selector) return fail('bad_selector', 'type 需要 selector')
        if (action === 'eval' && !params.code) return fail('bad_code', 'eval 需要 code')
        const result = await previewManager.rpc(sessionId, action, params, action === 'eval' ? 10_000 : 6000)
        if (action === 'click' || action === 'type') {
          // 给页面事件与 console 回传一点时间，避免紧接着 observe 时读不到刚触发的错误。
          await new Promise((resolve) => setTimeout(resolve, 180))
        }
        const r = result as { ok?: boolean; error?: string } | null
        if (r && r.ok === false) {
          return fail('page_error', r.error || '页面脚本执行失败')
        }
        return ok({ sessionId, action, result })
      } catch (e) {
        return fail('page_action_error', String((e as Error)?.message || e))
      }
    },

    async js_run(args) {
      try {
        const code = str(args, 'code')
        if (!code) return fail('bad_code', 'code 不能为空')
        const inputs: Record<string, string> = {}
        const warnings: string[] = []
        for (const p of arr(args, 'inputPaths') as string[]) {
          if (typeof p !== 'string') continue
          const path = normalizePath(p)
          const file = await getWorkspaceFile(taskId, path)
          if (!file) {
            warnings.push(`文件不存在，已跳过：${path}`)
            continue
          }
          if (typeof file.text === 'string') inputs[path] = file.text
          else if (file.blob && isTextMime(file.mime)) inputs[path] = await file.blob.text()
          else warnings.push(`不是文本文件，已跳过：${path}`)
        }
        const result = await runJsWorker(code, inputs, 6000)
        if (!result.ok) return fail('js_error', result.error || '脚本执行失败')
        return ok({ result: result.result, logs: result.logs, inputPaths: Object.keys(inputs) }, warnings)
      } catch (e) {
        return fail('js_run_error', String((e as Error)?.message || e))
      }
    },

    async web_fetch(args) {
      try {
        const url = str(args, 'url')
        if (!/^https?:\/\//i.test(url)) return fail('bad_url', '只允许 http(s) URL')
        const maxChars = Math.min(120_000, Math.max(1000, num(args, 'maxChars') || 30_000))
        const controller = new AbortController()
        const onAbort = () => controller.abort()
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        const timer = window.setTimeout(() => controller.abort(), 20_000)
        try {
          const resp = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: 'text/html,application/json,text/plain,*/*' },
          })
          const contentType = resp.headers.get('content-type') || ''
          const text = await resp.text()
          const warnings: string[] = []
          if (!/text|json|xml|javascript/i.test(contentType)) {
            warnings.push(`返回类型是 ${contentType || '未知'}，可能是二进制内容`)
          }
          return ok(
            {
              status: resp.status,
              ok: resp.ok,
              url: resp.url,
              contentType,
              text: truncate(text, maxChars),
              truncated: text.length > maxChars,
              bytes: text.length,
            },
            warnings,
          )
        } finally {
          clearTimeout(timer)
          ctx.signal.removeEventListener('abort', onAbort)
        }
      } catch (e) {
        const msg = String((e as Error)?.message || e)
        return fail(
          'fetch_error',
          `请求失败：${msg}。浏览器端可能被 CORS 拦截；工作台不能绕过 CORS。`,
          !ctx.signal.aborted,
        )
      }
    },

    async component(args) {
      try {
        const action = str(args, 'action')
        if (action === 'list') {
          return ok({ components: Object.values(componentRegistry).map((c) => ({ id: c.id, version: c.version, capabilities: c.capabilities, unsupported: c.unsupported, dependencies: c.dependencies })) })
        }
        if (action === 'detect') {
          const attachmentId = str(args, 'attachmentId')
          if (attachmentId) {
            const att = await getTaskAttachment(attachmentId)
            if (!att || att.taskId !== taskId) return fail('not_found', '附件不存在或不属于当前空间')
            const text = att.text ?? (await readAttachmentText(att)) ?? undefined
            const d = await detectArtifact({ name: att.name, mime: att.mime, text, blob: att.blob })
            return ok({ format: d.format, kind: d.kind, status: d.status, metadata: d.metadata, warnings: d.warnings })
          }
          const path = str(args, 'path')
          if (!path) return fail('bad_args', 'detect 需要 attachmentId 或 path')
          const file = await getWorkspaceFile(taskId, path)
          if (!file) return fail('not_found', `文件不存在：${path}`)
          const d = await detectArtifact({ name: file.path, mime: file.mime, text: file.text, blob: file.blob })
          return ok({ format: d.format, kind: d.kind, status: d.status, metadata: d.metadata, warnings: d.warnings })
        }
        if (action === 'assemble') {
          const attachmentId = str(args, 'attachmentId')
          if (!attachmentId) return fail('bad_args', 'assemble 需要 attachmentId')
          const result = await createCharacterPage(taskId, attachmentId, { locked: ctx.locked === true })
          return ok(result, result.warnings)
        }
        if (action === 'reassemble') {
          const manifestPath = normalizePath(str(args, 'manifestPath'))
          const manifestFile = await getWorkspaceFile(taskId, manifestPath)
          if (typeof manifestFile?.text !== 'string') return fail('not_found', `manifest 不存在：${manifestPath}`)
          const manifest = JSON.parse(manifestFile.text) as { sourcePath?: string; source?: { path?: string } }
          const sourcePath = normalizePath(manifest.sourcePath || manifest.source?.path || '')
          const source = sourcePath ? await getWorkspaceFile(taskId, sourcePath) : undefined
          if (typeof source?.text !== 'string') return fail('not_found', 'manifest 指向的 source 文件不存在')
          const result = await updateCharacterArtifact(taskId, manifestPath, JSON.parse(source.text), { locked: ctx.locked === true })
          return ok(result, result.warnings)
        }
        if (action === 'export') {
          const manifestPath = normalizePath(str(args, 'manifestPath'))
          const manifestFile = await getWorkspaceFile(taskId, manifestPath)
          if (typeof manifestFile?.text !== 'string') return fail('not_found', `manifest 不存在：${manifestPath}`)
          const manifest = JSON.parse(manifestFile.text) as { sourcePath?: string; source?: { path?: string } }
          const sourcePath = normalizePath(manifest.sourcePath || manifest.source?.path || '')
          const source = sourcePath ? await getWorkspaceFile(taskId, sourcePath) : undefined
          if (typeof source?.text !== 'string') return fail('not_found', 'manifest 指向的 source 文件不存在')
          const raw = JSON.parse(source.text)
          const target = (str(args, 'target') || 'json-original') as 'json-original' | 'json-v2' | 'json-v3' | 'png'
          if (!['json-original', 'json-v2', 'json-v3', 'png'].includes(target)) return fail('bad_args', '不支持的角色卡导出格式')
          let cover: Uint8Array | undefined
          const coverArg = str(args, 'coverPath').trim()
          const coverPath = coverArg ? normalizePath(coverArg) : ''
          if (target === 'png') {
            if (coverPath) {
              const coverFile = await getWorkspaceFile(taskId, coverPath)
              if (!coverFile?.blob) return fail('not_found', `封面不是可读取的图片：${coverPath}`)
              cover = new Uint8Array(await coverFile.blob.arrayBuffer())
            } else {
              const name = String((raw as { name?: string; data?: { name?: string } })?.data?.name || (raw as { name?: string })?.name || '角色卡')
              cover = await makeDefaultCover(name, 'RPAgent 导出')
            }
          }
          const encoded = encodeCardFile(raw, target, cover)
          const name = String((raw as { data?: { name?: string } })?.data?.name || (raw as { name?: string })?.name || 'card')
          const suffix = target === 'json-v3' ? '.v3' : target === 'json-v2' ? '.v2' : ''
          const fallback = `/cards/${sanitizeFileName(name, 'card')}${suffix}${encoded.extension}`
          const outPath = normalizePath(str(args, 'outPath') || fallback)
          if (!outPath.toLowerCase().endsWith(encoded.extension)) return fail('bad_path', `目标文件扩展名必须为 ${encoded.extension}`)
          if (!/^\/cards\//.test(outPath)) return fail('bad_path', '导出文件必须放在 /cards/ 目录下，避免覆盖作品源文件')
          const existing = await getWorkspaceFile(taskId, outPath)
          if (existing && existing.source !== 'export') return fail('conflict', `目标文件已存在且不是导出产物：${outPath}`)
          if (encoded.extension === '.json') {
            await writeWorkspaceText(taskId, outPath, new TextDecoder().decode(encoded.bytes), 'export')
          } else {
            const copy = new Uint8Array(encoded.bytes.length)
            copy.set(encoded.bytes)
            await writeWorkspaceBinary(taskId, outPath, new Blob([copy], { type: encoded.mime }), 'export')
          }
          return ok({ path: outPath, bytes: encoded.bytes.length, mime: encoded.mime, target, warnings: encoded.warnings }, encoded.warnings)
        }
        return fail('bad_action', `未知 component action：${action}`)
      } catch (e) {
        return fail('component_error', String((e as Error)?.message || e))
      }
    },

    async snapshot(args) {
      try {
        const action = str(args, 'action')
        if (action === 'create') {
          const snap = await createSnapshot(taskId, str(args, 'label') || '手动快照')
          return ok({ id: snap.id, label: snap.label, fileCount: snap.files.length, truncated: snap.truncated })
        }
        if (action === 'list') {
          const list = await listSnapshots(taskId)
          return ok({
            snapshots: list.map((s) => ({
              id: s.id,
              label: s.label,
              createdAt: s.createdAt,
              fileCount: s.files.length,
              truncated: s.truncated,
            })),
          })
        }
        if (action === 'diff' || action === 'restore') {
          const id = str(args, 'id')
          if (!id) return fail('bad_id', `${action} 需要 id`)
          const snap = await getSnapshot(id)
          if (!snap || snap.taskId !== taskId) return fail('not_found', '快照不存在或不属于当前任务')
          if (action === 'diff') {
            const diff = await diffSnapshot(id)
            return ok({ id, diff })
          }
          const safety = await createSnapshot(taskId, '恢复前自动快照')
          const restoring = new Set(snap.files.filter(f => !f.binary && typeof f.text === 'string' && (f.text || !f.size)).map(f => f.path))
          if (safety.files.some(f => restoring.has(f.path) && typeof f.text !== 'string')) {
            return fail('unprotected_restore', '未执行恢复：部分将被覆盖的现有文件没有完整文本备份，请先手动备份。')
          }
          const result = await restoreSnapshot(id)
          return ok({ id, safetySnapshotId: safety.id, ...result })
        }
        return fail('bad_action', `未知 snapshot action：${action}`)
      } catch (e) {
        return fail('snapshot_error', String((e as Error)?.message || e))
      }
    },

    async library(args) {
      try {
        const action = str(args, 'action')
        if (action === 'list_refs') {
          const refs = await describeTaskLibraryRefs(taskId)
          return ok({
            count: refs.length,
            refs: refs.map((r) => ({
              refId: r.id,
              targetType: r.targetType,
              name: r.name,
              folderPath: r.folderPath,
              files: r.files.slice(0, 20).map((f) => ({
                fileId: f.fileId,
                name: f.name,
                mime: f.mime,
                size: f.size,
              })),
              filesTruncated: r.files.length > 20,
              currentFiles: r.currentFiles,
              addedFiles: r.addedFiles,
              missingFiles: r.missingFiles.map((f) => f.name),
              changedFiles: r.changedFiles.map((f) => f.name),
            })),
            hint: refs.length
              ? '用 library({action:"list_files"}) 看文件，再按需 read；资料只读，修改前先 copy_to_workspace。'
              : '用户还没有为当前任务选择常用资料。可以在回复中请用户到「任务资料」面板选择。',
          })
        }

        if (action === 'list_files') {
          const refs = await listTaskLibraryRefs(taskId)
          const allowed = await selectedLibraryFiles(taskId)
          let files = allowed
          const refId = str(args, 'refId')
          if (refId) {
            const ref = refs.find((r) => r.id === refId)
            if (!ref) return fail('not_found', '引用的资料不存在或已被移除')
            if (ref.targetType === 'file') {
              files = allowed.filter((f) => f.id === ref.targetId)
            } else {
              const folders = await listLibraryFolders()
              const ids = descendantFolderIds(ref.targetId, folders)
              files = allowed.filter((f) => ids.has(f.folderId))
            }
          }
          return ok({
            count: files.length,
            files: files.slice(0, 300).map((f) => ({
              fileId: f.id,
              name: f.name,
              mime: f.mime,
              size: f.size,
              parseStatus: f.parseStatus,
            })),
            truncated: files.length > 300,
          })
        }

        if (action === 'read') {
          const fileId = str(args, 'fileId')
          if (!fileId) return fail('bad_file_id', 'read 需要 fileId')
          const file = await getSelectedLibraryFile(taskId, fileId)
          if (file.parseStatus === 'image') {
            return fail(
              'binary_file',
              `这是图片资料，无法按文本读取：${file.name}。可在页面中作为素材使用，或复制到工作区。`,
            )
          }
          if (file.parseStatus === 'unsupported' || file.parseStatus === 'binary') {
            return fail('unsupported_file', `${file.name}：${file.parseNote || '此格式暂不支持按文本读取。'}`)
          }
          const text = await readLibraryFileText(file)
          if (text == null) return fail('unsupported_file', `无法读取资料正文：${file.name}`)
          const totalLines = countLines(text)
          const sliced = lineSlice(text, num(args, 'startLine'), num(args, 'endLine'))
          const limited = truncate(sliced, 120_000)
          return ok({
            fileId,
            name: file.name,
            mime: file.mime,
            size: file.size,
            hash: file.hash,
            totalLines,
            content: limited,
            truncated: limited.length < sliced.length,
          })
        }

        if (action === 'search') {
          const query = str(args, 'query')
          if (!query) return fail('bad_query', 'query 不能为空')
          const maxResults = Math.min(100, Math.max(1, num(args, 'maxResults') || 40))
          const files = await selectedLibraryFiles(taskId)
          const lower = query.toLowerCase()
          const matches: { fileId: string; name: string; line: number; text: string }[] = []
          let filesScanned = 0
          for (const file of files) {
            if (file.size > 5 * 1024 * 1024) continue
            const text = await readLibraryFileText(file)
            if (text == null) continue
            filesScanned++
            const lines = text.split(/\r\n|\r|\n/)
            for (let i = 0; i < lines.length; i++) {
              if (!lines[i].toLowerCase().includes(lower)) continue
              matches.push({ fileId: file.id, name: file.name, line: i + 1, text: lines[i].slice(0, 400) })
              if (matches.length >= maxResults) break
            }
            if (matches.length >= maxResults) break
          }
          return ok({ query, filesScanned, matches, truncated: matches.length >= maxResults })
        }

        if (action === 'copy_to_workspace') {
          const fileId = str(args, 'fileId')
          if (!fileId) return fail('bad_file_id', 'copy_to_workspace 需要 fileId')
          const file = await getSelectedLibraryFile(taskId, fileId)
          const rawTarget = str(args, 'targetPath')
          let target = rawTarget
            ? normalizePath(rawTarget)
            : normalizePath(`/library/${file.name}`)
          if (rawTarget.endsWith('/')) target = normalizePath(`${target}/${file.name}`)
          if (target === '/') return fail('bad_path', '目标必须是文件路径')
          const existing = await getWorkspaceFile(taskId, target)
          if (existing && !bool(args, 'overwrite')) {
            return fail('already_exists', `目标文件已存在：${target}。确认要覆盖时传 overwrite=true。`)
          }
          if (existing) await protect([existing])
          const text = await readLibraryFileText(file)
          if (text != null && file.parseStatus !== 'binary' && file.parseStatus !== 'image') {
            await writeWorkspaceText(taskId, target, text, 'library')
          } else if (file.blob) {
            await writeWorkspaceBinary(taskId, target, file.blob, 'library', file.hash)
          } else {
            return fail('unsupported_file', `资料没有可复制的内容：${file.name}`)
          }
          return ok({ fileId, source: file.name, path: target, replaced: Boolean(existing) })
        }

        return fail('bad_action', `未知 library action：${action}`)
      } catch (e) {
        return fail('library_error', String((e as Error)?.message || e))
      }
    },

    async attachment(args) {
      try {
        const action = str(args, 'action')
        if (action === 'list') {
          const attachments = await listTaskAttachments(taskId)
          return ok({
            count: attachments.length,
            attachments: attachments.slice(0, 100).map((a) => ({
              id: a.id,
              name: a.name,
              mime: a.mime,
              size: a.size,
              parseStatus: a.parseStatus,
              parseNote: a.parseNote,
              createdAt: a.createdAt,
            })),
            truncated: attachments.length > 100,
            hint: attachments.length
              ? '文本附件用 attachment({action:"read"})；HTML/素材先 import_to_workspace 再预览。'
              : '当前任务还没有附件。',
          })
        }

        if (action === 'read') {
          const id = str(args, 'id')
          if (!id) return fail('bad_attachment_id', 'read 需要附件 id')
          const attachment = await getTaskAttachment(id)
          if (!attachment || attachment.taskId !== taskId) return fail('not_found', '附件不存在或不属于当前任务')
          if (attachment.parseStatus === 'image') {
            return fail('binary_file', `这是图片附件，无法按文本读取：${attachment.name}。可导入工作区后在页面中使用。`)
          }
          if (attachment.parseStatus === 'unsupported' || attachment.parseStatus === 'binary') {
            return fail('unsupported_file', `${attachment.name}：${attachment.parseNote || '此格式暂不支持按文本读取。'}`)
          }
          const text = await readAttachmentText(attachment)
          if (text == null) return fail('unsupported_file', `无法读取附件正文：${attachment.name}`)
          const totalLines = countLines(text)
          const sliced = lineSlice(text, num(args, 'startLine'), num(args, 'endLine'))
          const limited = truncate(sliced, 120_000)
          return ok({
            id,
            name: attachment.name,
            mime: attachment.mime,
            size: attachment.size,
            totalLines,
            content: limited,
            truncated: limited.length < sliced.length,
          })
        }

        if (action === 'import_to_workspace') {
          const ids = arr(args, 'ids')
            .map((v) => (typeof v === 'string' ? v : ''))
            .filter(Boolean)
          const all = await listTaskAttachments(taskId)
          if (ids.length && ids.some((id) => !all.some((a) => a.id === id))) {
            return fail('not_found', '部分附件不存在或不属于当前任务')
          }
          const result = await importAttachmentsToWorkspace(
            taskId,
            ids.length ? ids : undefined,
            str(args, 'targetDir') || '/uploads',
          )
          return ok(
            {
              ...result,
              hint: result.htmlEntries.length
                ? '可调用 preview({action:"open", entryPath}) 运行导入的 HTML。相对资源已按原目录导入。'
                : '附件已导入工作区；源附件保持不变。',
            },
            result.warnings,
          )
        }

        return fail('bad_action', `未知 attachment action：${action}`)
      } catch (e) {
        return fail('attachment_error', String((e as Error)?.message || e))
      }
    },

    async character_card(args) {
      try {
        const action = str(args, 'action')
        if (action === 'list') {
          const attachments = (await listTaskAttachments(taskId)).filter((a) => a.card)
          const library = (await selectedLibraryFiles(taskId)).filter((f) => f.card)
          return ok({
            count: attachments.length + library.length,
            cards: [
              ...attachments.map((a) => ({
                source: 'attachment',
                id: a.id,
                name: a.name,
                card: a.card,
              })),
              ...library.map((f) => ({
                source: 'library',
                id: f.id,
                name: f.name,
                card: f.card,
              })),
            ],
            hint: '用 character_card({action:"read", attachmentId/fileId/path}) 读取完整字段；PNG 卡也支持。',
          })
        }

        if (action !== 'read') return fail('bad_action', `未知 character_card action：${action}`)

        let name = ''
        let mime = ''
        let text: string | undefined
        let blob: Blob | undefined
        const attachmentId = str(args, 'attachmentId')
        const fileId = str(args, 'fileId')
        const path = str(args, 'path')

        if (attachmentId) {
          const attachment = await getTaskAttachment(attachmentId)
          if (!attachment || attachment.taskId !== taskId) return fail('not_found', '附件不存在或不属于当前任务')
          name = attachment.name
          mime = attachment.mime
          text = attachment.text ?? (await readAttachmentText(attachment)) ?? undefined
          blob = attachment.blob
        } else if (fileId) {
          const file = await getSelectedLibraryFile(taskId, fileId)
          name = file.name
          mime = file.mime
          text = file.text ?? (await readLibraryFileText(file)) ?? undefined
          blob = file.blob
        } else if (path) {
          const file = await getWorkspaceFile(taskId, normalizePath(path))
          if (!file) return fail('not_found', `工作区文件不存在：${path}`)
          name = file.path
          mime = file.mime
          text = typeof file.text === 'string' ? file.text : file.blob ? await file.blob.text().catch(() => undefined) : undefined
          blob = file.blob
        } else {
          return fail('bad_source', 'read 需要 attachmentId、fileId 或 path')
        }

        const card = await parseCharacterCardFromFile(name, mime, text, blob)
        if (!card) {
          return fail(
            'not_character_card',
            '没有识别到角色卡。支持 JSON 角色卡（v1/v2）与带 chara/ccv3 元数据的 PNG；普通图片或配置不会被当成角色卡。',
          )
        }
        const d = card.data
        return ok({
          format: card.format,
          summary: card.summary,
          fields: {
            spec: d.spec,
            name: d.name,
            description: truncate(d.description, 8000),
            personality: truncate(d.personality, 4000),
            scenario: truncate(d.scenario, 4000),
            firstMes: truncate(d.firstMes, 4000),
            mesExample: truncate(d.mesExample, 4000),
            creatorNotes: truncate(d.creatorNotes, 2000),
            systemPrompt: truncate(d.systemPrompt, 4000),
            postHistoryInstructions: truncate(d.postHistoryInstructions, 4000),
            alternateGreetings: d.alternateGreetings.slice(0, 5).map((g) => truncate(g, 1000)),
            tags: d.tags,
            creator: d.creator,
            version: d.version,
          },
          worldEntries: d.worldEntries.slice(0, 50).map((entry) => ({
            name: entry.name,
            keys: entry.keys.slice(0, 20),
            enabled: entry.enabled,
            constant: entry.constant,
            order: entry.order,
            position: entry.position,
            role: entry.role,
            depth: entry.depth ?? null,
            probability: entry.useProbability ? entry.probability ?? null : null,
            content: truncate(entry.content, 1200),
          })),
          worldEntriesTruncated: d.worldEntries.length > 50,
          regexScripts: d.regexScripts.map((script) => ({
            name: script.name,
            find: truncate(script.find, 400),
            replace: truncate(script.replace, 400),
            placement: script.placement,
            disabled: script.disabled,
          })),
          unsupported: d.unsupported,
          unknownFields: d.unknownFields,
          note:
            '工作台基础对话启用 name/description/personality/scenario/first_mes/alternate_greetings/mes_example/system_prompt/post_history_instructions、世界书关键词触发（递归最多 2 轮）与插入位置（设定前/后、示例前/后、at_depth 按深度注入对话消息）、变量宏与角色卡正则脚本（placement 1=输入，2=输出）；其余字段只保留原始数据，不要宣称完全兼容。',
        })
      } catch (e) {
        return fail('character_card_error', String((e as Error)?.message || e))
      }
    },

    async export_html(args) {
      try {
        const entry = await readEntryPath(str(args, 'entryPath') || undefined)
        const task = await getTask(taskId)
        const result = await exportHtml(taskId, entry, str(args, 'name') || undefined, task?.title)
        const warnings = [...result.warnings]
        if (result.level !== 'offline-static') {
          warnings.push('当前作品还不是完全离线单 HTML，请在总结中如实说明')
        }
        return ok({ ...result, summary: exportSummaryText(result) }, warnings)
      } catch (e) {
        return fail('export_error', String((e as Error)?.message || e))
      }
    },

    async finish(args) {
      return ok({ summary: str(args, 'summary') })
    },
  }

  return tools
}
