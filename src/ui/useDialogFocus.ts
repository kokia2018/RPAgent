import { useLayoutEffect, useRef } from 'react'

const stack: HTMLElement[] = []

export function useDialogFocus<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null)
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const element = ref.current
    if (!open || !element) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    stack.push(element)
    element.focus()
    const onKey = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== element) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close.current()
      }
      if (event.key !== 'Tab') return
      const targets = Array.from(element.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex="0"]'))
        .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
      const first = targets[0]
      const last = targets[targets.length - 1]
      if (!first) { event.preventDefault(); element.focus(); return }
      if (!element.contains(document.activeElement) || document.activeElement === element) {
        event.preventDefault(); (event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      const index = stack.indexOf(element)
      if (index >= 0) stack.splice(index, 1)
      if (previous?.isConnected) previous.focus()
    }
  }, [open])
  return ref
}
