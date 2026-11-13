import { parseCharacterCardFromFile, type ParsedCharacterCard } from '../character/card'
import { hashString } from '../lib/hash'
import { characterPageWarnings, generateCharacterHtml } from '../character/page'
import playerSource from '../character/player.js?raw'
import { validateCharacterSource } from './cardCodec'

export type ArtifactFormat = 'txt' | 'md' | 'json' | 'html' | 'png' | 'image' | 'unsupported'
export interface ArtifactInput { name: string; mime?: string; text?: string; blob?: Blob }
export interface ArtifactDetection {
  format: ArtifactFormat; kind: 'document' | 'webpage' | 'character' | 'image' | 'unknown'
  status: 'readable' | 'runnable' | 'assemblable' | 'unsupported' | 'needs-adaptation'
  metadata: { name: string; mime: string; bytes: number; declaredSpec?: string; inferred?: boolean }
  warnings: string[]; character?: ParsedCharacterCard
}
export interface ComponentRef { id: string; version: string }
export interface ComponentDefinition extends ComponentRef {
  dependencies: ComponentRef[]; conflicts: string[]; capabilities: string[]; unsupported: string[]
}
export const componentRegistry: Readonly<Record<string, ComponentDefinition>> = Object.freeze({
  'character-base': Object.freeze({ id: 'character-base', version: '1.0.0', dependencies: [{ id: 'workbench-runtime', version: '1.0.0' }], conflicts: [], capabilities: ['complete-card-source', 'single-chat', 'field-editor', 'json-export', 'worldbook-positions', 'stream-cancel-timeout'], unsupported: ['regex-execution', 'custom-ui', 'group-chat', 'worldbook-recursion-probability-timing', 'advanced-macros'] }),
  'workbench-runtime': Object.freeze({ id: 'workbench-runtime', version: '1.0.0', dependencies: [], conflicts: [], capabilities: ['ai.chat', 'ai.getProfiles', 'storage'], unsupported: [] }),
})
export function checkComponents(requested: ComponentRef[]): ComponentDefinition[] {
  const selected = new Map<string, ComponentDefinition>()
  const visit = (ref: ComponentRef, stack: string[]) => {
    const component = componentRegistry[ref.id]
    if (!component || component.version !== ref.version) throw new Error(`缺少组件或版本不匹配：${ref.id}@${ref.version}`)
    if (stack.includes(ref.id)) throw new Error(`组件依赖循环：${ref.id}`)
    if (selected.has(ref.id)) return
    for (const dep of component.dependencies) visit(dep, [...stack, ref.id])
    selected.set(ref.id, component)
  }
  for (const ref of requested) visit(ref, [])
  for (const component of selected.values()) for (const id of component.conflicts) if (selected.has(id)) throw new Error(`组件冲突：${component.id} / ${id}`)
  return [...selected.values()]
}

