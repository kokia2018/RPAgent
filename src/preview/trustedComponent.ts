import { assembleCharacterArtifact, type CharacterArtifactManifest } from '../artifacts/registry'
import { hashString } from '../lib/hash'
import { dirname } from '../lib/path'
import type { ProjectFile } from './compiler'

export interface TrustedComponent { artifactId: string; name: string }

function normalizeKnownLayout(html: string): string {
  return html
    .replace('height:100dvh;min-height:500px;', 'height:100dvh;min-height:0;')
    .replace('输入后才会请求模型；工作台需授权 AI，独立文件使用自己的 AI 设置。', '输入后才会请求模型；已适配组件自动使用工作台设置，独立文件使用自己的 AI 设置。')
}

export function identifyTrustedComponent(entryPath: string, files: readonly ProjectFile[]): TrustedComponent | null {
  try {
    const dir = dirname(entryPath)
    const manifestFile = files.find(file => file.path === `${dir}/manifest.json`)
    const manifest = JSON.parse(manifestFile?.text || '') as CharacterArtifactManifest
    if (manifest.format !== 'rpagent-artifact' || manifest.version !== 1 || manifest.kind !== 'character' || dir !== `/characters/${manifest.artifactId}`) return null
    if (manifest.source.path !== `${dir}/source.json` || manifest.generated.path !== entryPath || entryPath !== `${dir}/index.html`) return null
    if (manifest.config.version !== 1 || manifest.bridge.protocol !== 'Workbench' || manifest.bridge.version !== 1 || !manifest.bridge.methods.includes('ai.chat')) return null
    if (manifest.save.artifactId !== manifest.artifactId || manifest.save.key !== manifest.config.saveKey || manifest.save.version !== 1) return null
    const source = files.find(file => file.path === manifest.source.path)?.text
    const html = files.find(file => file.path === entryPath)?.text
    if (!source || !html || hashString(source) !== manifest.source.hash || manifest.revision !== manifest.source.hash || hashString(html) !== manifest.generated.hash) return null
    const assembled = assembleCharacterArtifact(JSON.parse(source), { artifactId: manifest.artifactId, saveKey: manifest.config.saveKey, sourceFormat: manifest.source.format, components: manifest.components })
    if (JSON.stringify(manifest.components) !== JSON.stringify(assembled.manifest.components) || JSON.stringify(manifest.componentFiles) !== JSON.stringify(assembled.manifest.componentFiles)) return null
    // 清单可由任意 HTML 伪造；必须复算本地组件生成结果，不能只相信其自报 hash。
    if (normalizeKnownLayout(assembled.html) !== normalizeKnownLayout(html)) return null
    const raw = JSON.parse(source), data = raw.data || raw
    return { artifactId: manifest.artifactId, name: data.name || '角色组件' }
  } catch {
    return null
  }
}
