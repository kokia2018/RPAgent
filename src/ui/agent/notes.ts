export interface RunNote {
  kind: 'warning' | 'error'
  message: string
}

export interface NoteGroup extends RunNote {
  count: number
}

/** 自动刷新试玩产生的那类提示，只有 build 号不同。 */
const PREVIEW_UPDATE = /^试玩已更新到 build (\d+)。$/

/**
 * 把冗余的运行提示并成一条。
 * 一次运行里"试玩已更新到 build N"会出现十几次（每批改动一次），
 * 这里合并成"已自动更新 N 次（最新 build …）"，其余相邻同文提示折叠计数。
 */
export function groupRunNotes(notes: readonly RunNote[]): NoteGroup[] {
  const out: NoteGroup[] = []
  let previewIndex = -1
  let previewCount = 0

  for (const note of notes) {
    const match = PREVIEW_UPDATE.exec(note.message)
    if (match) {
      previewCount++
      const message =
        previewCount === 1
          ? `试玩已更新到 build ${match[1]}。`
          : `试玩已自动更新 ${previewCount} 次（最新 build ${match[1]}）。`
      if (previewIndex < 0) {
        previewIndex = out.length
        out.push({ kind: note.kind, message, count: 1 })
      } else {
        out[previewIndex] = { ...out[previewIndex], message }
      }
      continue
    }

    const last = out[out.length - 1]
    if (last && last.kind === note.kind && last.message === note.message) {
      last.count++
      continue
    }
    out.push({ kind: note.kind, message: note.message, count: 1 })
  }
  return out
}

/** 折叠标题上显示的那一句：优先显示最近的错误，否则显示最近一条。 */
export function notePreview(notes: readonly RunNote[]): RunNote | null {
  if (!notes.length) return null
  const lastError = [...notes].reverse().find((note) => note.kind === 'error')
  return lastError || notes[notes.length - 1]
}
