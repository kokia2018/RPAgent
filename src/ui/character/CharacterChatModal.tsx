import { useEffect, useRef, useState } from 'react'
import type { ApiSettings } from '../../db/types'
import type { ChatMessage } from '../../agent/types'
import { LLMError } from '../../agent/types'
import { configFromSettings, streamChat } from '../../agent/llm'
import { getTaskAttachment, getLibraryFile, readAttachmentText } from '../../db/assets'
import { getAppSave, removeAppSave, setAppSave } from '../../db/repo'
import { usageSink } from '../../db/usage'
import {
  applyCardRegex,
  buildCharacterMessages,
  parseCharacterCardFromFile,
  resolveCardMacros,
  selectWorldEntriesDeep,
  type CharacterCardData,
  type ParsedCharacterCard,
  type WorldBookEntry,
} from '../../character/card'
import { useAutoScroll } from '../hooks'
import { useToast } from '../toast'
import { Icon } from '../icons'
import { Modal } from '../Modal'
import { Markdown } from '../agent/Markdown'

export interface CharacterCardTarget {
  source: 'attachment' | 'library'
  id: string
  name: string
  mime: string
}

interface CardChatMessage {
  role: 'user' | 'assistant'
  content: string
  at: number
  world?: string[]
}

const CHAT_NAMESPACE = 'character-chat'

async function loadCardForTarget(target: CharacterCardTarget): Promise<ParsedCharacterCard | null> {
  if (target.source === 'attachment') {
    const attachment = await getTaskAttachment(target.id)
    if (!attachment) throw new Error('附件不存在')
    const text = attachment.text ?? (await readAttachmentText(attachment)) ?? undefined
    return parseCharacterCardFromFile(attachment.name, attachment.mime, text ?? undefined, attachment.blob)
  }
  const file = await getLibraryFile(target.id)
  if (!file) throw new Error('资料不存在')
  const text = file.text ?? (await file.blob?.text().catch(() => undefined))
  return parseCharacterCardFromFile(file.name, file.mime, text ?? undefined, file.blob)
}

interface CardChatSave {
  messages: CardChatMessage[]
  vars: Record<string, string>
  greeting: number
}

function sanitizeVars(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

function sanitizeSave(value: unknown): CardChatSave {
  const empty: CardChatSave = { messages: [], vars: {}, greeting: 0 }
  if (!value || typeof value !== 'object') return empty
  const raw = (value as { messages?: unknown }).messages
  if (!Array.isArray(raw)) return empty
  const messages = raw
    .map((m) => m as Partial<CardChatMessage>)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: String(m.content),
      at: typeof m.at === 'number' ? m.at : Date.now(),
      world: Array.isArray(m.world) ? m.world.filter((w): w is string => typeof w === 'string') : undefined,
    }))
  const greetingRaw = (value as { greeting?: unknown }).greeting
  return {
    messages,
    vars: sanitizeVars((value as { vars?: unknown }).vars),
    greeting: typeof greetingRaw === 'number' && greetingRaw >= 0 ? Math.floor(greetingRaw) : 0,
  }
}

/** 开场白候选：0 号为 first_mes，其余为 alternate_greetings。 */
export function greetingList(data: CharacterCardData): string[] {
  return [data.firstMes, ...data.alternateGreetings].filter((item) => Boolean(item && item.trim()))
}

function placementText(entry: WorldBookEntry): string {
  if (entry.position === 'after_char') return '设定后'
  if (entry.position === 'before_example') return '示例前'
  if (entry.position === 'after_example') return '示例后'
  if (entry.position === 'at_depth') return `深度 ${entry.depth ?? 4}（${entry.role}）`
  return '设定前'
}

function openingMessage(data: CharacterCardData, index: number, at = Date.now()): CardChatMessage | null {
  const list = greetingList(data)
  const raw = list[index] ?? list[0] ?? ''
  if (!raw) return null
  return { role: 'assistant', content: resolveCardMacros(raw, { charName: data.name }).text, at }
}

