/* Workbench 预览桥。由 Service Worker 以 /__vfs__/s/<id>/__bridge.js 提供。
 * 运行在 sandbox iframe（opaque origin）内，只通过 postMessage 与父页通信。
 */
(function () {
  'use strict'

  var boot = window.__WORKBENCH_PREVIEW__ || {}
  var sessionId = String(boot.sessionId || '')
  var buildVersion = Number(boot.buildVersion || 0)
  var requestSeq = 0

  function post(msg) {
    try {
      parent.postMessage(
        Object.assign({ __wb: 1, sessionId: sessionId, buildVersion: buildVersion }, msg),
        '*',
      )
    } catch (e) {
      /* ignore */
    }
  }

  function redact(text) {
    return String(text)
      .replace(/\bsk-[A-Za-z0-9._:-]{8,}/g, 'sk-***')
      .replace(/\bBearer\s+[A-Za-z0-9._:-]{8,}/gi, 'Bearer ***')
      .replace(/\b(api[_-]?key|apikey|access[_-]?token|token|secret)\b(\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1$2***')
  }

  function redactUrl(url) {
    try {
      var u = new URL(String(url), location.href)
      var keys = []
      u.searchParams.forEach(function (_, k) {
        keys.push(k)
      })
      keys.forEach(function (k) {
        if (/key|token|secret|auth|password|sign/i.test(k)) u.searchParams.set(k, '***')
      })
      return u.toString().slice(0, 1000)
    } catch (e) {
      return redact(String(url)).slice(0, 1000)
    }
  }

  function safeString(value, depth, seen) {
    try {
      if (value == null) return String(value)
      var t = typeof value
      if (t === 'string') return redact(value.length > 2000 ? value.slice(0, 2000) + '…' : value)
      if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value)
      if (t === 'function') return '[Function ' + (value.name || 'anonymous') + ']'
      if (t === 'symbol') return String(value)
      if (value instanceof Error) {
        return redact(value.name + ': ' + value.message + (value.stack ? '\n' + value.stack : ''))
      }
      if (value === window) return '[Window]'
      if (value === document) return '[Document]'
      if (value.nodeType) return '[Node ' + (value.nodeName || '') + ']'
      if (depth <= 0) return '[Object]'
      seen = seen || []
      if (seen.indexOf(value) >= 0) return '[Circular]'
      seen.push(value)
      if (Array.isArray(value)) {
        return '[' + value.slice(0, 50).map(function (v) { return safeString(v, depth - 1, seen) }).join(', ') + ']'
      }
      var out = {}
      Object.keys(value).slice(0, 30).forEach(function (k) {
        out[k] = safeString(value[k], depth - 1, seen)
      })
      return JSON.stringify(out)
    } catch (e) {
      return '[Unserializable]'
    }
  }

  /* ── console ── */
  ;['log', 'info', 'warn', 'error', 'debug'].forEach(function (method) {
    var orig = console[method]
    if (typeof orig !== 'function') return
    console[method] = function () {
      try {
        var args = Array.prototype.slice.call(arguments).map(function (a) {
          return safeString(a, 2)
        })
        post({ type: 'console', level: method, message: args.join(' ').slice(0, 8000), args: args })
      } catch (e) {
        /* ignore */
      }
      try {
        return orig.apply(console, arguments)
      } catch (e) {
        return undefined
      }
    }
  })

  /* ── 未捕获异常 ── */
  window.addEventListener('error', function (e) {
    post({
      type: 'error',
      message: redact(String(e.message || 'Script error')).slice(0, 2000),
      stack: e.error && e.error.stack ? redact(String(e.error.stack)).slice(0, 6000) : '',
      source: e.filename || '',
      line: e.lineno || 0,
      col: e.colno || 0,
      kind: 'error',
    })
  })
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason
    post({
      type: 'error',
      message: 'Unhandled rejection: ' + safeString(r, 2).slice(0, 2000),
      stack: r && r.stack ? redact(String(r.stack)).slice(0, 6000) : '',
      kind: 'unhandledrejection',
    })
  })

  /* ── fetch 元数据（不记录请求头/请求体） ── */
  var origFetch = window.fetch
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || ''
      var method = (init && init.method) || (input && input.method) || 'GET'
      var started = performance.now()
      var promise = origFetch.apply(this, arguments)
      if (promise && typeof promise.then === 'function') {
        promise.then(
          function (res) {
            post({
              type: 'network',
              method: String(method).toUpperCase(),
              url: redactUrl(url),
              status: res.status,
              ok: res.ok,
              duration: Math.round(performance.now() - started),
              resourceType: 'fetch',
            })
            return res
          },
          function (err) {
            post({
              type: 'network',
              method: String(method).toUpperCase(),
              url: redactUrl(url),
              status: 0,
              ok: false,
              duration: Math.round(performance.now() - started),
              error: redact(String((err && err.message) || err)).slice(0, 1000),
              resourceType: 'fetch',
            })
            throw err
          },
        )
      }
      return promise
    }
  }

  /* ── XHR 元数据 ── */
  if (typeof window.XMLHttpRequest === 'function') {
    var origOpen = window.XMLHttpRequest.prototype.open
    var origSend = window.XMLHttpRequest.prototype.send
    window.XMLHttpRequest.prototype.open = function (method, url) {
      this.__wbMeta = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), started: 0 }
      return origOpen.apply(this, arguments)
    }
    window.XMLHttpRequest.prototype.send = function () {
      var xhr = this
      if (xhr.__wbMeta) {
        xhr.__wbMeta.started = performance.now()
        xhr.addEventListener('loadend', function () {
          post({
            type: 'network',
            method: xhr.__wbMeta.method,
            url: redactUrl(xhr.__wbMeta.url),
            status: xhr.status || 0,
            ok: xhr.status >= 200 && xhr.status < 400,
            duration: Math.round(performance.now() - xhr.__wbMeta.started),
            resourceType: 'xhr',
          })
        })
      }
      return origSend.apply(this, arguments)
    }
  }

  /* ── DOM 摘要 ── */
  function isVisible(el) {
    try {
      if (!el || !el.getBoundingClientRect) return false
      var rect = el.getBoundingClientRect()
      var style = window.getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    } catch (e) {
      return false
    }
  }

  function describe(el) {
    if (!el) return null
    var attrs = {}
    try {
      for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i]
        if (!/^(id|class|role|type|name|placeholder|aria-label|aria-expanded|aria-pressed|aria-selected|disabled|checked)$/.test(a.name)) continue
        attrs[a.name] = redact(String(a.value)).slice(0, 200)
      }
    } catch (e) {
      /* ignore */
    }
    var value = ''
    try {
      if ('value' in el) value = '[not collected]'
      if (el.type === 'password') value = '[redacted]'
    } catch (e) {
      /* ignore */
    }
    var text = ''
    try {
      text = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable ? '' : redact(String(el.innerText || el.textContent || '')).replace(/\s+/g, ' ').trim().slice(0, 500)
    } catch (e) {
      /* ignore */
    }
    var rect = null
    try {
      var r = el.getBoundingClientRect()
      rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    } catch (e) {
      /* ignore */
    }
    return {
      tag: String(el.tagName || '').toLowerCase(),
      id: el.id || '',
      className: String(el.className || '').slice(0, 200),
      type: el.type || '',
      name: el.name || '',
      text: text,
      value: value,
      placeholder: el.placeholder || '',
      disabled: !!el.disabled,
      checked: 'checked' in el ? !!el.checked : undefined,
      visible: isVisible(el),
      rect: rect,
      attrs: attrs,
    }
  }

  function query(selector, all) {
    var list
    try {
      list = all ? Array.prototype.slice.call(document.querySelectorAll(selector)) : [document.querySelector(selector)]
    } catch (e) {
      throw new Error('无效选择器：' + ((e && e.message) || e))
    }
    if (!all) list = list.filter(Boolean)
    return { count: list.length, elements: list.slice(0, 50).map(describe) }
  }

  function click(selector) {
    var el = document.querySelector(selector)
    if (!el) throw new Error('找不到元素：' + selector)
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' })
    } catch (e) {
      /* ignore */
    }
    el.click()
    return { clicked: true, element: describe(el), note: '模拟点击 isTrusted=false，依赖真实用户手势的行为可能不触发' }
  }

  function typeText(selector, text) {
    var el = document.querySelector(selector)
    if (!el) throw new Error('找不到元素：' + selector)
    try {
      el.focus()
    } catch (e) {
      /* ignore */
    }
    if (el.isContentEditable) {
      el.textContent = String(text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      var proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype
      var desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(el, String(text))
      else el.value = String(text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return { typed: true, element: describe(el) }
  }

  function pageText(selector) {
    var el = selector ? document.querySelector(selector) : document.body
    if (!el) throw new Error('找不到元素：' + selector)
    var text = String(el.innerText || el.textContent || '')
    return { text: text.slice(0, 12000), truncated: text.length > 12000, length: text.length }
  }

  function snapshot() {
    var bodyText = ''
    try {
      bodyText = ''
    } catch (e) {
      /* ignore */
    }
    var buttons = []
    try {
      buttons = Array.prototype.slice.call(document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]')).slice(0, 40).map(describe)
    } catch (e) {
      /* ignore */
    }
    var inputs = []
    try {
      inputs = Array.prototype.slice.call(document.querySelectorAll('input,textarea,select,[contenteditable=true]')).slice(0, 40).map(describe)
    } catch (e) {
      /* ignore */
    }
    var links = []
    try {
      links = Array.prototype.slice.call(document.querySelectorAll('a[href]')).slice(0, 30).map(function (a) {
        return { text: redact(String(a.innerText || '')).trim().slice(0, 120), href: redactUrl(String(a.getAttribute('href') || '')).slice(0, 300) }
      })
    } catch (e) {
      /* ignore */
    }
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      text: bodyText,
      textNote: '默认观察不采集整页正文或表单值；需要核对作品文案时，请显式调用 page_action text 并指定元素。',
      counts: {
        elements: document.getElementsByTagName('*').length,
        buttons: document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]').length,
        inputs: document.querySelectorAll('input,textarea,select,[contenteditable=true]').length,
        links: document.querySelectorAll('a[href]').length,
        forms: document.forms.length,
      },
      buttons: buttons,
      inputs: inputs,
      links: links,
    }
  }

  function evalCode(code) {
    return new Promise(function (resolve) {
      try {
        // eslint-disable-next-line no-eval
        var result = (0, eval)(String(code))
        Promise.resolve(result).then(
          function (value) {
            resolve({ ok: true, result: safeString(value, 3) })
          },
          function (err) {
            resolve({ ok: false, error: redact(String((err && err.stack) || err)).slice(0, 4000) })
          },
        )
      } catch (e) {
        resolve({ ok: false, error: redact(String((e && e.stack) || e)).slice(0, 4000) })
      }
    })
  }

  /* ── 存储桥 ── */
  var storagePending = {}
  function storageRequest(action, key, value) {
    return new Promise(function (resolve, reject) {
      var id = 'st_' + Date.now() + '_' + ++requestSeq
      storagePending[id] = { resolve: resolve, reject: reject }
      post({ type: 'storage-request', requestId: id, action: action, key: key, value: value })
      setTimeout(function () {
        if (storagePending[id]) {
          delete storagePending[id]
          reject(new Error('存储桥超时'))
        }
      }, 5000)
    })
  }

  function handleStorageResult(data) {
    var pending = storagePending[data.requestId]
    if (!pending) return
    delete storagePending[data.requestId]
    if (data.ok) pending.resolve(data.value)
    else pending.reject(new Error(data.error || '存储失败'))
  }

  /* ── 共享 AI 桥 ── */
  var profilePending = {}
  function getAiProfiles() {
    return new Promise(function (resolve, reject) {
      var id = 'profiles_' + Date.now() + '_' + ++requestSeq
      var timer = setTimeout(function () { delete profilePending[id]; reject(new Error('模型列表请求超时')) }, 5000)
      profilePending[id] = { resolve: resolve, timer: timer }
      post({ type: 'ai-profiles-request', requestId: id })
    })
  }
  var aiPending = {}
  function aiChat(options) {
    var opts = options || {}
    var id = 'ai_' + Date.now() + '_' + ++requestSeq
    var messages = Array.isArray(opts.messages) ? opts.messages : []
    var promise = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (!aiPending[id]) return
        delete aiPending[id]
        reject(new Error('AI 请求超时'))
      }, 185000)
      aiPending[id] = { resolve: resolve, reject: reject, onChunk: opts.onChunk, timer: timer }
      post({ type: 'ai-request', requestId: id, messages: messages, temperature: opts.temperature, profileId: opts.profileId || 'default' })
    })
    promise.cancel = function () {
      post({ type: 'ai-cancel', requestId: id })
    }
    return promise
  }

  function handleAiEvent(data) {
    var id = String(data.requestId || '')
    var pending = aiPending[id]
    if (!pending) return
    if (data.type === 'ai-chunk') {
      try {
        if (typeof pending.onChunk === 'function') pending.onChunk(String(data.text || ''))
      } catch (e) {
        /* 页面回调异常不影响桥 */
      }
      return
    }
    delete aiPending[id]
    clearTimeout(pending.timer)
    if (data.type === 'ai-result') {
      pending.resolve({ text: String(data.text || ''), usage: data.usage || null })
    } else {
      pending.reject(new Error(String(data.error || 'AI 请求失败')))
    }
  }

  /* ── 父页 RPC ── */
  function handleCommand(data) {
    var id = data.requestId
    var action = data.action
    Promise.resolve()
      .then(function () {
        if (action === 'ping') {
          return { ok: true, sessionId: sessionId, buildVersion: buildVersion, title: document.title, readyState: document.readyState }
        }
        if (action === 'query') return query(String(data.selector || 'body'), !!data.all)
        if (action === 'click') return click(String(data.selector || ''))
        if (action === 'type') return typeText(String(data.selector || ''), String(data.text == null ? '' : data.text))
        if (action === 'text') return pageText(data.selector ? String(data.selector) : '')
        if (action === 'snapshot') return snapshot()
        if (action === 'eval') return evalCode(String(data.code || ''))
        throw new Error('未知的页面动作：' + action)
      })
      .then(
        function (result) {
          post({ type: 'rpc-result', requestId: id, ok: true, data: result })
        },
        function (err) {
          post({
            type: 'rpc-result',
            requestId: id,
            ok: false,
            error: redact(String((err && err.message) || err)).slice(0, 2000),
          })
        },
      )
  }

  window.addEventListener('message', function (event) {
    if (event.source !== parent) return
    var data = event.data
    if (!data || typeof data !== 'object') return
    if (sessionId && data.sessionId && data.sessionId !== sessionId) return
    if (data.type === 'ai-profiles-result') {
      var pending = profilePending[data.requestId]
      if (pending) { delete profilePending[data.requestId]; clearTimeout(pending.timer); pending.resolve(Array.isArray(data.profiles) ? data.profiles : []) }
      return
    }
    if (data.type === 'storage-result') {
      handleStorageResult(data)
      return
    }
    if (data.type === 'ai-chunk' || data.type === 'ai-result' || data.type === 'ai-error') {
      if (sessionId && data.sessionId && data.sessionId !== sessionId) return
      handleAiEvent(data)
      return
    }
    if (data.__wbCmd !== 1) return
    if (sessionId && data.sessionId && data.sessionId !== sessionId) return
    handleCommand(data)
  })

  window.Workbench = {
    preview: { sessionId: sessionId, buildVersion: buildVersion },
    storage: {
      get: function (key) {
        return storageRequest('get', String(key))
      },
      set: function (key, value) {
        return storageRequest('set', String(key), value)
      },
      remove: function (key) {
        return storageRequest('remove', String(key))
      },
      keys: function () {
        return storageRequest('keys')
      },
      export: function () {
        return storageRequest('export')
      },
      import: function (data) {
        return storageRequest('import', undefined, data)
      },
    },
    ai: {
      getProfiles: getAiProfiles,
      chat: aiChat,
      note: '需要在工作台试玩区显式授权；未授权请求会被拒绝，API Key 不会暴露给页面。',
    },
  }

  /* ── ready / load ── */
  var limitations = [
    '无法读取跨域 iframe 内部内容',
    '普通 iframe 不提供可靠截图能力',
    'Workbench.storage 存档可用 export/import 迁移到导出作品',
    '模拟点击的 isTrusted=false，依赖真实用户手势的行为可能不触发',
    'Workbench.ai 需要在试玩区显式授权；未授权时请求会被拒绝',
  ]
  if (!boot.virtualOrigin) {
    limitations.push('当前为内联降级模式，ES module 与相对 fetch 可能受限')
  }

  function sendReady() {
    post({
      type: 'ready',
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      textLength: document.body ? String(document.body.innerText || '').length : 0,
      nodeCount: document.getElementsByTagName('*').length,
      capabilities: {
        console: true,
        dom: true,
        interaction: true,
        networkMetadata: true,
        screenshot: false,
        storage: true,
        virtualOrigin: !!boot.virtualOrigin,
        ai: true,
      },
      limitations: limitations,
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sendReady, { once: true })
  } else {
    sendReady()
  }
  window.addEventListener('load', function () {
    post({ type: 'load' })
  })
})()
