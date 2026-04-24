import {
  fetchWithRetry,
  checkResourceEtag,
} from './fetch-with-retry.js'

const USER_AGENT = 'apple-docs/2.0'
const DEFAULT_TIMEOUT = Number.parseInt(process.env.APPLE_DOCS_GITHUB_TIMEOUT ?? process.env.APPLE_DOCS_TIMEOUT ?? '45000', 10)
const MAX_RETRIES = 3

/**
 * Token resolved at runtime (e.g. via `gh auth token` or git credential helper).
 * Used as a fallback when no GITHUB_TOKEN / GH_TOKEN env var is set.
 * @type {string|null}
 */
let _resolvedToken = null

/**
 * Record a token resolved at runtime. Env vars still take precedence.
 * Pass `null` to clear.
 * @param {string|null} token
 */
export function setResolvedGitHubToken(token) {
  _resolvedToken = token && token.length > 0 ? token : null
}

/**
 * Returns the GitHub token from the environment, or the resolved token set via
 * `setResolvedGitHubToken`, if available.
 * @returns {string|null}
 */
export function getGitHubToken() {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? _resolvedToken
}

export function hasGitHubToken() {
  return getGitHubToken() !== null
}

/**
 * Build auth headers using the available GitHub token.
 * @returns {Record<string, string>}
 */
function authHeaders() {
  const token = getGitHubToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function githubApiHeaders(extra = {}) {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...authHeaders(),
    ...extra,
  }
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
  const { data } = await fetchWithRetry(url, rateLimiter, {
    headers: githubApiHeaders(),
    maxRetries: MAX_RETRIES,
    timeout: DEFAULT_TIMEOUT,
    notFoundAs: 'http-error',
  })
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
  return fetchWithRetry(url, rateLimiter, {
    headers: {
      'User-Agent': USER_AGENT,
      ...authHeaders(),
    },
    parseAs: 'text',
    maxRetries: MAX_RETRIES,
    timeout: DEFAULT_TIMEOUT,
  })
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
  return checkResourceEtag(url, previousEtag, rateLimiter, {
    headers: {
      'User-Agent': USER_AGENT,
      ...authHeaders(),
    },
    timeout: DEFAULT_TIMEOUT,
  })
}

/**
 * Fetch repository metadata from the GitHub REST API.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @returns {Promise<{ data: object, etag: string|null, lastModified: string|null }>}
 */
export async function fetchGitHubRepo(owner, repo, rateLimiter) {
  const url = `https://api.github.com/repos/${owner}/${repo}`
  return fetchWithRetry(url, rateLimiter, {
    headers: githubApiHeaders(),
    maxRetries: MAX_RETRIES,
    timeout: DEFAULT_TIMEOUT,
    notFoundAs: 'http-error',
  })
}

/**
 * Check whether repository metadata changed since the previous ETag.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string|null} previousEtag
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @returns {Promise<{ status: 'unchanged'|'modified'|'deleted'|'error', etag?: string }>}
 */
export async function checkGitHubRepo(owner, repo, previousEtag, rateLimiter) {
  const url = `https://api.github.com/repos/${owner}/${repo}`
  return checkResourceEtag(url, previousEtag, rateLimiter, {
    headers: githubApiHeaders(),
    timeout: DEFAULT_TIMEOUT,
  })
}

/**
 * Fetch repository README metadata and decoded text from the GitHub contents API.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @returns {Promise<{ text: string, path: string|null, sha: string|null, htmlUrl: string|null, downloadUrl: string|null, etag: string|null, lastModified: string|null }>}
 */
export async function fetchGitHubReadme(owner, repo, branch, rateLimiter) {
  const url = `https://api.github.com/repos/${owner}/${repo}/readme?ref=${encodeURIComponent(branch)}`
  const { data, etag, lastModified } = await fetchWithRetry(url, rateLimiter, {
    headers: githubApiHeaders(),
    maxRetries: MAX_RETRIES,
    timeout: DEFAULT_TIMEOUT,
    notFoundAs: 'http-error',
  })

  const encoded = typeof data?.content === 'string' ? data.content.replace(/\n/g, '') : ''
  const text = encoded
    ? Buffer.from(encoded, data?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
    : ''

  return {
    text,
    path: data?.path ?? null,
    sha: data?.sha ?? null,
    htmlUrl: data?.html_url ?? null,
    downloadUrl: data?.download_url ?? null,
    etag,
    lastModified,
  }
}

/**
 * Check whether repository README changed since the previous ETag.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {string|null} previousEtag
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @returns {Promise<{ status: 'unchanged'|'modified'|'deleted'|'error', etag?: string }>}
 */
export async function checkGitHubReadme(owner, repo, branch, previousEtag, rateLimiter) {
  const url = `https://api.github.com/repos/${owner}/${repo}/readme?ref=${encodeURIComponent(branch)}`
  return checkResourceEtag(url, previousEtag, rateLimiter, {
    headers: githubApiHeaders(),
    timeout: DEFAULT_TIMEOUT,
  })
}
