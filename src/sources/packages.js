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
import { ParseError } from '../lib/errors.js'
import { SourceAdapter } from './base.js'
import { OFFICIAL_PACKAGES } from './packages-official.js'
import { packageKey, parseCompositeEtag, parsePackageKey, parsePackageUrl } from './packages/keys.js'
import {
  appendMetadataSection,
  ensureAbstractSection,
  normalizeLanguage,
  normalizeLicense,
  synthesizeMarkdown,
  synthesizeRepoShape,
} from './packages/markdown.js'
import {
  discoverRawReadme,
  extractAbstractFromMarkdown,
} from './packages/readme.js'

const PACKAGE_LIST_OWNER = 'SwiftPackageIndex'
const PACKAGE_LIST_REPO = 'PackageList'
const PACKAGE_LIST_BRANCH = 'main'
const PACKAGE_LIST_PATH = 'packages.json'
const ROOT_SLUG = 'packages'

const README_FILENAMES = ['README.md', 'readme.md', 'README.markdown']
const _DEFAULT_BRANCHES = ['main', 'master']


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

    let packageUrls
    try {
      packageUrls = JSON.parse(text)
    } catch (cause) {
      throw new ParseError('SwiftPackageIndex packages.json failed to parse', { cause, source: 'packages' })
    }
    if (!Array.isArray(packageUrls)) {
      throw new ParseError('Package list payload must be a JSON array', { source: 'packages' })
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
      throw new ParseError('Package payload is missing repository metadata', { source: 'packages' })
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
