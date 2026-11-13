/** 工作台数据类型。所有工作区记录都以 [taskId, path] 为主键。 */

export type TaskStatus = 'idle' | 'running' | 'interrupted' | 'error'

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface Conversation {
  id: string
  title: string
  workspaceId: string
  createdAt: number
  updatedAt: number
  /** 早前历史的压缩摘要；存在时消息 id <= summaryUpToId 的记录不再送进模型。 */
  summary?: string
  summaryUpToId?: number
  summaryUpdatedAt?: number
}

export interface Task {
  id: string
  title: string
  status: TaskStatus
  entryPath: string
  todos: TodoItem[]
  lastRunId?: string
  lastRunAt?: number
  createdAt: number
  updatedAt: number
}

export interface UsageInfo {
  prompt: number
  completion: number
  total: number
}

export interface ToolCallRecord {
  id: string
  name: string
  arguments: string
  status: 'running' | 'ok' | 'error'
  result?: string
  durationMs?: number
}

export type ChatRole = 'user' | 'assistant' | 'tool'

export interface MessageRecord {
  id?: number
  taskId: string
  conversationId?: string
  runId?: string
  seq: number
  role: ChatRole
  content: string
  reasoning?: string
  reasoningText?: string
  toolCalls?: ToolCallRecord[]
  toolCallId?: string
  name?: string
  status: 'streaming' | 'done' | 'aborted' | 'error'
  usage?: UsageInfo
  createdAt: number
}

/** 一次模型请求的用量记录。统计用，失败请求也记（token 记 0）。 */
export interface UsageEventRecord {
  id?: number
  /** 请求结束时间（毫秒时间戳）。 */
  at: number
  model: string
  /** baseUrl 的 host，用于区分"同名模型跑在不同网关上"。 */
  host: string
  source: UsageSource
  /** 输入的 token 总数（含命中缓存部分，各家口径一致的按总数存）。 */
  prompt: number
  completion: number
  /** 命中缓存的输入 token。 */
  cached: number
  /** 写入缓存的输入 token。 */
  cacheWrite: number
  /** completion 里的推理 token。 */
  reasoning: number
  total: number
  ok: boolean
  /** 请求耗时（毫秒）。 */
  ms: number
  errorCode?: string
  taskId?: string
  conversationId?: string
  runId?: string
  /** 主循环里的第几轮（从 1 开始）。 */
  round?: number
}

/** 请求来源：主对话 / 上下文摘要 / 角色卡对话 / 组件内 AI。 */
export type UsageSource = 'agent' | 'compaction' | 'character' | 'component'

export interface WorkspaceFile {
  taskId: string
  path: string
  mime: string
  size: number
  text?: string
  blob?: Blob
  hash: string
  source: 'agent' | 'user' | 'attachment' | 'library' | 'export'
  createdAt: number
  updatedAt: number
}

export interface PreviewCapabilities {
  console: boolean
  dom: boolean
  interaction: boolean
  networkMetadata: boolean
  screenshot: boolean
  storage: boolean
  virtualOrigin: boolean
  /** 试玩页可通过 Workbench.ai.chat 请求共享模型；需要用户在试玩区显式授权。 */
  ai?: boolean
}

export interface PreviewSessionRecord {
  id: string
  taskId: string
  name: string
  entryPath: string
  mode: 'sw' | 'inline'
  status: 'opening' | 'ready' | 'error' | 'closed'
  buildVersion: number
  capabilities: PreviewCapabilities
  limitations: string[]
  /** 仅兼容模式为 true：iframe 带 allow-same-origin。默认严格隔离。 */
  allowSameOrigin?: boolean
  error?: string
  createdAt: number
  updatedAt: number
}

export interface ExecutionEventRecord {
  id?: number
  taskId: string
  runId?: string
  sessionId?: string
  type: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  data?: unknown
  buildVersion?: number
  createdAt: number
}

export interface SnapshotFile {
  path: string
  mime: string
  size: number
  hash: string
  text?: string
  binary: boolean
}

export interface ProjectSnapshotRecord {
  id: string
  taskId: string
  label: string
  files: SnapshotFile[]
  truncated: boolean
  createdAt: number
}

/* ───────────────────── 阶段 2：常用资料、附件与引用 ───────────────────── */

/** 资料/附件的可读形态。readable=可读文本，image=可看图，runnable=可试玩 HTML，unsupported=不支持解析。 */
export type AssetParseStatus = 'readable' | 'image' | 'runnable' | 'unsupported' | 'binary'

