import {
  fetchRawGitHub,
  fetchGitHubRepo,
  fetchGitHubReadme,
  checkRawGitHub,
  checkGitHubRepo,
  checkGitHubReadme,
  hasGitHubToken,
} from '../lib/github.js'
import { parseMarkdownToSections } from '../content/parse-markdown.js'
import { SourceAdapter } from './base.js'
import { OFFICIAL_PACKAGES } from './packages-official.js'

const PACKAGE_LIST_OWNER = 'SwiftPackageIndex'
const PACKAGE_LIST_REPO = 'PackageList'
const PACKAGE_LIST_BRANCH = 'main'
const PACKAGE_LIST_PATH = 'packages.json'
const ROOT_SLUG = 'packages'

const README_FILENAMES = ['README.md', 'readme.md', 'README.markdown']
const DEFAULT_BRANCHES = ['main', 'master']

function packageSyncLimit() {
  const raw = process.env.APPLE_DOCS_PACKAGES_LIMIT
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * Resolve the package catalog scope for this run.
 *
 * Precedence:
 *   - `APPLE_DOCS_PACKAGES_SCOPE=official|full` when set.
 *   - `sync --full` (threaded as `ctx.fullSync`) requests the full catalog.
 *   - Otherwise the curated `official` allowlist.
 *
 * Scope no longer depends on token presence: raw.githubusercontent.com covers
 * the full SwiftPackageIndex catalog without a quota, so callers who want
 * every package simply opt in via `--full` or the env var.
 *
 * @param {{ fullSync?: boolean }} [ctx]
 * @returns {'official'|'full'}
 */
function packageCatalogScope(ctx) {
  const raw = (process.env.APPLE_DOCS_PACKAGES_SCOPE ?? '').trim().toLowerCase()
  if (raw === 'full') return 'full'
  if (raw === 'official') return 'official'
  if (ctx?.fullSync) return 'full'
  return 'official'
}

/**
 * Resolve how package metadata should be fetched for this run.
 *
 * The default is `raw` (README-only via raw.githubusercontent.com) because it
 * has no per-user quota and is sufficient for the rendered documents. Callers
 * who want the richer GitHub REST metadata (stars, license, topics, …) opt in
 * with `APPLE_DOCS_PACKAGES_FETCH=api`, which also requires a GitHub token;
 * if none is available the request silently degrades back to `raw` to avoid
 * burning an IP-level 60/hr quota.
 *
 * @returns {'raw'|'api'}
 */
function packageFetchMode(_ctx) {
  const override = (process.env.APPLE_DOCS_PACKAGES_FETCH ?? '').trim().toLowerCase()
  if (override === 'raw') return 'raw'
  if (override === 'api') return hasGitHubToken() ? 'api' : 'raw'
  return 'raw'
}

function packageKey(owner, repo) {
  return `${ROOT_SLUG}/${owner.toLowerCase()}/${repo.toLowerCase()}`
}

function parsePackageUrl(url) {
  const match = String(url ?? '').trim().match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  if (!match) return null
  return {
    owner: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2]),
  }
}

function parsePackageKey(key) {
  const match = String(key ?? '').match(/^packages\/([^/]+)\/([^/]+)$/)
  if (!match) {
    throw new Error(`Invalid package key: ${key}`)
  }
  return { owner: match[1], repo: match[2] }
}

