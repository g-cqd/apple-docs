import { fetchRawGitHub } from '../../lib/github.js'

const README_FILENAMES = ['README.md', 'readme.md', 'README.markdown']
const DEFAULT_BRANCHES = ['main', 'master']

/**
 * README fetch + abstract extraction for the packages source. The README
 * is pulled directly from raw.githubusercontent.com (no API quota) when
 * possible; the abstract is the first prose paragraph after the title.
 */

async function fetchRawReadmeOnBranch(owner, repo, branch, rateLimiter) {
  for (const filename of README_FILENAMES) {
    try {
      const result = await fetchRawGitHub(owner, repo, branch, filename, rateLimiter)
      return {
        text: result.text ?? '',
        path: filename,
        sha: null,
        htmlUrl: `https://github.com/${owner}/${repo}/blob/${branch}/${filename}`,
        downloadUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`,
        etag: result.etag ?? null,
        lastModified: result.lastModified ?? null,
        branch,
      }
    } catch (error) {
      if (error?.status === 404) continue
      throw error
    }
  }
  return null
}

/**
 * Look up a README by trying common default branches (main, master) and every
 * README filename variant. Returns the first match or null if nothing was
 * found across all permutations.
 */
export async function discoverRawReadme(owner, repo, preferredBranch, rateLimiter) {
  const branches = []
  if (preferredBranch) branches.push(preferredBranch)
  for (const b of DEFAULT_BRANCHES) {
    if (!branches.includes(b)) branches.push(b)
  }
  for (const branch of branches) {
    const readme = await fetchRawReadmeOnBranch(owner, repo, branch, rateLimiter)
    if (readme) return readme
  }
  return null
}

/**
 * Extract a short abstract from raw README markdown — prefers the first
 * non-empty line after the first H1, skipping badges and HTML-only lines.
 */
export function extractAbstractFromMarkdown(markdown) {
  if (!markdown) return null
  const lines = markdown.split(/\r?\n/)
  let seenH1 = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (!seenH1) {
      if (line.startsWith('# ')) { seenH1 = true; continue }
      // Some READMEs start directly with a paragraph — accept that too.
      if (!line.startsWith('<') && !line.startsWith('[![') && !line.startsWith('![')) {
        return line.replace(/\s+/g, ' ').slice(0, 280)
      }
      continue
    }
    if (line.startsWith('#')) continue
    if (line.startsWith('<') || line.startsWith('[![') || line.startsWith('![')) continue
    return line.replace(/\s+/g, ' ').slice(0, 280)
  }
  return null
}

