import { fetchWithRetry, checkResourceEtag } from '../lib/fetch-with-retry.js'
import { normalize } from '../content/normalize.js'
import { extractReferences } from '../apple/extractor.js'
import { extractRootSlug } from '../apple/normalizer.js'
import { SourceAdapter } from './base.js'
import { addEntryPoints } from './entry-points.js'

const USER_AGENT = 'apple-docs-mcp/1.0'
const DEFAULT_TIMEOUT = Number.parseInt(process.env.APPLE_DOCS_TIMEOUT ?? '30000', 10)
const HTTP_OPTS = { headers: { 'User-Agent': USER_AGENT }, timeout: DEFAULT_TIMEOUT }

/**
 * DocC archives published outside developer.apple.com that share the same
 * JSON schema. Each archive becomes its own root in the corpus.
 *
 * Key format: `<slug>/documentation/<archive-internal-path>`
 * Internal paths come from the archive's own `index/index.json`.
 */
export const ARCHIVES = {
  'swift-compiler': {
    displayName: 'Swift Compiler',
    kind: 'tooling',
    baseUrl: 'https://docs.swift.org/compiler',
    entryKey: 'swift-compiler/documentation/diagnostics',
    entryTitle: 'Swift Compiler Diagnostics',
    entrySummary: 'Reference for warnings and errors emitted by the Swift compiler, including diagnostic groups and upcoming language features.',
    parents: ['swift-org/documentation', 'swift-org/documentation/swift-compiler'],
  },
  'swift-package-manager': {
    displayName: 'Swift Package Manager',
    kind: 'tooling',
    baseUrl: 'https://docs.swift.org/swiftpm',
    entryKey: 'swift-package-manager/documentation/packagemanagerdocs',
    entryTitle: 'Swift Package Manager',
    entrySummary: 'Full reference for the Swift Package Manager: package manifests, dependencies, build settings, and plug-in APIs.',
    parents: ['swift-org/documentation', 'swift-org/getting-started'],
  },
  'swift-migration-guide': {
    displayName: 'Swift 6 Concurrency Migration Guide',
    kind: 'guide',
    baseUrl: 'https://www.swift.org/migration',
    entryKey: 'swift-migration-guide/documentation/migrationguide',
    entryTitle: 'Swift 6 Concurrency Migration Guide',
    entrySummary: 'How to migrate existing Swift code to the Swift 6 concurrency model, including data-race safety and incremental adoption.',
    parents: ['swift-org/documentation'],
  },
}

const indexUrl = (archive) => `${archive.baseUrl}/index/index.json`
const dataUrl = (archive, path) => `${archive.baseUrl}/data${path}.json`
const pageUrl = (archive, path) => `${archive.baseUrl}${path}`

export function collectIndexPaths(index) {
  const out = []
  const swift = index?.interfaceLanguages?.swift
  if (!Array.isArray(swift)) return out

  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.path === 'string') out.push(node.path)
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child)
    }
  }
  for (const node of swift) walk(node)
  return out
}

export function pathToKey(slug, internalPath) {
  const trimmed = internalPath.startsWith('/') ? internalPath.slice(1) : internalPath
  return `${slug}/${trimmed.toLowerCase()}`
}

export function keyToPath(slug, key) {
  const prefix = `${slug}/`
  if (!key.startsWith(prefix)) {
    throw new Error(`Key '${key}' does not belong to archive '${slug}'`)
  }
  return `/${key.slice(prefix.length)}`
}

function archiveForKey(key) {
  const slug = extractRootSlug(key)
  const archive = ARCHIVES[slug]
  if (!archive) throw new Error(`Unknown swift-docc archive slug: ${slug}`)
  return { slug, archive, path: keyToPath(slug, key) }
}

export class SwiftDoccAdapter extends SourceAdapter {
  static type = 'swift-docc'
  static displayName = 'Swift Documentation Archives'
  static syncMode = 'flat'

  /** @type {import('./entry-points.js').EntryPoint[]} */
  static entryPoints = Object.entries(ARCHIVES).map(([slug, archive]) => ({
    slug,
    key: archive.entryKey,
    title: archive.entryTitle,
    summary: archive.entrySummary,
    parents: archive.parents ?? [],
  }))

  async discover(ctx) {
    const entries = Object.entries(ARCHIVES)

    const allRoots = []
    for (const [slug, archive] of entries) {
      if (ctx.db && !ctx.db.getRootBySlug(slug)) {
        ctx.db.upsertRoot(slug, archive.displayName, archive.kind, SwiftDoccAdapter.type)
      }
      const root = ctx.db?.getRootBySlug(slug) ?? null
      if (root) allRoots.push(root)
    }

    const indexResults = await Promise.all(entries.map(async ([slug, archive]) => {
      try {
        const { data } = await fetchWithRetry(indexUrl(archive), ctx.rateLimiter, HTTP_OPTS)
        return { slug, paths: collectIndexPaths(data) }
      } catch (e) {
        ctx.logger?.warn?.(`swift-docc: failed to discover ${slug}`, { error: e.message })
        return { slug, paths: [] }
      }
    }))

    const allKeys = []
    for (const { slug, paths } of indexResults) {
      for (const p of paths) allKeys.push(pathToKey(slug, p))
    }

    return this.validateDiscoveryResult({ keys: allKeys, roots: allRoots })
  }

  async fetch(key, ctx) {
    const { archive, path } = archiveForKey(key)
    const { data, etag, lastModified } = await fetchWithRetry(dataUrl(archive, path), ctx.rateLimiter, HTTP_OPTS)
    return this.validateFetchResult({ key, payload: data, etag, lastModified })
  }

  async check(key, previousState, ctx) {
    const { archive, path } = archiveForKey(key)
    const result = await checkResourceEtag(dataUrl(archive, path), previousState?.etag ?? null, ctx.rateLimiter, HTTP_OPTS)
    return this.validateCheckResult({
      status: result.status,
      changed: result.status === 'modified',
      deleted: result.status === 'deleted',
      newState: { etag: result.etag ?? previousState?.etag ?? null },
    })
  }

  normalize(key, rawPayload) {
    const { slug, archive } = archiveForKey(key)
    const json = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload

    // The shared DocC normalizer would build a developer.apple.com URL and
    // resolve refs to un-prefixed paths like 'diagnostics/foo'. Override both
    // so URLs point at docs.swift.org and refs use our scoped storage keys.
    const result = normalize(json, key, SwiftDoccAdapter.type, {
      urlBuilder: (k) => pageUrl(archive, keyToPath(slug, k)),
      keyMapper: (internalKey) => addArchivePrefix(slug, internalKey),
    })

    // The shared normalizer derives `framework` from the first key segment, which
    // is the slug we want — but the underlying source type should be 'swift-docc'.
    result.document.sourceType = SwiftDoccAdapter.type
    return this.validateNormalizeResult(result)
  }

  extractReferences(key, rawPayload) {
    const { slug } = archiveForKey(key)
    const json = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload
    return extractReferences(json).map(ref => addArchivePrefix(slug, ref))
  }

  renderHints() {
    return { showPlatformBadges: false, showSourceArchive: true }
  }
}

addEntryPoints(SwiftDoccAdapter.entryPoints)

/**
 * The shared normalizer reduces references to paths like 'diagnostics/foo'
 * (no leading 'documentation/'). Restore that segment and prepend the archive
 * slug to produce our scoped storage keys.
 */
function addArchivePrefix(slug, internalKey) {
  if (!internalKey) return internalKey
  if (internalKey.startsWith(`${slug}/`)) return internalKey
  return `${slug}/documentation/${internalKey}`
}
