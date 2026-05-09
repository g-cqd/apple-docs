const ROOT_SLUG = 'packages'

/**
 * Composite-key helpers for the packages source. The catalog stores
 * each repo as 'owner/repo' but emits ETags as 'repoEtag|readmeEtag'
 * so a change to either side counts as a corpus change.
 */

export function packageKey(owner, repo) {
  return `${ROOT_SLUG}/${owner.toLowerCase()}/${repo.toLowerCase()}`
}

export function parsePackageUrl(url) {
  const match = String(url ?? '').trim().match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  if (!match) return null
  return {
    owner: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2]),
  }
}

export function parsePackageKey(key) {
  const match = String(key ?? '').match(/^packages\/([^/]+)\/([^/]+)$/)
  if (!match) {
    throw new Error(`Invalid package key: ${key}`)
  }
  return { owner: match[1], repo: match[2] }
}

export function parseCompositeEtag(value) {
  if (!value) return { source: 'api', repo: null, readme: null, branch: null, readmeFilename: null }
  try {
    const parsed = JSON.parse(value)
    const source = parsed?.source === 'raw' ? 'raw' : 'api'
    return {
      source,
      repo: typeof parsed?.repo === 'string' ? parsed.repo : null,
      readme: typeof parsed?.readme === 'string' ? parsed.readme : null,
      branch: typeof parsed?.branch === 'string' ? parsed.branch : null,
      readmeFilename: typeof parsed?.readmeFilename === 'string' ? parsed.readmeFilename : null,
    }
  } catch {
    return { source: 'api', repo: value, readme: null, branch: null, readmeFilename: null }
  }
}