export function CharacterChatModal({
  open,
  onClose,
  taskId,
  target,
  settings,
}: {
  open: boolean
  onClose: () => void
  taskId: string
  target: CharacterCardTarget | null
  settings: ApiSettings
}) {
  const { toast } = useToast()
  const [card, setCard] = useState<ParsedCharacterCard | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [authorized, setAuthorized] = useState(false)
  const [messages, setMessages] = useState<CardChatMessage[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [streaming, setStreaming] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [vars, setVars] = useState<Record<string, string>>({})
  const [varsOpen, setVarsOpen] = useState(false)
  const [newVarKey, setNewVarKey] = useState('')
  const [newVarValue, setNewVarValue] = useState('')
  const [greetingIndex, setGreetingIndex] = useState(0)
  const [scriptNote, setScriptNote] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const scrollRef = useAutoScroll<HTMLDivElement>(running ? streaming : messages.length)

  const configured = Boolean(settings.baseUrl && settings.model)
  const storageKey = target ? `${target.source}:${target.id}` : ''

  useEffect(() => {
    if (!open || !target) return
    let cancelled = false
    setLoading(true)
    setError('')
    setAuthorized(false)
    setMessages([])
    setStreaming('')
    setInput('')
    setCard(null)
    setVars({})
    setGreetingIndex(0)
    setScriptNote('')
    ;(async () => {
      const parsed = await loadCardForTarget(target)
      if (cancelled) return
      if (!parsed) throw new Error('没有识别到角色卡。支持 JSON 角色卡与常见 PNG 角色卡元数据。')
      setCard(parsed)
      const saved = sanitizeSave(await getAppSave(taskId, CHAT_NAMESPACE, storageKey))
      let list = saved.messages
      let index = saved.greeting
      let nextVars = saved.vars
      if (!list.length) {
        const opening = openingMessage(parsed.data, index)
        list = opening ? [opening] : []
        nextVars = {}
        await setAppSave(taskId, CHAT_NAMESPACE, storageKey, { messages: list, vars: nextVars, greeting: index })
      }
      if (cancelled) return
      setMessages(list)
      setVars(nextVars)
      setGreetingIndex(index)
    })()
      .catch((e) => {
        if (!cancelled) setError(String((e as Error)?.message || e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      controllerRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId, target?.source, target?.id])

  useEffect(() => {
    if (!card?.avatarBlob) {
      setAvatarUrl('')
      return
    }
    const url = URL.createObjectURL(card.avatarBlob)
    setAvatarUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [card])

  const persist = async (
    list: CardChatMessage[],
    nextVars: Record<string, string> = vars,
    nextGreeting: number = greetingIndex,
  ) => {
    try {
      await setAppSave(taskId, CHAT_NAMESPACE, storageKey, { messages: list, vars: nextVars, greeting: nextGreeting })
    } catch {
      /* 存档失败不阻断对话 */
    }
  }

  const commitVars = (nextVars: Record<string, string>) => {
    setVars(nextVars)
    void persist(messages, nextVars)
  }

  const setVarValue = (key: string, value: string) => commitVars({ ...vars, [key]: value })

  const removeVar = (key: string) => {
    const nextVars = { ...vars }
    delete nextVars[key]
    commitVars(nextVars)
  }

  const addVar = () => {
    const key = newVarKey.trim()
    if (!key) return
    commitVars({ ...vars, [key]: newVarValue })
    setNewVarKey('')
    setNewVarValue('')
  }

  const worldLabel = (world: { entries: { name: string }[]; depth: number }) => {
    const names = world.entries.map((entry) => entry.name)
    if (!names.length) return undefined
    return world.depth > 0 ? [`递归 ${world.depth} 轮`, ...names] : names
  }

  const send = async () => {
    const text = input.trim()
    if (!text || running || !card) return
    if (!configured) {
      setError('还没有配置模型端点。请先在设置中填写 Base URL 与模型。')
      return
    }
    setError('')
    setScriptNote('')
    const userInput = applyCardRegex(card.data.regexScripts, text, 'user')
    if (userInput.errors.length) setScriptNote(userInput.errors.slice(0, 3).join('；'))
    const userMessage: CardChatMessage = { role: 'user', content: userInput.text, at: Date.now() }
    const next = [...messages, userMessage]
    setMessages(next)
    setInput('')
    await persist(next)

    const world = selectWorldEntriesDeep(card.data, userInput.text)
    const macroVars = { ...vars }
    const built = buildCharacterMessages(
      card.data,
      world.entries,
      next.slice(-16).map((m) => ({ role: m.role, content: m.content })),
      { vars: macroVars },
    )
    const history: ChatMessage[] = built.messages.map((m) => ({ role: m.role, content: m.content }))

    const controller = new AbortController()
    controllerRef.current = controller
    setRunning(true)
    setStreaming('')
    let streamed = ''
    try {
      const result = await streamChat(history, configFromSettings(settings), {
        signal: controller.signal,
        timeoutMs: 180_000,
        maxRetries: 1,
        temperature: settings.temperature,
        onUsage: usageSink({ source: 'character', model: settings.model, baseUrl: settings.baseUrl, taskId }),
        onText: (chunk) => {
          streamed += chunk
          setStreaming(streamed)
        },
      })
      const content = (result.text || streamed).trim()
      if (content) {
        const cleaned = applyCardRegex(card.data.regexScripts, content, 'ai')
        if (cleaned.errors.length) setScriptNote(cleaned.errors.slice(0, 3).join('；'))
        // 模型可以在回复里写 {{setvar::hp::2}} 等宏，这里求值并更新变量面板。
        const resolved = resolveCardMacros(cleaned.text, { charName: card.data.name, vars: macroVars })
        const assistant: CardChatMessage = {
          role: 'assistant',
          content: resolved.text,
          at: Date.now(),
          world: worldLabel(world),
        }
        const withReply = [...next, assistant]
        setMessages(withReply)
        setVars(macroVars)
        await persist(withReply, macroVars)
      } else {
        setError('模型没有返回内容。请重试或检查端点。')
      }
    } catch (e) {
      if (controller.signal.aborted) {
        if (streamed.trim()) {
          const cleaned = applyCardRegex(card.data.regexScripts, streamed.trim(), 'ai')
          const resolved = resolveCardMacros(cleaned.text, { charName: card.data.name, vars: macroVars })
          const assistant: CardChatMessage = {
            role: 'assistant',
            content: resolved.text,
            at: Date.now(),
            world: worldLabel(world),
          }
          const partial = [...next, assistant]
          setMessages(partial)
          setVars(macroVars)
          await persist(partial, macroVars)
        }
        setError('已停止生成。')
      } else {
        const err = e as LLMError
        setError(
          err?.code === 'auth'
            ? `模型端点拒绝请求（可能是额度或 Key 问题）：${err.message}`
            : `对话请求失败：${String((e as Error)?.message || e)}`,
        )
      }
    } finally {
      controllerRef.current = null
      setRunning(false)
      setStreaming('')
    }
  }

  const stop = () => {
    controllerRef.current?.abort()
  }

  const switchGreeting = async (index: number) => {
    if (!card) return
    controllerRef.current?.abort()
    setRunning(false)
    setStreaming('')
    setGreetingIndex(index)
    setVars({})
    const opening = openingMessage(card.data, index)
    const list = opening ? [opening] : []
    setMessages(list)
    await persist(list, {}, index)
  }

  const clearChat = async () => {
    if (!card) return
    controllerRef.current?.abort()
    setStreaming('')
    setRunning(false)
    await removeAppSave(taskId, CHAT_NAMESPACE, storageKey).catch(() => undefined)
    const opening = openingMessage(card.data, greetingIndex)
    const first = opening ? [opening] : []
    setMessages(first)
    setVars({})
    await persist(first, {})
    toast('对话已清空', 'info')
  }

  const title = card?.data.name || target?.name || '角色对话'

  return (
    <Modal
      open={open}
      title={title}
      subtitle={
        card
          ? `${card.summary.spec} · ${card.format.toUpperCase()} · ${card.data.worldEntries.length} 条世界书 · ${
              greetingList(card.data).length
            } 条开场白${card.data.regexScripts.length ? ` · ${card.data.regexScripts.length} 条正则` : ''}`
          : target?.name || ''
      }
      onClose={() => {
        controllerRef.current?.abort()
        onClose()
      }}
      wide
      footer={
        authorized ? (
          <div className="card-composer">
            <textarea
              className="textarea"
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={running ? '正在生成…' : '以你的身份回复角色…'}
              disabled={running}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <div className="card-composer-actions">
              <button className="btn btn-ghost btn-small" onClick={() => void clearChat()} disabled={running}>
                清空对话
              </button>
              {running ? (
                <button className="btn btn-stop btn-small" onClick={stop}>
                  <Icon name="stop" size={13} /> 停止
                </button>
              ) : (
                <button className="btn btn-primary btn-small" onClick={() => void send()} disabled={!input.trim()}>
                  <Icon name="send" size={13} /> 发送
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        )
      }
    >
      <div className="card-chat">
        {loading ? (
          <div className="doc-notice">
            <span className="spinner" />
            <p>正在读取角色卡…</p>
          </div>
        ) : error && !card ? (
          <div className="doc-notice error">
            <Icon name="warning" size={22} />
            <p>{error}</p>
          </div>
        ) : card ? (
          <>
            <div className="card-summary">
              {avatarUrl ? <img className="card-avatar" src={avatarUrl} alt={card.data.name} /> : <div className="card-avatar card-avatar-fallback">{card.data.name.slice(0, 1)}</div>}
              <div className="card-summary-text">
                <strong>{card.data.name}</strong>
                <span>
                  {card.data.creator ? `作者 ${card.data.creator} · ` : ''}
                  {card.data.version ? `版本 ${card.data.version} · ` : ''}
                  {card.data.tags.slice(0, 4).join('、')}
                </span>
              </div>
            </div>

            {!authorized ? (
              <div className="card-gate">
                <div className="card-gate-mark">
                  <Icon name="agent" size={22} />
                </div>
                <h3>使用共享模型配置开始对话？</h3>
                <p>
                  端点：<code>{settings.baseUrl || '未配置'}</code>
                  <br />
                  模型：<code>{settings.model || '未配置'}</code>
                </p>
                <p>角色卡内容与对话会发送到这个端点。API Key 只由工作台使用，不会暴露给页面或导出文件。</p>
                <p className="muted">这是一次显式授权；关闭后再次打开会重新询问。</p>
                {!configured ? <div className="settings-note">请先在设置里配置 Base URL 与模型。</div> : null}
                <button
                  className="btn btn-primary"
                  disabled={!configured}
                  onClick={() => setAuthorized(true)}
                >
                  <Icon name="check" size={14} /> 授权并开始
                </button>
              </div>
            ) : (
              <>
                {error ? (
                  <div className="banner banner-error card-error">
                    <Icon name="warning" size={15} />
                    <span>{error}</span>
                    <button className="btn btn-small btn-ghost" onClick={() => setError('')}>
                      关闭
                    </button>
                  </div>
                ) : null}
                {scriptNote ? (
                  <div className="banner banner-warn card-error">
                    <Icon name="warning" size={15} />
                    <span>正则脚本：{scriptNote}</span>
                    <button className="btn btn-small btn-ghost" onClick={() => setScriptNote('')}>
                      关闭
                    </button>
                  </div>
                ) : null}
                {!messages.some((m) => m.role === 'user') && greetingList(card.data).length > 1 ? (
                  <div className="card-greeting-bar">
                    <span>开场白</span>
                    <select
                      value={greetingIndex}
                      onChange={(e) => void switchGreeting(Number(e.target.value))}
                      disabled={running}
                    >
                      {greetingList(card.data).map((_, index) => (
                        <option value={index} key={index}>
                          {index === 0 ? '默认开场白' : `备用开场白 ${index}`}
                        </option>
                      ))}
                    </select>
                    <span className="muted">切换会重置当前对话</span>
                  </div>
                ) : null}
                <div className="card-chat-scroll" ref={scrollRef}>
                  {messages.map((message, index) => (
                    <div className={`card-msg ${message.role}`} key={`${message.at}-${index}`}>
                      <div className="card-msg-role">{message.role === 'user' ? '你' : card.data.name}</div>
                      <div className="card-msg-body">
                        {message.role === 'assistant' ? (
                          <Markdown content={message.content} />
                        ) : (
                          <p>{message.content}</p>
                        )}
                      </div>
                      {message.world?.length ? (
                        <div className="card-msg-world">世界书：{message.world.join('、')}</div>
                      ) : null}
                    </div>
                  ))}
                  {running ? (
                    <div className="card-msg assistant">
                      <div className="card-msg-role">{card.data.name}</div>
                      <div className="card-msg-body">
                        {streaming ? <Markdown content={streaming} /> : <span className="spinner" />}
                      </div>
                    </div>
                  ) : null}
                </div>

                <details
                  className="card-vars"
                  open={varsOpen}
                  onToggle={(e) => setVarsOpen((e.target as HTMLDetailsElement).open)}
                >
                  <summary>
                    变量面板（{Object.keys(vars).length}）
                    <span className="muted">可选组件 · 修改后下一轮生效</span>
                  </summary>
                  <div className="card-vars-body">
                    {Object.keys(vars).length ? (
                      <div className="card-vars-list">
                        {Object.entries(vars).map(([key, value]) => (
                          <div className="card-var-row" key={key}>
                            <code>{key}</code>
                            <input
                              className="input"
                              value={value}
                              onChange={(e) => setVarValue(key, e.target.value)}
                              spellCheck={false}
                            />
                            <button
                              className="btn btn-small btn-ghost"
                              onClick={() => removeVar(key)}
                              title={`删除 ${key}`}
                            >
                              删除
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="muted">还没有变量。可以在下面新增，或让角色在回复里用 {'{{setvar::名字::值}}'} 设置。</p>
                    )}
                    <div className="card-var-add">
                      <input
                        className="input"
                        placeholder="变量名"
                        value={newVarKey}
                        onChange={(e) => setNewVarKey(e.target.value)}
                        spellCheck={false}
                      />
                      <input
                        className="input"
                        placeholder="值"
                        value={newVarValue}
                        onChange={(e) => setNewVarValue(e.target.value)}
                        spellCheck={false}
                      />
                      <button className="btn btn-small" onClick={addVar} disabled={!newVarKey.trim()}>
                        添加
                      </button>
                      <button
                        className="btn btn-small btn-ghost"
                        onClick={() => commitVars({})}
                        disabled={!Object.keys(vars).length}
                      >
                        全部清空
                      </button>
                    </div>
                    <p className="muted card-vars-hint">
                      变量会随对话存档保存，并以 {'{{getvar::名字}}'} 的形式提供给模型。这是可选组件：不需要数值的卡可以一直收起。
                    </p>
                  </div>
                </details>

                <details className="card-details">
                  <summary>角色信息、世界书与未启用字段</summary>
                  {card.data.description ? (
                    <div className="card-detail-block">
                      <strong>设定</strong>
                      <p>{resolveCardMacros(card.data.description, { charName: card.data.name, vars }).text}</p>
                    </div>
                  ) : null}
                  {card.data.scenario ? (
                    <div className="card-detail-block">
                      <strong>场景</strong>
                      <p>{resolveCardMacros(card.data.scenario, { charName: card.data.name, vars }).text}</p>
                    </div>
                  ) : null}
                  {card.data.regexScripts.length ? (
                    <div className="card-detail-block">
                      <strong>正则脚本（{card.data.regexScripts.length}）</strong>
                      <p>
                        {card.data.regexScripts
                          .map(
                            (script) =>
                              `${script.name}${script.disabled ? '（已禁用）' : ''} → ${
                                script.placement.length
                                  ? script.placement.map((p) => (p === 1 ? '输入' : p === 2 ? '输出' : `位置${p}`)).join('/')
                                  : '输入/输出'
                              }`,
                          )
                          .join('；')}
                      </p>
                    </div>
                  ) : null}
                  {card.data.worldEntries.length ? (
                    <div className="card-detail-block">
                      <strong>世界书（{card.data.worldEntries.length}，关键词 + 递归最多 2 轮）</strong>
                      <p>
                        {card.data.worldEntries
                          .slice(0, 8)
                          .map(
                            (w) =>
                              `${w.name}${w.keys.length ? `（${w.keys.slice(0, 4).join('、')}）` : ''} · ${placementText(w)}`,
                          )
                          .join('；')}
                      </p>
                    </div>
                  ) : null}
                  {card.data.unsupported.length ? (
                    <div className="card-detail-block warn">
                      <strong>未启用字段（原始数据已保留）</strong>
                      <ul>
                        {card.data.unsupported.map((item, i) => (
                          <li key={i}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="card-detail-block muted">没有检测到未启用字段。</p>
                  )}
                </details>
              </>
            )}
          </>
        ) : null}
      </div>
    </Modal>
  )
}
