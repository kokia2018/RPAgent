import playerSource from './player.js?raw'
import { parseCharacterCardFromFile, type CharacterCardData } from './card'
import { getTaskAttachment } from '../db/assets'
import { appendMessage, getTask, getWorkspaceFile, updateTask, writeWorkspaceText } from '../db/repo'
import { db } from '../db/db'
import { hashString, randomId } from '../lib/hash'
import { queueWorkspaceRun } from '../lib/runLock'
import { assembleCharacterArtifact, checkComponents, type CharacterArtifactManifest } from '../artifacts/registry'

export function characterPageWarnings(card: CharacterCardData): string[] {
  const warnings = [...card.unsupported]
  if (card.spec === '未声明版本') warnings.unshift('原卡未声明规范版本，按兼容字段识别；不是完整兼容性保证。')
  if (card.worldEntries.length) warnings.push(`已保留 ${card.worldEntries.length} 条世界书；支持常驻/关键词与设定前后、示例前后、at_depth + role；每轮最多 12 条、12000 字符，超预算整条跳过并说明。不启用递归、概率、sticky/cooldown/delay。`)
  const root = card.raw as Record<string, unknown>
  const data = root?.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root
  const book = (data?.character_book ?? data?.characterBook) as Record<string, unknown> | undefined
  if (book && Array.isArray(book.entries)) for (const [i, raw] of book.entries.entries()) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const ext = entry.extensions && typeof entry.extensions === 'object' ? entry.extensions as Record<string, unknown> : {}
    const missing = ['case_sensitive', 'selective', 'secondary_keys', 'useProbability', 'use_probability', 'probability', 'sticky', 'cooldown', 'delay', 'scan_depth', 'match_whole_words'].filter(key => entry[key] != null && entry[key] !== false || ext[key] != null && ext[key] !== false)
    if (missing.length) warnings.push(`character_book.entries[${i}] 未启用策略：${missing.join('、')}；相关字段原样保留。`)
    const position = entry.position ?? ext.position
    if (position != null && ![0, 1, 2, 3, 4, 'before_char', 'before_character', 'after_char', 'after_character', 'before_example', 'before_an', 'after_example', 'after_an', 'at_depth', 'depth'].includes(position as string | number)) warnings.push(`character_book.entries[${i}].position=${String(position)} 不支持，基础预览按设定前显示；请先适配以还原语义。`)
  }
  warnings.push('基础宏仅 {{char}} / {{user}} / {{original}}（提示词替换）。正则、自定义 UI、群聊、其他宏不执行。')
  warnings.push('角色字段不截断；单轮桥接预算 40 条/60000 字符，超限拒绝发送。近期上下文最多 24 条/32000 字符，完整本地历史最多 2000 条/240KB，达到上限明确拒绝并要求导出存档/开始新故事，不默默删除。')
  warnings.push('标准示例按 <START> 与角色前缀拆成示例消息，无法拆分时原文置于示例区。不执行卡内 HTML 或脚本。')
  return [...new Set(warnings)]
}
export interface CharacterPageIdentity { artifactId: string; revision: string; sourcePath: string; manifestPath: string }
export function generateCharacterHtml(card: CharacterCardData, saveKey: string, identity?: CharacterPageIdentity): string {
  const data = { ...card, saveKey, identity, greetings: [card.firstMes, ...card.alternateGreetings].filter(Boolean), warnings: characterPageWarnings(card) }
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>角色试玩</title>
<style>
:root{color-scheme:light;font-family:system-ui,"Microsoft YaHei",sans-serif;color:#303344;background:#f7f7fb}*{box-sizing:border-box}body{margin:0}main{max-width:900px;margin:auto;height:100dvh;min-height:0;display:flex;flex-direction:column;padding:16px;gap:12px}header{display:flex;justify-content:space-between;align-items:center;gap:12px}h1{font-size:22px;margin:0}header p{margin:5px 0;color:#6b6d7c;font-size:13px}button,textarea,select,input{font:inherit}button{cursor:pointer;min-height:40px;padding:8px 14px;border:1px solid #d4d5e4;border-radius:9px;background:#fff;color:#444477}button:disabled{opacity:.55;cursor:default}#messages{flex:1;min-height:100px;overflow:auto;overscroll-behavior:contain;padding:8px 0}.turn{background:white;border:1px solid #e3e3ec;border-radius:14px;padding:16px;margin:0 32px 14px 0;overflow-wrap:anywhere}.turn.user{margin:0 0 14px 32px;background:#ededfb}.turn strong{font-size:12px;color:#5f6095}.turn div{white-space:pre-wrap;line-height:1.7;margin-top:8px}textarea,input{width:100%;resize:vertical;border:1px solid #d2d3e2;border-radius:10px;padding:10px;background:#fff;color:inherit}textarea:focus,button:focus-visible,select:focus-visible{outline:2px solid #6968bd;outline-offset:2px}#send{background:#5958a5;color:white}form>div{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:8px;flex-wrap:wrap}details{border:1px solid #e0e0eb;border-radius:10px;padding:9px 12px;font-size:13px}summary{cursor:pointer}details[open]{max-height:40vh;overflow:auto}label{display:block;margin:12px 0 6px}select{max-width:100%;padding:7px}#card-details{white-space:pre-wrap;color:#6b6d7c;line-height:1.6}#notice,#world-status,#edit-status{font-size:12px;color:#696b7b;margin:0;overflow-wrap:anywhere}#notice{min-height:18px}footer{padding-bottom:env(safe-area-inset-bottom,8px)}[hidden]{display:none!important}@media(max-width:600px){main{padding:10px}h1{font-size:19px}.turn{padding:12px;margin-right:16px}.turn.user{margin-left:16px}header{align-items:flex-start}}
</style></head><body><main>
<header><div><h1 id="character-name">角色试玩</h1><p>内容在本地装配；发送对话时才使用所选模型。</p></div><button id="reset" type="button">新故事</button></header>
<details><summary>角色资料、预设与导出</summary><label for="greeting">开场白（新故事使用）</label><select id="greeting"></select><label for="preset">基础系统预设</label><textarea id="preset" rows="3"></textarea><label for="post-preset">基础后指令</label><textarea id="post-preset" rows="2"></textarea><p id="card-details"></p><details><summary>编辑完整卡的基础字段</summary><div id="card-fields"></div><button id="apply-card" type="button">保存为未提交草稿</button><button id="export-card" type="button">导出当前 JSON 卡</button><button id="export-v2" type="button">导出指定 V2 JSON</button><p id="edit-status" role="status"></p></details></details>
<section id="messages" aria-label="对话记录" aria-live="polite"></section>
<footer><p id="world-status"></p><p id="notice" role="status">输入后才会请求模型；已适配组件自动使用工作台设置，独立文件使用自己的 AI 设置。</p><form id="chat-form"><label for="chat-input">你的行动或对白</label><textarea id="chat-input" rows="2" placeholder="故事里，你想做什么？"></textarea><div><label for="profile">玩法模型</label><select id="profile"><option value="">作品默认模型</option></select><button id="stop" type="button" hidden>停止回复</button><button id="send" type="submit">发送</button></div></form></footer>
</main><script type="application/json" id="character-data">${json}</script><script>${playerSource.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
}
function sameJson(text: string, value: unknown): boolean {
  try { return JSON.stringify(JSON.parse(text)) === JSON.stringify(value) } catch { return false }
}

export interface CharacterPageResult { path: string; warnings: string[]; sourcePath?: string; manifestPath?: string; revision?: string }

export async function createCharacterPage(taskId: string, attachmentId: string, options: { locked?: boolean } = {}): Promise<CharacterPageResult> {
  const attachment = await getTaskAttachment(attachmentId)
  if (!attachment || attachment.taskId !== taskId || !(await getTask(taskId))) throw new Error('角色卡附件不存在或不属于当前任务')
  const parsed = await parseCharacterCardFromFile(attachment.name, attachment.mime, attachment.text, attachment.blob)
  if (!parsed) throw new Error('未读取到角色卡元数据。可保留附件并交给 Agent 适配，不会自动执行原文件。')
  const assembled = assembleCharacterArtifact(parsed.data.raw, { artifactId: randomId('character_'), sourceFormat: parsed.format })
  const commit = () => db.transaction('rw', db.workspaceFiles, db.tasks, async () => {
    if (!(await getTask(taskId))) throw new Error('目标空间已删除')
    await writeWorkspaceText(taskId, assembled.sourcePath, assembled.sourceText, 'user')
    await writeWorkspaceText(taskId, assembled.path, assembled.html, 'user')
    await writeWorkspaceText(taskId, assembled.manifestPath, assembled.manifestText, 'user')
    await updateTask(taskId, { entryPath: assembled.path })
  })
  // Agent 运行已持有本空间写锁；再次排队会等待自己而死锁。
  if (options.locked) await commit()
  else await queueWorkspaceRun(taskId, new AbortController().signal, commit)
  await appendMessage({ taskId, role: 'assistant', status: 'done', content: `已本地装配「${parsed.data.name}」：${assembled.path}。完整卡源：${assembled.sourcePath}；固定组件清单：${assembled.manifestPath}。未调用模型，原附件未改动。\n\n兼容范围：\n${assembled.warnings.map(s => '- ' + s).join('\n')}` })
  return { path: assembled.path, warnings: assembled.warnings, sourcePath: assembled.sourcePath, manifestPath: assembled.manifestPath, revision: assembled.manifest.revision }
}

/** Read only same-task managed files; hash drift is a custom fork, never silently overwritten. */
export async function updateCharacterArtifact(taskId: string, manifestPath: string, raw: unknown, options: { expectedRevision?: number | string; locked?: boolean } = {}): Promise<CharacterPageResult> {
  const record = await getWorkspaceFile(taskId, manifestPath)
  if (!record?.text || !(await getTask(taskId))) throw new Error('当前空间组件清单不存在')
  const manifest = JSON.parse(record.text) as CharacterArtifactManifest
  const dir = `/characters/${manifest.artifactId}`
  if (manifest.format !== 'rpagent-artifact' || manifest.version !== 1 || manifest.kind !== 'character' || !/^[\w-]+$/.test(manifest.artifactId) || manifestPath !== `${dir}/manifest.json` || manifest.source.path !== `${dir}/source.json` || manifest.generated.path !== `${dir}/index.html`) throw new Error('组件清单结构或归属路径无效')
  checkComponents(manifest.components)
  if (manifest.config?.version !== 1 || typeof manifest.config.saveKey !== 'string' || !manifest.config.saveKey || manifest.save?.version !== 1 || manifest.save.key !== manifest.config.saveKey || manifest.save.artifactId !== manifest.artifactId || manifest.source.hash !== manifest.revision || manifest.bridge?.protocol !== 'Workbench' || manifest.bridge.version !== 1) throw new Error('组件配置/存档 schema 或关联不兼容；缺少迁移支持，拒绝重组')
  if (!manifest.componentFiles?.some(file => file.id === 'character-base/player.js' && file.hash === hashString(playerSource))) throw new Error('组件运行文件版本已变化；缺少迁移支持，拒绝自动升级')
  if (options.expectedRevision && options.expectedRevision !== manifest.revision) throw new Error('内容 revision 已变化，请重新读取后提交')
  const assembled = assembleCharacterArtifact(raw, { artifactId: manifest.artifactId, saveKey: manifest.config.saveKey, sourceFormat: manifest.source.format, components: manifest.components })
  const commit = () => db.transaction('rw', db.workspaceFiles, db.tasks, async () => {
    if (!(await getTask(taskId))) throw new Error('目标空间已删除')
    const source = await getWorkspaceFile(taskId, manifest.source.path), generated = await getWorkspaceFile(taskId, manifest.generated.path), currentManifest = await getWorkspaceFile(taskId, manifestPath)
    if (currentManifest?.text !== record.text) throw new Error('组件清单已改变，请重试')
    // 内容源是可写真源：调用方提交的正是当前 source.json 时允许其漂移，按新内容重组；
    // 只有提交内容与磁盘源都不一致（并发改动）才拒绝。
    if (!source?.text) throw new Error('内容源不存在')
    if (hashString(source.text) !== manifest.source.hash && !sameJson(source.text, raw)) throw new Error('内容源已被其他操作修改；请重新读取 source.json 后提交')
    if (!generated?.text || hashString(generated.text) !== manifest.generated.hash) throw new Error('生成 HTML 已是自定义分叉；保留该分叉或另行生成，不自动覆盖')
    await writeWorkspaceText(taskId, assembled.sourcePath, assembled.sourceText, 'user')
    await writeWorkspaceText(taskId, assembled.path, assembled.html, 'user')
    await writeWorkspaceText(taskId, assembled.manifestPath, assembled.manifestText, 'user')
  })
  if (options.locked) await commit()
  else await queueWorkspaceRun(taskId, new AbortController().signal, commit)
  return { path: assembled.path, sourcePath: assembled.sourcePath, manifestPath: assembled.manifestPath, revision: assembled.manifest.revision, warnings: assembled.warnings }
}