export async function detectArtifact(input: ArtifactInput): Promise<ArtifactDetection> {
  const name = input.name.toLowerCase(), mime = (input.mime || input.blob?.type || '').toLowerCase()
  const metadata = { name: input.name, mime, bytes: input.blob?.size ?? new TextEncoder().encode(input.text || '').length }
  const character = await parseCharacterCardFromFile(input.name, mime, input.text, input.blob)
  if (character) {
    try { validateCharacterSource(character.data.raw) }
    catch (error) { return { format: character.format, kind: 'character', status: 'needs-adaptation', metadata: { ...metadata, declaredSpec: character.data.spec, inferred: character.data.spec === '未声明版本' }, warnings: [...characterPageWarnings(character.data), String((error as Error).message)], character } }
    return { format: character.format, kind: 'character', status: 'assemblable', metadata: { ...metadata, declaredSpec: character.data.spec, inferred: character.data.spec === '未声明版本' }, warnings: characterPageWarnings(character.data), character }
  }
  const text = input.text?.trimStart()
  let format: ArtifactFormat = 'unsupported'
  const warnings: string[] = []
  if (/\.png$/.test(name) || mime === 'image/png') format = 'png'
  else if (mime.startsWith('image/') || /\.(jpg|jpeg|gif|webp|svg)$/.test(name)) format = 'image'
  else if (text !== undefined) {
    if (/^(<!doctype\s+html|<html(?:\s|>))/i.test(text) || /\.html?$/.test(name) || mime.includes('html')) format = 'html'
    else if (/\.json$/.test(name) || mime.includes('json') || /^[\[{]/.test(text)) {
      try { JSON.parse(text); format = 'json' } catch { if (/\.json$/.test(name) || mime.includes('json')) warnings.push('JSON 语法无效；只能按文本读取，不能按结构装配。'); format = 'txt' }
    } else if (/\.(md|markdown)$/.test(name) || mime.includes('markdown')) format = 'md'
    else if (/\.txt$/.test(name) || mime.startsWith('text/')) format = 'txt'
  }
  const image = format === 'png' || format === 'image'
  return { format, kind: format === 'html' ? 'webpage' : image ? 'image' : format === 'unsupported' ? 'unknown' : 'document', status: format === 'html' ? 'runnable' : format === 'unsupported' ? 'unsupported' : 'readable', metadata, warnings: [...warnings, ...(format === 'unsupported' ? ['此格式不提取正文或 OCR，不会自动执行或外发。'] : [])] }
}

export interface CharacterArtifactManifest {
  format: 'rpagent-artifact'; version: 1; artifactId: string; kind: 'character'; revision: string
  source: { path: string; format: 'json' | 'png'; schema: string; hash: string }
  generated: { path: string; hash: string }; components: ComponentRef[]
  componentFiles: { id: string; hash: string }[]; capabilities: string[]; unsupported: string[]
  config: { version: 1; saveKey: string }; bridge: { protocol: 'Workbench'; version: 1; methods: string[] }
  save: { version: 1; artifactId: string; key: string; categories: string[] }; warnings: string[]
}
export interface AssembledCharacterArtifact { path: string; sourcePath: string; manifestPath: string; sourceText: string; manifestText: string; html: string; manifest: CharacterArtifactManifest; warnings: string[] }
export interface AssembleCharacterOptions { artifactId: string; saveKey?: string; sourceFormat?: 'json' | 'png'; components?: ComponentRef[] }
export function assembleCharacterArtifact(raw: unknown, options: AssembleCharacterOptions): AssembledCharacterArtifact {
  if (!/^[\w-]+$/.test(options.artifactId)) throw new Error('artifactId 必须是安全的稳定标识')
  const card = validateCharacterSource(raw)
  const components = checkComponents(options.components || [{ id: 'character-base', version: '1.0.0' }])
  if (!components.some(c => c.id === 'character-base')) throw new Error('角色装配必须选择 character-base')
  const dir = `/characters/${options.artifactId}`, path = `${dir}/index.html`, sourcePath = `${dir}/source.json`, manifestPath = `${dir}/manifest.json`
  const sourceText = JSON.stringify(raw, null, 2) + '\n'
  const revision = hashString(sourceText), saveKey = options.saveKey || `character:${options.artifactId}`
  const warnings = characterPageWarnings(card)
  const html = generateCharacterHtml(card, saveKey, { artifactId: options.artifactId, revision, sourcePath, manifestPath })
  const manifest: CharacterArtifactManifest = {
    format: 'rpagent-artifact', version: 1, artifactId: options.artifactId, kind: 'character', revision,
    source: { path: sourcePath, format: options.sourceFormat || 'json', schema: card.spec, hash: revision },
    generated: { path, hash: hashString(html) }, components: components.map(({ id, version }) => ({ id, version })),
    componentFiles: [{ id: 'character-base/player.js', hash: hashString(playerSource) }], capabilities: [...new Set(components.flatMap(c => c.capabilities))], unsupported: [...new Set(components.flatMap(c => c.unsupported))],
    config: { version: 1, saveKey }, bridge: { protocol: 'Workbench', version: 1, methods: ['ai.chat', 'ai.getProfiles', 'storage.get', 'storage.set'] },
    save: { version: 1, artifactId: options.artifactId, key: saveKey, categories: ['chat', 'opening', 'preset'] }, warnings,
  }
  return { path, sourcePath, manifestPath, sourceText, manifestText: JSON.stringify(manifest, null, 2) + '\n', html, manifest, warnings }
}
