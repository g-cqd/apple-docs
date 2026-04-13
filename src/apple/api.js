const TUTORIALS_BASE = process.env.APPLE_DOCS_API_BASE ?? 'https://developer.apple.com/tutorials/data'
const USER_AGENT = 'apple-docs-mcp/1.0'
const DEFAULT_TIMEOUT = parseInt(process.env.APPLE_DOCS_TIMEOUT ?? '30000', 10)
const MAX_RETRIES = 3

/**
 * Resolve a canonical path to its full fetch URL.
 * Paths starting with 'design/' use the /tutorials/data/design/ base.
 * All others use /tutorials/data/documentation/.
 */
function resolveUrl(path) {
  if (path.startsWith('design/')) {
    return `${TUTORIALS_BASE}/${path}.json`
  }
  return `${TUTORIALS_BASE}/documentation/${path}.json`
}

/**
 * Fetch an Apple documentation page JSON.
 * @param {string} path - Canonical doc path (e.g. 'swiftui/view' or 'design/human-interface-guidelines/accessibility')
 * @param {import('../lib/rate-limiter.js').RateLimiter} rateLimiter
 * @returns {{ json: object, etag: string|null, lastModified: string|null }}
 */
export async function fetchDocPage(path, rateLimiter) {
  return fetchWithRetry(resolveUrl(path), rateLimiter)
}

/**
 * Check if a page has changed via HEAD request.
 * @returns {{ status: 'unchanged'|'modified'|'deleted'|'error', etag?: string }}
 */
export async function checkDocPage(path, etag, rateLimiter) {
  const url = resolveUrl(path)
  await rateLimiter.acquire()

  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': USER_AGENT,
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    })

    if (res.status === 304) return { status: 'unchanged' }
    if (res.status === 404) return { status: 'deleted' }
    if (res.ok) return { status: 'modified', etag: res.headers.get('etag') }
    return { status: 'error' }
  } catch {
    return { status: 'error' }
  }
}

/**
 * Fetch the technologies index to discover documentation roots.
 */
export async function fetchTechnologies(rateLimiter) {
  const url = `${TUTORIALS_BASE}/documentation/technologies.json`
  return fetchWithRetry(url, rateLimiter)
}

async function fetchWithRetry(url, rateLimiter, attempt = 0) {
  await rateLimiter.acquire()

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
  })

  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '2', 10)
    await sleep(retryAfter * 1000)
    return fetchWithRetry(url, rateLimiter, attempt + 1)
  }

  if (res.status === 404) {
    throw Object.assign(new Error(`Not found: ${url}`), { status: 404 })
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`)
  }

  const json = await res.json()
  return {
    json,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  }
}

/**
 * Fetch a raw HTML page (e.g. App Store Review Guidelines).
 * @param {string} url - Full URL to fetch
 * @param {import('../lib/rate-limiter.js').RateLimiter} rateLimiter
 * @returns {{ html: string, etag: string|null, lastModified: string|null }}
 */
export async function fetchHtmlPage(url, rateLimiter) {
  await rateLimiter.acquire()

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`)
  }

  return {
    html: await res.text(),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  }
}

/**
 * Check if an HTML page has changed via HEAD request.
 * @returns {{ status: 'unchanged'|'modified'|'deleted'|'error', etag?: string }}
 */
export async function checkHtmlPage(url, etag, rateLimiter) {
  await rateLimiter.acquire()

  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': USER_AGENT,
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    })

    if (res.status === 304) return { status: 'unchanged' }
    if (res.status === 404) return { status: 'deleted' }
    if (res.ok) return { status: 'modified', etag: res.headers.get('etag') }
    return { status: 'error' }
  } catch {
    return { status: 'error' }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
