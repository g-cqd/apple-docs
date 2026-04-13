const USER_AGENT = 'apple-docs/2.0'
const DEFAULT_TIMEOUT = 30_000
const MAX_RETRIES = 3

/**
 * Returns the GitHub token from the environment, if available.
 * @returns {string|null}
 */
function getGitHubToken() {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null
}

/**
 * Build auth headers using the available GitHub token.
 * @returns {Record<string, string>}
 */
function authHeaders() {
  const token = getGitHubToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Fetch the full recursive git tree for a repository branch.
 *
 * @param {string} owner - GitHub owner/org (e.g. 'apple')
 * @param {string} repo - Repository name (e.g. 'swift-evolution')
 * @param {string} branch - Branch or ref (e.g. 'main')
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @returns {Promise<Array<{ path: string, type: string, sha: string, size?: number }>>}
 */
export async function fetchGitHubTree(owner, repo, branch, rateLimiter) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  const data = await fetchJsonWithRetry(url, rateLimiter)
  return data.tree
}

/**
 * Fetch a raw file from GitHub.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {string} filePath - Path within the repository (e.g. 'proposals/0001-allow-keywords-as-argument-labels.md')
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @returns {Promise<{ text: string, etag: string|null, lastModified: string|null }>}
 */
export async function fetchRawGitHub(owner, repo, branch, filePath, rateLimiter) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`
  return fetchTextWithRetry(url, rateLimiter)
}

/**
 * Check whether a raw GitHub file has changed since last seen.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {string} filePath
 * @param {string|null} previousEtag
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @returns {Promise<{ status: 'unchanged'|'modified'|'deleted'|'error', etag?: string }>}
 */
export async function checkRawGitHub(owner, repo, branch, filePath, previousEtag, rateLimiter) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`
  await rateLimiter.acquire()

  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': USER_AGENT,
        ...authHeaders(),
        ...(previousEtag ? { 'If-None-Match': previousEtag } : {}),
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchJsonWithRetry(url, rateLimiter, attempt = 0) {
  await rateLimiter.acquire()

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...authHeaders(),
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
  })

  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '2', 10)
    await sleep(retryAfter * 1000)
    return fetchJsonWithRetry(url, rateLimiter, attempt + 1)
  }

  if (!res.ok) {
    throw Object.assign(
      new Error(`HTTP ${res.status} fetching ${url}`),
      { status: res.status },
    )
  }

  return res.json()
}

async function fetchTextWithRetry(url, rateLimiter, attempt = 0) {
  await rateLimiter.acquire()

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      ...authHeaders(),
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
  })

  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '2', 10)
    await sleep(retryAfter * 1000)
    return fetchTextWithRetry(url, rateLimiter, attempt + 1)
  }

  if (res.status === 404) {
    throw Object.assign(new Error(`Not found: ${url}`), { status: 404 })
  }

  if (!res.ok) {
    throw Object.assign(
      new Error(`HTTP ${res.status} fetching ${url}`),
      { status: res.status },
    )
  }

  return {
    text: await res.text(),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
