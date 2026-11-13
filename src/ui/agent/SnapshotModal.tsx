import { useState } from 'react'
import type { ProjectSnapshotRecord } from '../../db/types'
import { createSnapshot, diffSnapshot, listSnapshots, restoreSnapshot, type SnapshotDiff } from '../../db/repo'
import { useLiveQueryValue } from '../hooks'
import { useToast } from '../toast'
import { Icon } from '../icons'
import { Modal } from '../Modal'
import { previewManager } from '../../preview/manager'
import { formatTime } from '../../lib/text'
import { queueWorkspaceRun } from '../../lib/runLock'

export function SnapshotModal({ taskId, open, onClose }: { taskId: string; open: boolean; onClose: () => void }) {
  const { toast } = useToast()
  const snapshots = useLiveQueryValue(() => listSnapshots(taskId), [taskId], [])
  const [busy, setBusy] = useState('')
  const [diff, setDiff] = useState<{ id: string; value: SnapshotDiff } | null>(null)
  const [pendingRestore, setPendingRestore] = useState<ProjectSnapshotRecord | null>(null)
  const [lastResult, setLastResult] = useState('')

  const create = async () => {
    setBusy('create')
    try {
      const snap = await createSnapshot(taskId, '手动快照')
      toast(`已创建快照：${snap.files.length} 个文件`, 'success')
    } catch (e) {
      toast('创建快照失败：' + String((e as Error)?.message || e), 'error')
    } finally {
      setBusy('')
    }
  }

  const showDiff = async (id: string) => {
    setBusy(id)
    try {
      setDiff({ id, value: await diffSnapshot(id) })
    } catch (e) {
      toast('对比失败：' + String((e as Error)?.message || e), 'error')
    } finally {
      setBusy('')
    }
  }

  const confirmRestore = async () => {
    if (!pendingRestore) return
    setBusy(pendingRestore.id)
    try {
      const { safety, result } = await queueWorkspaceRun(taskId, new AbortController().signal, async () => {
        const safety = await createSnapshot(taskId, '恢复前自动快照')
        const restoring = new Set(pendingRestore.files.filter((f) => !f.binary && typeof f.text === 'string').map((f) => f.path))
        if (safety.files.some((f) => restoring.has(f.path) && typeof f.text !== 'string')) {
          throw new Error('将被覆盖的现有大文件没有完整文本备份，请先导出项目。未执行恢复。')
        }
        return { safety, result: await restoreSnapshot(pendingRestore.id) }
      })
      setPendingRestore(null)
      setLastResult(
        [
          `已恢复 ${result.restored} 个文本文件。`,
          result.skippedBinary.length ? `跳过 ${result.skippedBinary.length} 个二进制文件（快照不保存二进制内容）。` : '',
          result.missingText.length ? `跳过 ${result.missingText.length} 个没有完整正文的文件，当前内容未被清空。` : '',
          `恢复前已创建安全快照 ${safety.id.slice(-6)}。`,
          '恢复不会删除快照之后新增的文件。',
        ]
          .filter(Boolean)
          .join(' '),
      )
      toast('已从快照恢复文本文件', 'success')
      await previewManager.refreshActiveTask(taskId).catch((e) => toast(`文件已恢复，试玩未更新：${String(e)}`, 'warning'))
    } catch (e) {
      toast('恢复失败：' + String((e as Error)?.message || e), 'error')
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <Modal
        open={open}
        title="项目版本"
        subtitle="快照保存文本文件内容；恢复会用快照覆盖同名文件，不删除后来新增的文件。"
        onClose={onClose}
        wide
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose}>
              关闭
            </button>
            <button className="btn btn-primary" onClick={() => void create()} disabled={Boolean(busy)}>
              {busy === 'create' ? <span className="spinner" /> : <Icon name="plus" size={14} />}
              创建快照
            </button>
          </div>
        }
      >
        <p className="modal-note">
          普通里程碑由 Agent 决定或手动创建；批量覆盖、删除和恢复前有文本备份保护。二进制文件只记录路径与哈希。
        </p>
        {lastResult ? <div className="settings-note">{lastResult}</div> : null}
        <div className="snapshot-list">
          {snapshots.length ? (
            snapshots.map((snap) => (
              <div className="snapshot-item" key={snap.id}>
                <div className="snapshot-main">
                  <span className="snapshot-label">{snap.label}</span>
                  <span className="snapshot-meta">
                    {formatTime(snap.createdAt)} · {snap.files.length} 个文件
                    {snap.truncated ? ' · 部分大文件未保存正文' : ''}
                  </span>
                  {diff?.id === snap.id ? (
                    <div className="snapshot-diff">
                      <span>新增 {diff.value.added.length}</span>
                      <span>修改 {diff.value.changed.length}</span>
                      <span>删除 {diff.value.removed.length}</span>
                      <span>未变 {diff.value.unchanged}</span>
                      {diff.value.added.length ? <p>新增：{diff.value.added.slice(0, 8).join('、')}</p> : null}
                      {diff.value.changed.length ? <p>修改：{diff.value.changed.slice(0, 8).join('、')}</p> : null}
                      {diff.value.removed.length ? <p>删除：{diff.value.removed.slice(0, 8).join('、')}</p> : null}
                    </div>
                  ) : null}
                </div>
                <div className="snapshot-actions">
                  <button className="chip chip-small" onClick={() => void showDiff(snap.id)} disabled={Boolean(busy)}>
                    {busy === snap.id ? '对比中…' : '对比当前'}
                  </button>
                  <button className="chip chip-small" onClick={() => setPendingRestore(snap)} disabled={Boolean(busy)}>
                    恢复
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="empty-hint">还没有快照。运行 Agent 或手动创建后，可在这里对比与恢复。</p>
          )}
        </div>
      </Modal>

      <Modal
        open={Boolean(pendingRestore)}
        title="恢复到这个快照？"
        subtitle={pendingRestore ? `${pendingRestore.label} · ${formatTime(pendingRestore.createdAt)}` : ''}
        onClose={() => setPendingRestore(null)}
        footer={
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setPendingRestore(null)}>
              取消
            </button>
            <button className="btn btn-danger" onClick={() => void confirmRestore()} disabled={Boolean(busy)}>
              {busy ? <span className="spinner" /> : null}
              确认恢复
            </button>
          </div>
        }
      >
        <p className="delete-warning">
          快照中的文本文件会覆盖当前同名文件；二进制文件会跳过；快照之后新增的文件不会删除。恢复前会自动创建一份安全快照。
        </p>
      </Modal>
    </>
  )
}
