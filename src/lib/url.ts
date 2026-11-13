/**
 * Base URL 归一化。
 *
 * 用户经常只填 `https://ai.varud.asia`，而 OpenAI 兼容网关的实际端点是
 * `https://ai.varud.asia/v1/chat/completions`。补齐规则（与主流客户端一致）：
 * 1. 缺协议时补 `https://`（本机地址补 `http://`）；
 * 2. 去掉尾部斜杠与误贴的 `/chat/completions`、`/models` 等尾巴；
 * 3. 折叠重复的 `/v1/v1`；
 * 4. 路径里没有任何版本段时补 `/v1`；已有 `/v1`、`/v4`、`/v1beta` 之类保持原样。
 */

/** 路径中的版本段，例如 /v1、/v1beta、/v4、/api/paas/v4。 */
const VERSION_SEGMENT = /\/(v\d+)(?:[a-z0-9.-]*)?(?:\/|$)/i

/** 用户可能误贴的完整端点尾巴。 */
const ENDPOINT_TAIL = /\/(chat\/completions|completions|responses|models|embeddings)$/i

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i

/** 只补版本段，不动协议与其他路径。 */
export function ensureApiVersion(url: string): string {
  const s = String(url || '').trim()
  if (!s) return ''
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)/i.exec(s)
  if (!match) return s
  const [, origin, path = ''] = match
  if (VERSION_SEGMENT.test(path)) return s
  return `${origin}${path.replace(/\/+$/, '')}/v1`
}

export function normalizeBaseUrl(input: string): string {
  let s = String(input || '').trim()
  if (!s) return ''
  if (!HAS_SCHEME.test(s)) {
    const bare = s.replace(/^\/+/, '')
    s = `${LOCAL_HOST.test(bare) ? 'http' : 'https'}://${bare}`
  }
  s = s.replace(/\/+$/, '')
  s = s.replace(ENDPOINT_TAIL, '')
  while (/\/v1\/v1$/i.test(s)) s = s.replace(/\/v1\/v1$/i, '/v1')
  s = s.replace(/\/+$/, '')
  return ensureApiVersion(s)
}

/** 拼接最终请求地址，例如 `.../v1` + `chat/completions`。 */
export function apiEndpoint(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${String(path || '').replace(/^\/+/, '')}`
}

/** 给界面用的可读端点，空 URL 返回空串。 */
export function describeChatEndpoint(baseUrl: string): string {
  return baseUrl.trim() ? apiEndpoint(baseUrl, 'chat/completions') : ''
}
