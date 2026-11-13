import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

type ToastKind = 'info' | 'success' | 'error' | 'warning'

interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

interface ToastApi {
  toast: (message: string, kind?: ToastKind) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++seq.current
    setItems((list) => [...list.slice(-4), { id, message, kind }])
    window.setTimeout(() => {
      setItems((list) => list.filter((t) => t.id !== id))
    }, 4200)
  }, [])

  const api = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast must be used inside ToastProvider')
  return api
}