export interface LibraryFolder {
  id: string
  /** 空字符串表示根目录。 */
  parentId: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface LibraryFile {
  id: string
  folderId: string
  name: string
  mime: string
  size: number
  /** 文本资料只存 text；二进制资料只存 blob。 */
  text?: string
  blob?: Blob
  hash: string
  kind: 'upload' | 'note'
  parseStatus: AssetParseStatus
  parseNote?: string
  /** 识别到的角色卡摘要；不是所有文件都有。 */
  card?: CharacterCardSummary
  createdAt: number
  updatedAt: number
}

/** 建立引用时的文件快照，用于追溯本次任务实际参考过的内容。 */
export interface LibraryRefFile {
  fileId: string
  name: string
  mime: string
  size: number
  hash: string
}

export interface TaskLibraryRef {
  id: string
  taskId: string
  targetType: 'folder' | 'file'
  targetId: string
  name: string
  /** 建立引用时的文件夹路径，如 “写作/模板”。 */
  folderPath: string
  files: LibraryRefFile[]
  createdAt: number
}

export interface TaskLibraryRefView extends TaskLibraryRef {
  /** 当前仍存在的文件数（文件夹引用会包含后来新增的文件）。 */
  currentFiles: number
  addedFiles: number
  missingFiles: LibraryRefFile[]
  changedFiles: LibraryRefFile[]
}

/** 角色卡识别摘要，避免每次渲染都重新解析 PNG/JSON。 */
export interface CharacterCardSummary {
  name: string
  spec: string
  format: 'json' | 'png'
  unsupported: string[]
  worldEntries: number
}

export interface Attachment {
  id: string
  taskId: string
  /** 保留上传时的相对路径（文件夹上传可含 /），导入工作区时据此保持目录关系。 */
  name: string
  mime: string
  size: number
  text?: string
  blob?: Blob
  hash: string
  parseStatus: AssetParseStatus
  parseNote?: string
  /** 识别到的角色卡摘要；不是所有文件都有。 */
  card?: CharacterCardSummary
  createdAt: number
}

export interface ApiProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
}

export interface ApiSettings {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  /** 一次运行最多几轮模型请求；0 = 不限（与本地 Agent 一致）。 */
  maxRounds: number
  /** 一次运行累计的工具调用上限；0 = 不限。 */
  maxToolCalls: number
  /** 模型的上下文窗口；用于判断何时压缩历史。<=0 关闭按阈值的自动压缩。 */
  contextWindow: number
  /** 留给输出的余量：占用超过 `contextWindow - reserveTokens` 就压缩。 */
  reserveTokens: number
  /** 压缩时保留最近多少 token 的原文。 */
  keepRecentTokens: number
  profiles: ApiProfile[]
}

export interface UiSettings {
  splitRatio: number
  showFilePanel: boolean
  mobileTab: 'agent' | 'preview'
  /** strict = 内联 + 无 allow-same-origin；compat = SW 虚拟源 + allow-same-origin */
  previewSecurity: 'strict' | 'compat'
}

/** 任务级模型覆盖：只覆盖填写的字段，其余沿用全局设置。 */
export type TaskApiOverride = Partial<Pick<ApiSettings, 'baseUrl' | 'apiKey' | 'model' | 'temperature'>>

export interface SettingRecord<T = unknown> {
  key: string
  value: T
  updatedAt: number
}

export interface ApplicationSave {
  id: string
  taskId: string
  namespace: string
  key: string
  value: unknown
  updatedAt: number
}

export const DEFAULT_API_SETTINGS: ApiSettings = {
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.7,
  // 0 = 不限。和本地 Agent 一样：靠用户随时中断 + 上下文压缩封顶，不靠硬轮数。
  maxRounds: 0,
  maxToolCalls: 0,
  // 大多数 OpenAI 兼容模型的窗口是 128k；小模型按实际改。
  contextWindow: 128_000,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  profiles: [],
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  splitRatio: 0.46,
  showFilePanel: false,
  mobileTab: 'agent',
  previewSecurity: 'strict',
}

export const DEFAULT_CAPABILITIES: PreviewCapabilities = {
  console: true,
  dom: true,
  interaction: true,
  networkMetadata: true,
  screenshot: false,
  storage: true,
  virtualOrigin: true,
  ai: true,
}