function parseCompositeEtag(value) {
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

function synthesizeMarkdown(repo) {
  const title = repo?.full_name ?? repo?.name ?? 'Swift Package'
  const description = repo?.description?.trim() || 'Package metadata imported from GitHub.'
  return `# ${title}\n\n${description}\n`
}

function normalizeLicense(license) {
  if (!license) return null
  if (license.spdx_id && license.spdx_id !== 'NOASSERTION') return license.spdx_id
  return license.name ?? null
}

function normalizeLanguage(language) {
  return typeof language === 'string' && language.trim() ? language.trim().toLowerCase() : null
}

function reindexSections(sections) {
  return sections.map((section, index) => ({
    ...section,
    sortOrder: index,
  }))
}

function ensureAbstractSection(sections, abstractText) {
  if (!abstractText) return sections
  const next = sections.map(section => ({ ...section }))
  const index = next.findIndex(section => section.sectionKind === 'abstract')
  if (index >= 0) {
    next[index].contentText = abstractText
    next[index].contentJson = null
  } else {
    next.unshift({
      sectionKind: 'abstract',
      heading: null,
      contentText: abstractText,
      contentJson: null,
      sortOrder: 0,
    })
  }
  return reindexSections(next)
}

function appendMetadataSection(sections, repo, readme) {
  const fields = []
  fields.push(`Repository: ${repo?.full_name ?? repo?.name ?? 'unknown'}`)

  if (repo?.homepage) fields.push(`Homepage: ${repo.homepage}`)
  if (repo?.stargazers_count != null) fields.push(`Stars: ${repo.stargazers_count}`)
  if (repo?.forks_count != null) fields.push(`Forks: ${repo.forks_count}`)
  if (repo?.open_issues_count != null) fields.push(`Open issues: ${repo.open_issues_count}`)
  if (repo?.default_branch) fields.push(`Default branch: ${repo.default_branch}`)

  const language = normalizeLanguage(repo?.language)
  if (language) fields.push(`Primary language: ${language}`)

  const license = normalizeLicense(repo?.license)
  if (license) fields.push(`License: ${license}`)

  if (Array.isArray(repo?.topics) && repo.topics.length > 0) {
    fields.push(`Topics: ${repo.topics.join(', ')}`)
  }

  if (readme?.path) fields.push(`README: ${readme.path}`)
  if (repo?.archived) fields.push('Archived: yes')
  if (repo?.fork) fields.push('Fork: yes')

  if (fields.length === 0) return sections

  return reindexSections([
    ...sections.map(section => ({ ...section })),
    {
      sectionKind: 'discussion',
      heading: 'Package Metadata',
      contentText: fields.join('\n\n'),
      contentJson: null,
      sortOrder: sections.length,
    },
  ])
}

/**
 * Try README filename variants on raw.githubusercontent.com against a given
 * branch, stopping at the first 200. Returns the README shaped like the GitHub
 * /readme API payload, or `null` if all variants 404.
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
async function discoverRawReadme(owner, repo, preferredBranch, rateLimiter) {
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
function extractAbstractFromMarkdown(markdown) {
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

/**
 * Build a minimal GitHub-repo-shaped object for the curated no-auth path.
 * Fields beyond owner/repo/default_branch/description are intentionally null
 * since we don't call the GitHub REST API in this scope.
 */
function synthesizeRepoShape({ owner, repo }, { branch, description }) {
  return {
    name: repo,
    full_name: `${owner}/${repo}`,
    html_url: `https://github.com/${owner}/${repo}`,
    description: description ?? null,
    language: null,
    stargazers_count: null,
    forks_count: null,
    open_issues_count: null,
    topics: [],
    homepage: null,
    default_branch: branch ?? 'main',
    archived: false,
    fork: false,
    owner: { login: owner },
    license: null,
    pushed_at: null,
    updated_at: null,
  }
}

export class PackagesAdapter extends SourceAdapter {
  static type = 'packages'
  static displayName = 'Swift Package Catalog'
  static syncMode = 'flat'

  async discover(ctx) {
    if (ctx.db && !ctx.db.getRootBySlug(ROOT_SLUG)) {
      ctx.db.upsertRoot(ROOT_SLUG, 'Swift Package Catalog', 'collection', ROOT_SLUG)
    }

    const scope = packageCatalogScope(ctx)
    const root = ctx.db?.getRootBySlug(ROOT_SLUG) ?? null
    const limit = packageSyncLimit()

    if (scope === 'official') {
      const keySet = new Set()
      for (const { owner, repo } of OFFICIAL_PACKAGES) {
        keySet.add(packageKey(owner, repo))
        if (limit != null && keySet.size >= limit) break
      }
      return this.validateDiscoveryResult({
        keys: [...keySet],
        roots: root ? [root] : undefined,
      })
    }

    // full scope: union the curated apple/swiftlang allowlist with the
    // SwiftPackageIndex catalog so the official repos are always included.
    const { text } = await fetchRawGitHub(
      PACKAGE_LIST_OWNER,
      PACKAGE_LIST_REPO,
      PACKAGE_LIST_BRANCH,
      PACKAGE_LIST_PATH,
      ctx.rateLimiter,
    )

    const packageUrls = JSON.parse(text)
    if (!Array.isArray(packageUrls)) {
      throw new Error('Package list payload must be a JSON array')
    }

    const keySet = new Set()
    for (const { owner, repo } of OFFICIAL_PACKAGES) {
      keySet.add(packageKey(owner, repo))
      if (limit != null && keySet.size >= limit) break
    }
    for (const url of packageUrls) {
      if (limit != null && keySet.size >= limit) break
      const parsed = parsePackageUrl(url)
      if (!parsed) continue
      keySet.add(packageKey(parsed.owner, parsed.repo))
    }

    return this.validateDiscoveryResult({
      keys: [...keySet],
      roots: root ? [root] : undefined,
    })
  }

  async fetch(key, ctx) {
    const { owner, repo } = parsePackageKey(key)
    const scope = packageCatalogScope(ctx)
    const fetchMode = packageFetchMode(ctx)

    if (fetchMode === 'raw') {
      // No-auth path: fetch README from raw.githubusercontent.com only.
      // Metadata beyond owner/repo/description is unavailable here.
      const readme = await discoverRawReadme(owner, repo, 'main', ctx.rateLimiter)
      const branch = readme?.branch ?? 'main'
      const description = extractAbstractFromMarkdown(readme?.text ?? null)
      const repoData = synthesizeRepoShape({ owner, repo }, { branch, description })

      return this.validateFetchResult({
        key,
        payload: {
          repo: repoData,
          readme,
          syncScope: scope,
          fetchMode,
        },
        etag: JSON.stringify({
          source: 'raw',
          repo: null,
          readme: readme?.etag ?? null,
          branch,
          readmeFilename: readme?.path ?? null,
        }),
        lastModified: readme?.lastModified ?? null,
      })
    }

    const repoResult = await fetchGitHubRepo(owner, repo, ctx.rateLimiter)
    const branch = repoResult.data?.default_branch ?? 'main'

    let readme = null
    try {
      readme = await fetchGitHubReadme(owner, repo, branch, ctx.rateLimiter)
    } catch (error) {
      if (error?.status !== 404) throw error
    }

    return this.validateFetchResult({
      key,
      payload: {
        repo: repoResult.data,
        readme,
        syncScope: scope,
        fetchMode,
      },
      etag: JSON.stringify({
        source: 'api',
        repo: repoResult.etag ?? null,
        readme: readme?.etag ?? null,
        branch,
      }),
      lastModified: readme?.lastModified ?? repoResult.lastModified ?? null,
    })
  }

  async check(key, previousState, ctx) {
    const { owner, repo } = parsePackageKey(key)
    const state = parseCompositeEtag(previousState?.etag ?? null)
    const branch = state.branch ?? 'main'

    if (state.source === 'raw') {
      // No-auth path: README ETag is the sole change signal.
      const readmeFilename = state.readmeFilename ?? README_FILENAMES[0]
      const readmeStatus = await checkRawGitHub(owner, repo, branch, readmeFilename, state.readme, ctx.rateLimiter)

      if (readmeStatus.status === 'deleted' && state.readme == null) {
        return this.validateCheckResult({ status: 'unchanged', changed: false })
      }
      if (readmeStatus.status === 'deleted' || readmeStatus.status === 'modified') {
        return this.validateCheckResult({ status: 'modified', changed: true })
      }
      if (readmeStatus.status === 'error') {
        return this.validateCheckResult({ status: 'error', changed: false })
      }
      return this.validateCheckResult({ status: 'unchanged', changed: false })
    }

    const repoStatus = await checkGitHubRepo(owner, repo, state.repo, ctx.rateLimiter)
    if (repoStatus.status === 'deleted') {
      return this.validateCheckResult({
        status: 'deleted',
        changed: false,
        deleted: true,
      })
    }
    if (repoStatus.status === 'error') {
      return this.validateCheckResult({ status: 'error', changed: false })
    }
    if (repoStatus.status === 'modified') {
      return this.validateCheckResult({ status: 'modified', changed: true })
    }

    const readmeStatus = await checkGitHubReadme(owner, repo, branch, state.readme, ctx.rateLimiter)

    if (readmeStatus.status === 'deleted' && state.readme == null) {
      return this.validateCheckResult({ status: 'unchanged', changed: false })
    }
    if (readmeStatus.status === 'deleted' || readmeStatus.status === 'modified') {
      return this.validateCheckResult({ status: 'modified', changed: true })
    }
    if (readmeStatus.status === 'error') {
      return this.validateCheckResult({ status: 'error', changed: false })
    }

    return this.validateCheckResult({ status: 'unchanged', changed: false })
  }

  normalize(key, rawPayload) {
    const repo = rawPayload?.repo
    if (!repo || typeof repo !== 'object') {
      throw new Error('Package payload is missing repository metadata')
    }

    const readme = rawPayload?.readme ?? null
    const scope = rawPayload?.syncScope === 'full'
      ? 'full'
      : rawPayload?.syncScope === 'official'
        ? 'official'
        : packageCatalogScope({})
    const fetchMode = rawPayload?.fetchMode === 'api'
      ? 'api'
      : rawPayload?.fetchMode === 'raw'
        ? 'raw'
        : packageFetchMode({})
    const source = fetchMode === 'raw' ? 'raw' : 'github-api'

    const sourceMetadata = {
      package: true,
      scope,
      source,
      owner: repo.owner?.login ?? null,
      repo: repo.name ?? null,
      fullName: repo.full_name ?? null,
      defaultBranch: repo.default_branch ?? null,
      stars: repo.stargazers_count ?? 0,
      forks: repo.forks_count ?? 0,
      openIssues: repo.open_issues_count ?? 0,
      topics: Array.isArray(repo.topics) ? repo.topics : [],
      archived: !!repo.archived,
      fork: !!repo.fork,
      homepage: repo.homepage ?? null,
      license: normalizeLicense(repo.license),
      primaryLanguage: normalizeLanguage(repo.language),
      readmePath: readme?.path ?? null,
      readmeUrl: readme?.htmlUrl ?? readme?.downloadUrl ?? null,
      pushedAt: repo.pushed_at ?? null,
      updatedAt: repo.updated_at ?? null,
    }

    const markdown = readme?.text?.trim() ? readme.text : synthesizeMarkdown(repo)
    const result = parseMarkdownToSections(markdown, key, {
      sourceType: PackagesAdapter.type,
      kind: 'package',
      framework: ROOT_SLUG,
      url: repo.html_url ?? `https://github.com/${repo.full_name ?? `${repo.owner?.login ?? ''}/${repo.name ?? ''}`}`,
      language: normalizeLanguage(repo.language),
      sourceMetadata: JSON.stringify(sourceMetadata),
    })

    result.document.title = repo.full_name ?? repo.name ?? result.document.title
    result.document.abstractText = repo.description?.trim() || result.document.abstractText
    result.sections = ensureAbstractSection(result.sections, result.document.abstractText)
    result.sections = appendMetadataSection(result.sections, repo, readme)

    return this.validateNormalizeResult(result)
  }

  renderHints() {
    return { showStars: true, showLicense: true }
  }
}
