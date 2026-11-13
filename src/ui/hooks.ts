import { useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'

/** 简单的 Dexie liveQuery 订阅，避免额外依赖 dexie-react-hooks。 */
export function useLiveQueryValue<T>(factory: () => Promise<T>, deps: unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial)
  const factoryRef = useRef(factory)
  factoryRef.current = factory
  useEffect(() => {
    const subscription = liveQuery(() => factoryRef.current()).subscribe({
      next: (v) => setValue(v),
      error: (e) => console.error('liveQuery error', e),
    })
    return () => subscription.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return value
}

export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs, active])
  return now
}

export function useAutoScroll<T extends HTMLElement>(dep: unknown): React.RefObject<T | null> {
  const ref = useRef<T>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}
