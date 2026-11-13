/* Workbench 试玩虚拟文件源。
 * 作用域 /__vfs__/，从 rpagent-preview IndexedDB 读取页面写入的会话文件。
 * 不参与工作台主库，避免与 Dexie 版本迁移耦合。
 */
'use strict'

const DB_NAME = 'rpagent-preview'
const DB_VERSION = 1
const STORE_SESSIONS = 'sessions'
const STORE_FILES = 'files'
const PREFIX = '/__vfs__/s/'

let dbPromise = null

function openDB() {
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

function idbGet(storeName, key) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly')
        const req = tx.objectStore(storeName).get(key)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

function fileKey(sessionId, path) {
  return sessionId + '|' + path
}

function corsHeaders(extra) {
  return Object.assign(
    {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
    extra || {},
  )
}

function mimeOf(file, path) {
  let mime = file && file.mime ? file.mime : ''
  if (!mime) {
    const lower = String(path || '').toLowerCase()
    if (lower.endsWith('.html') || lower.endsWith('.htm')) mime = 'text/html; charset=utf-8'
    else if (lower.endsWith('.css')) mime = 'text/css; charset=utf-8'
    else if (lower.endsWith('.js') || lower.endsWith('.mjs')) mime = 'text/javascript; charset=utf-8'
    else if (lower.endsWith('.json')) mime = 'application/json; charset=utf-8'
    else if (lower.endsWith('.svg')) mime = 'image/svg+xml'
    else if (lower.endsWith('.png')) mime = 'image/png'
    else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) mime = 'image/jpeg'
    else if (lower.endsWith('.webp')) mime = 'image/webp'
    else if (lower.endsWith('.woff2')) mime = 'font/woff2'
    else if (lower.endsWith('.woff')) mime = 'font/woff'
    else mime = 'application/octet-stream'
  }
  if (/^(text\/|application\/json|application\/javascript|image\/svg)/.test(mime) && !/charset=/i.test(mime)) {
    mime += '; charset=utf-8'
  }
  return mime
}

function notFound(message) {
  return new Response(message, {
    status: 404,
    headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
  })
}

async function serve(request, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  const rawPath = url.pathname
  if (!rawPath.startsWith(PREFIX)) return notFound('不是试玩路径')
  const restRaw = rawPath.slice(PREFIX.length)
  const slash = restRaw.indexOf('/')
  if (slash < 0) return notFound('缺少会话 ID')

  const sessionId = decodeURIComponent(restRaw.slice(0, slash))
  let rest = restRaw.slice(slash + 1)
  try {
    rest = decodeURIComponent(rest)
  } catch (e) {
    /* keep raw */
  }
  rest = rest.replace(/\/+/g, '/').replace(/^\/+/, '')

  const session = await idbGet(STORE_SESSIONS, sessionId)
  if (!session) return notFound('试玩会话不存在或已关闭')

  const entry = session.entryPath || '/index.html'
  let path = rest ? '/' + rest : entry
  let file = await idbGet(STORE_FILES, fileKey(sessionId, path))

  if (!file && request.mode === 'navigate' && !/\.[a-z0-9]+$/i.test(path)) {
    path = entry
    file = await idbGet(STORE_FILES, fileKey(sessionId, path))
  }
  if (!file) return notFound('资源不存在：' + path)

  const mime = mimeOf(file, path)
  const headers = corsHeaders({
    'Content-Type': mime,
    'X-Workbench-Session': sessionId,
    'X-Workbench-Build': String(session.buildVersion || 0),
  })

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers })
  }

  if (typeof file.text === 'string') {
    return new Response(file.text, { status: 200, headers })
  }
  if (file.blob) {
    return new Response(file.blob, { status: 200, headers })
  }
  return new Response('', { status: 200, headers })
}

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (data && data.type === 'preview-ping') {
    if (event.ports && event.ports[0]) event.ports[0].postMessage({ type: 'pong' })
  }
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith('/__vfs__/')) return
  event.respondWith(
    serve(event.request, url).catch(
      (err) =>
        new Response('试玩服务错误：' + String((err && err.message) || err), {
          status: 500,
          headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
        }),
    ),
  )
})
