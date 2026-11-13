import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github.css'

marked.setOptions({ gfm: true, breaks: true })

export function Markdown({ content }: { content: string }) {
  const html = useMemo(() => {
    try {
      const raw = marked.parse(content || '', { async: false }) as string
      return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] })
    } catch {
      return DOMPurify.sanitize((content || '').replace(/</g, '&lt;'))
    }
  }, [content])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll('pre code').forEach((el) => {
      try {
        hljs.highlightElement(el as HTMLElement)
      } catch {
        /* ignore */
      }
    })
    root.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noreferrer noopener')
    })
  }, [html])
  return <div className="markdown" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
}
