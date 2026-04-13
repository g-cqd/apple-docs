import {
  fetchRawGitHub,
  fetchGitHubRepo,
  fetchGitHubReadme,
  checkGitHubRepo,
  checkGitHubReadme,
  hasGitHubToken,
} from '../lib/github.js'
import { parseMarkdownToSections } from '../content/parse-markdown.js'
import { SourceAdapter } from './base.js'

const PACKAGE_LIST_OWNER = 'SwiftPackageIndex'
const PACKAGE_LIST_REPO = 'PackageList'
const PACKAGE_LIST_BRANCH = 'main'
const PACKAGE_LIST_PATH = 'packages.json'
const ROOT_SLUG = 'packages'

function packageSyncLimit() {
  const raw = process.env.APPLE_DOCS_PACKAGES_LIMIT
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
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
  if (!value) return { repo: null, readme: null, branch: null }
  try {
    const parsed = JSON.parse(value)
    return {
      repo: typeof parsed?.repo === 'string' ? parsed.repo : null,
      readme: typeof parsed?.readme === 'string' ? parsed.readme : null,
      branch: typeof parsed?.branch === 'string' ? parsed.branch : null,
    }
  } catch {
    return { repo: value, readme: null, branch: null }
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

export class PackagesAdapter extends SourceAdapter {
  static type = 'packages'
  static displayName = 'Swift Package Catalog'
  static syncMode = 'flat'

  async discover(ctx) {
    if (ctx.db && !ctx.db.getRootBySlug(ROOT_SLUG)) {
      ctx.db.upsertRoot(ROOT_SLUG, 'Swift Package Catalog', 'collection', ROOT_SLUG)
    }

    const limit = packageSyncLimit()
    if (!hasGitHubToken() && limit == null) {
      throw new Error(
        'packages source requires GITHUB_TOKEN or GH_TOKEN for a full sync. ' +
        'Set APPLE_DOCS_PACKAGES_LIMIT to try a smaller unauthenticated sample.',
      )
    }

    const root = ctx.db?.getRootBySlug(ROOT_SLUG) ?? null
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
    for (const url of packageUrls) {
      const parsed = parsePackageUrl(url)
      if (!parsed) continue
      keySet.add(packageKey(parsed.owner, parsed.repo))
      if (limit != null && keySet.size >= limit) break
    }

    if (!hasGitHubToken() && limit != null) {
      ctx.logger?.warn?.(
        `Syncing only the first ${keySet.size} packages without GitHub auth. ` +
        'Set GITHUB_TOKEN or GH_TOKEN for the full catalog.',
      )
    }

    return this.validateDiscoveryResult({
      keys: [...keySet],
      roots: root ? [root] : undefined,
    })
  }

  async fetch(key, ctx) {
    const { owner, repo } = parsePackageKey(key)
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
      },
      etag: JSON.stringify({
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

    const branch = state.branch ?? 'main'
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
    const sourceMetadata = {
      package: true,
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
      sourceMetadata,
    })

    result.document.title = repo.full_name ?? repo.name ?? result.document.title
    result.document.abstractText = repo.description?.trim() || result.document.abstractText
    result.sections = ensureAbstractSection(result.sections, result.document.abstractText)
    result.sections = appendMetadataSection(result.sections, repo, readme)

    return this.validateNormalizeResult(result)
  }
}
