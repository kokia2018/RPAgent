import { useEffect, useRef, useState } from 'react'
import type { PreviewSessionRecord } from '../../db/types'
import { previewManager } from '../../preview/manager'
import { Icon } from '../icons'

export function PreviewFrame({ session, active }: { session: PreviewSessionRecord; active: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [info, setInfo] = useState<{
    mode: 'sw' | 'inline'
    src?: string
    srcDoc?: string
    allowSameOrigin: boolean
  } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const frame = iframeRef.current
    if (!frame) return
    previewManager.attachFrame(session.id, frame)
    return () => previewManager.detachFrame(session.id, frame)
  }, [session.id])

  useEffect(() => {
    let cancelled = false
    setError('')
    previewManager
      .getRenderInfo(session)
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch((e) => {
        if (!cancelled) setError(String((e as Error)?.message || e))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.mode, session.buildVersion, session.entryPath])

  return (
    <div className={`preview-frame-wrap ${active ? 'is-active' : ''}`}>
      {error ? (
        <div className="preview-error">
          <Icon name="warning" size={18} />
          <p>{error}</p>
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        className="preview-frame"
        title={session.name || '试玩'}
        sandbox={`allow-scripts allow-forms allow-modals allow-downloads${info?.allowSameOrigin ? ' allow-same-origin' : ''}`}
        referrerPolicy="no-referrer"
        src={info?.mode === 'sw' ? info.src : undefined}
        srcDoc={info?.mode === 'inline' ? info.srcDoc : undefined}
      />
      {!info && !error ? (
        <div className="preview-loading">
          <span className="spinner" />
          <span>正在准备预览通道…</span>
        </div>
      ) : session.status === 'opening' ? (
        <div className="preview-loading">
          <span className="spinner" />
          <span>正在启动试玩…</span>
        </div>
      ) : null}
    </div>
  )
}
