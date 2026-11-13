/** 试玩虚拟文件缓存：页面写入，Service Worker 读取。 */

const DB_NAME = 'rpagent-preview'
const DB_VERSION = 1
const STORE_SESSIONS = 'sessions'
const STORE_FILES = 'files'

export interface PreviewCacheSession {
  sessionId: string
  taskId: string
  entryPath: string
  buildVersion: number
  virtualOrigin: boolean
  createdAt: number
}

export interface PreviewCacheFile {
  key: string
  sessionId: string
  path: string
  mime: string
  text?: string
  blob?: Blob
  size: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionId' })
      }
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        const store = db.createObjectStore(STORE_FILES, { keyPath: 'key' })
        store.createIndex('sessionId', 'sessionId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export async function putPreviewSession(meta: PreviewCacheSession): Promise<void> {
  await tx(STORE_SESSIONS, 'readwrite', (s) => s.put(meta) as IDBRequest<IDBValidKey>)
}

export async function clearPreviewFiles(sessionId: string): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_FILES, 'readwrite')
    const store = t.objectStore(STORE_FILES)
    const idx = store.index('sessionId')
    const req = idx.openKeyCursor(IDBKeyRange.only(sessionId))
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        store.delete(cursor.primaryKey)
        cursor.continue()
      } else {
        resolve()
      }
    }
    req.onerror = () => reject(req.error)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function putPreviewFiles(files: PreviewCacheFile[]): Promise<void> {
  if (!files.length) return
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_FILES, 'readwrite')
    const store = t.objectStore(STORE_FILES)
    for (const f of files) store.put(f)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function deletePreviewSessionCache(sessionId: string): Promise<void> {
  await clearPreviewFiles(sessionId)
  await tx(STORE_SESSIONS, 'readwrite', (s) => s.delete(sessionId) as IDBRequest<undefined>)
}

export function previewFileKey(sessionId: string, path: string): string {
  return `${sessionId}|${path}`
}
