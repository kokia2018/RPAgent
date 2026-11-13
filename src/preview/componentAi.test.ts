import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { createTask, writeWorkspaceText } from '../db/repo'
import { DEFAULT_API_SETTINGS } from '../db/types'
import { assembleCharacterArtifact } from '../artifacts/registry'
import { hashString } from '../lib/hash'
import type { ProjectFile } from './compiler'
import { previewManager } from './manager'

const raw = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: { name: '测试角色', first_mes: '开场', description: '描述' },
}

const settings = {
  ...DEFAULT_API_SETTINGS,
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
}

/** previewManager 是单例：每个用例清掉上一轮的内存授权与归属。 */
function resetManager() {
  const manager = previewManager as any
  manager.aiAuthorized.clear()
  manager.autoAiGrants.clear()
  manager.trustedComponents.clear()
  manager.componentPaused.clear()
  manager.sessionOwners.clear()
  manager.taskApiSettings.clear()
  manager.apiSettings = null
}

async function trustedWorkspace() {
  const { id } = await createTask('组件自动接入')
  const built = assembleCharacterArtifact(raw, { artifactId: 'auto-test' })
  const entries: [string, string][] = [
    [built.path, built.html],
    [built.sourcePath, built.sourceText],
    [built.manifestPath, built.manifestText],
  ]
  for (const [path, text] of entries) await writeWorkspaceText(id, path, text, 'agent')
  const files: ProjectFile[] = entries.map(([path, text]) => ({
    path,
    text,
    size: text.length,
    mime: 'text/plain',
  }))
  return { id, built, files }
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
  resetManager()
})

describe('可信组件自动接入宿主 API', () => {
  it('受支持组件自动使用设置里的默认模型', async () => {
    const { id, built, files } = await trustedWorkspace()
    previewManager.setApiSettings(settings)
    const manager = previewManager as any
    manager.sessionOwners.set('pv_auto', id)

    manager.applyComponentAi('pv_auto', id, built.path, files)

    expect(previewManager.getTrustedComponent('pv_auto')?.name).toBe('测试角色')
    expect(previewManager.isAiAuthorized('pv_auto')).toBe(true)
    expect(previewManager.isAutoAiAuthorized('pv_auto')).toBe(true)
  })

  it('普通 HTML 不会被自动授权', async () => {
    const { id } = await createTask('普通页面')
    const html = '<h1>hi</h1>'
    await writeWorkspaceText(id, '/index.html', html)
    const files: ProjectFile[] = [{ path: '/index.html', text: html, size: html.length, mime: 'text/html' }]
    previewManager.setApiSettings(settings)
    const manager = previewManager as any
    manager.sessionOwners.set('pv_plain', id)

    manager.applyComponentAi('pv_plain', id, '/index.html', files)

    expect(previewManager.getTrustedComponent('pv_plain')).toBeNull()
    expect(previewManager.isAiAuthorized('pv_plain')).toBe(false)
  })

  it('用户撤销后刷新不再自动接入，手动授权可解除暂停', async () => {
    const { id, built, files } = await trustedWorkspace()
    previewManager.setApiSettings(settings)
    const manager = previewManager as any
    manager.sessionOwners.set('pv_revoke', id)
    manager.applyComponentAi('pv_revoke', id, built.path, files)

    previewManager.setAiAuthorized('pv_revoke', false, 'default')
    expect(previewManager.isComponentAiPaused(id, built.path)).toBe(true)

    manager.applyComponentAi('pv_revoke', id, built.path, files)
    expect(previewManager.isAiAuthorized('pv_revoke')).toBe(false)

    previewManager.setAiAuthorized('pv_revoke', true, 'default')
    expect(previewManager.isComponentAiPaused(id, built.path)).toBe(false)
    expect(previewManager.isAiAuthorized('pv_revoke')).toBe(true)
    expect(previewManager.isAutoAiAuthorized('pv_revoke')).toBe(false)
  })

  it('HTML 被改过后不再视为可信组件，并撤销自动授权', async () => {
    const { id, built, files } = await trustedWorkspace()
    previewManager.setApiSettings(settings)
    const manager = previewManager as any
    manager.sessionOwners.set('pv_tamper', id)
    manager.applyComponentAi('pv_tamper', id, built.path, files)
    expect(previewManager.isAiAuthorized('pv_tamper')).toBe(true)

    const tampered = files.map((file) =>
      file.path === built.path ? { ...file, text: `${file.text}\n<!-- edited -->` } : file,
    )
    manager.applyComponentAi('pv_tamper', id, built.path, tampered)

    expect(previewManager.getTrustedComponent('pv_tamper')).toBeNull()
    expect(previewManager.isAiAuthorized('pv_tamper')).toBe(false)
  })

  it('配置好模型后，已识别的组件会自动补上授权', async () => {
    const { id, built, files } = await trustedWorkspace()
    const manager = previewManager as any
    manager.sessionOwners.set('pv_late', id)

    manager.applyComponentAi('pv_late', id, built.path, files)
    expect(previewManager.getTrustedComponent('pv_late')).not.toBeNull()
    expect(previewManager.isAiAuthorized('pv_late')).toBe(false)

    previewManager.setApiSettings(settings)
    expect(previewManager.isAiAuthorized('pv_late')).toBe(true)
    expect(previewManager.isAutoAiAuthorized('pv_late')).toBe(true)
  })

  it('旧版组件（500px 最小高度与旧提示文案）仍被识别，不会因文案升级失效', async () => {
    const { id, built, files } = await trustedWorkspace()
    const legacyHtml = built.html
      .replace('height:100dvh;min-height:0;', 'height:100dvh;min-height:500px;')
      .replace('已适配组件自动使用工作台设置', '工作台需授权 AI')
    const manifest = JSON.parse(built.manifestText)
    manifest.generated.hash = hashString(legacyHtml)
    const legacyManifest = JSON.stringify(manifest, null, 2) + '\n'
    const legacy = files.map((file) => {
      if (file.path === built.path) return { ...file, text: legacyHtml, size: legacyHtml.length }
      if (file.path === built.manifestPath) return { ...file, text: legacyManifest, size: legacyManifest.length }
      return file
    })
    await writeWorkspaceText(id, built.path, legacyHtml, 'agent')
    await writeWorkspaceText(id, built.manifestPath, legacyManifest, 'agent')

    previewManager.setApiSettings(settings)
    const manager = previewManager as any
    manager.sessionOwners.set('pv_legacy', id)

    manager.applyComponentAi('pv_legacy', id, built.path, legacy)

    expect(previewManager.getTrustedComponent('pv_legacy')?.name).toBe('测试角色')
    expect(previewManager.isAiAuthorized('pv_legacy')).toBe(true)
  })
})
