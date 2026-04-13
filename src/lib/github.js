import {
  fetchWithRetry,
  checkResourceEtag,
} from './fetch-with-retry.js'

const USER_AGENT = 'apple-docs/2.0'
const DEFAULT_TIMEOUT = Number.parseInt(process.env.APPLE_DOCS_GITHUB_TIMEOUT ?? process.env.APPLE_DOCS_TIMEOUT ?? '45000', 10)
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
  const { data } = await fetchWithRetry(url, rateLimiter, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...authHeaders(),
    },
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

