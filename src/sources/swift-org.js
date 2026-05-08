import { fetchHtmlPage, checkHtmlPage } from '../apple/api.js'
import { parseHtmlToNormalized } from '../content/parse-html.js'
import { SourceAdapter } from './base.js'
import { getEntryPointsForParent } from './entry-points.js'

const ROOT_SLUG = 'swift-org'

/**
 * Curated list of Swift.org HTML pages.
 *
 * Excludes pages that are now redirects to DocC archives (handled by the
 * `swift-docc` adapter): /documentation/concurrency → swift-migration-guide,
 * /documentation/package-manager → swift-package-manager.
 */
const CURATED_PATHS = [
  // Top-level documentation hubs
  'documentation',
  'documentation/api-design-guidelines',
  'documentation/standard-library',
  'documentation/core-libraries',
  'documentation/cxx-interop',
  'documentation/docc',
  'documentation/server',
  'documentation/swift-compiler',
  'documentation/lldb',
  'documentation/tspl',
  'documentation/continuous-integration',
  'documentation/source-code',
  'documentation/source-compatibility',
  'documentation/monthly-non-darwin-release',

  // Server guides — note .html suffix is required by swift.org
  'documentation/server/guides/allocations.html',
  'documentation/server/guides/building.html',
  'documentation/server/guides/deployment.html',
  'documentation/server/guides/llvm-sanitizers.html',
  'documentation/server/guides/memory-leaks-and-usage.html',
  'documentation/server/guides/packaging.html',
  'documentation/server/guides/passkeys.html',
  'documentation/server/guides/performance.html',
  'documentation/server/guides/testing.html',
  'documentation/server/guides/libraries/concurrency-adoption-guidelines.html',
  'documentation/server/guides/libraries/log-levels.html',

  // Articles
  'documentation/articles/value-and-reference-types.html',
  'documentation/articles/getting-started-with-vscode-swift.html',
  'documentation/articles/getting-started-with-cursor-swift.html',
  'documentation/articles/static-linux-getting-started.html',
  'documentation/articles/swift-sdk-for-android-getting-started.html',
  'documentation/articles/wasm-getting-started.html',
  'documentation/articles/zero-to-swift-emacs.html',
  'documentation/articles/zero-to-swift-nvim.html',
  'documentation/articles/wrapping-c-cpp-library-in-swift.html',

  // Getting started
  'getting-started',
  'getting-started/cli-swiftpm',
  'getting-started/library-swiftpm',
  'getting-started/swiftui',
  'getting-started/vapor-web-server',

  // Install
  'install',
  'install/linux',
  'install/macos',
  'install/windows',

  // Community / project pages
  'community',
  'community/how-we-work',
  'contributing',
  'about',
  'platform-support',
  'code-of-conduct',
  'diversity',
  'mentorship',
  'packages',
  'sswg',
  'sswg/incubation-process.html',
  'support/security.html',
  'openapi',
]

/**
 * Set of curated path strings (e.g. `documentation/api-design-guidelines`,
 * `getting-started/cli-swiftpm`) for fast O(1) lookup during link rewriting.
 * Trailing slashes and leading `/` are normalized away first.
 */
const CURATED_PATH_SET = new Set(CURATED_PATHS)

/**
 * swift.org URLs that no longer point at swift-org content but at one of the
 * external DocC archives served by the `swift-docc` adapter. Map them to
 * their corpus-internal equivalents so links don't break or redirect.
 */
const SWIFT_ORG_REDIRECTS = {
  'documentation/concurrency':       'swift-migration-guide/documentation/migrationguide',
  'documentation/concurrency/':      'swift-migration-guide/documentation/migrationguide',
  'documentation/package-manager':   'swift-package-manager/documentation/packagemanagerdocs',
  'documentation/package-manager/':  'swift-package-manager/documentation/packagemanagerdocs',
  'documentation/tspl':              'swift-book/The-Swift-Programming-Language',
  'documentation/tspl/':             'swift-book/The-Swift-Programming-Language',
}

/**
 * Build a link resolver that rewrites swift.org URLs to corpus-internal
 * `/docs/...` routes when the target is in our corpus, and absolutizes
 * relative URLs otherwise so they survive the move off `swift.org`.
 *
 * @param {string} sourceUrl Absolute URL of the page being parsed.
 * @returns {(href: string) => string|null}
 */
function makeSwiftOrgLinkResolver(sourceUrl) {
  let base
  try { base = new URL(sourceUrl) } catch { base = null }

  return (rawHref) => {
    if (!rawHref || typeof rawHref !== 'string') return rawHref
    // Mailto, tel, javascript, fragments, data — leave alone.
    if (/^(?:mailto:|tel:|javascript:|data:|#)/i.test(rawHref)) return rawHref

    let abs
    try {
      abs = base ? new URL(rawHref, base) : new URL(rawHref)
    } catch {
      return rawHref
    }

    // Map to corpus-internal route only when the target is on swift.org.
    const isSwiftOrg = abs.hostname === 'swift.org' || abs.hostname === 'www.swift.org'
    if (isSwiftOrg) {
      const path = abs.pathname.replace(/^\/+/, '')
      const noTrail = path.replace(/\/+$/, '')
      const redirect = SWIFT_ORG_REDIRECTS[path] ?? SWIFT_ORG_REDIRECTS[`${noTrail}/`]
      if (redirect) {
        return `/docs/${redirect}/${abs.hash}`
      }
      // Direct match in swift-org curated list (with or without trailing slash).
      if (CURATED_PATH_SET.has(noTrail)) {
        return `/docs/${ROOT_SLUG}/${noTrail}/${abs.hash}`
      }
      if (CURATED_PATH_SET.has(path)) {
        return `/docs/${ROOT_SLUG}/${path}/${abs.hash}`
      }
      // Strip trailing slash variant when the curated path includes the .html suffix.
      if (CURATED_PATH_SET.has(`${noTrail}.html`)) {
        return `/docs/${ROOT_SLUG}/${noTrail}.html/${abs.hash}`
      }
    }

    // docs.swift.org/swift-book/* → /docs/swift-book/* — TSPL chapters live there.
    if (abs.hostname === 'docs.swift.org' && abs.pathname.startsWith('/swift-book/')) {
      return `/docs/swift-book${abs.pathname.replace(/^\/swift-book/, '')}${abs.hash}`
    }

    // Otherwise return the absolute URL — it's external content. The
    // important fix is that relative `/install` becomes
    // `https://swift.org/install` instead of resolving against our host.
    return abs.toString()
  }
}

export class SwiftOrgAdapter extends SourceAdapter {
  static type = 'swift-org'
  static displayName = 'Swift.org Documentation'
  static syncMode = 'flat'

  async discover(ctx) {
    if (ctx.db && !ctx.db.getRootBySlug(ROOT_SLUG)) {
      ctx.db.upsertRoot(ROOT_SLUG, 'Swift.org Documentation', 'collection', ROOT_SLUG)
    }

    const root = ctx.db?.getRootBySlug(ROOT_SLUG) ?? null
    const keys = CURATED_PATHS.map(path => `${ROOT_SLUG}/${path}`)

    return this.validateDiscoveryResult({
      keys,
      roots: root ? [root] : undefined,
    })
  }

  async fetch(key, ctx) {
    const url = `https://swift.org/${key.replace(`${ROOT_SLUG}/`, '')}`
    const { html, etag, lastModified } = await fetchHtmlPage(url, ctx.rateLimiter)

    return this.validateFetchResult({
      key,
      payload: html,
      etag,
      lastModified,
    })
  }

  async check(key, previousState, ctx) {
    const url = `https://swift.org/${key.replace(`${ROOT_SLUG}/`, '')}`
    const result = await checkHtmlPage(url, previousState?.etag ?? null, ctx.rateLimiter)

    return this.validateCheckResult({
      status: result.status,
      changed: result.status === 'modified',
      deleted: result.status === 'deleted',
      newState: { etag: result.etag ?? previousState?.etag ?? null },
    })
  }

  normalize(key, rawPayload) {
    const html = typeof rawPayload === 'string' ? rawPayload : String(rawPayload)
    const url = `https://swift.org/${key.replace(`${ROOT_SLUG}/`, '')}`

    const result = parseHtmlToNormalized(html, key, {
      sourceType: SwiftOrgAdapter.type,
      kind: 'article',
      framework: ROOT_SLUG,
      url,
      preserveStructure: true,
      linkResolver: makeSwiftOrgLinkResolver(url),
    })

    // Swift.org HTML titles end with " | Swift.org"; strip the brand suffix.
    if (result.document.title) {
      result.document.title = result.document.title.replace(/\s*[|\-—]\s*Swift\.org\s*$/i, '').trim() || result.document.title
    }

    this.applyArchiveCrossLinks(result, key)

    return this.validateNormalizeResult(result)
  }

  /**
   * Inject a "Related Documentation" topics section by querying the cross-source
   * entry-point registry. Any adapter that registers an entry point with
   * `parents` containing this page's key will be linked here automatically.
   */
  applyArchiveCrossLinks(result, key) {
    const links = getEntryPointsForParent(key)
    if (links.length === 0) return

    const order = result.sections.length === 0
      ? 0
      : Math.max(...result.sections.map(s => s.sortOrder ?? 0)) + 1

    const items = links.map(link => ({
      identifier: link.key,
      key: link.key,
      title: link.title,
      abstract: link.summary
        ? [{ type: 'text', text: link.summary }]
        : null,
    }))

    const contentText = links
      .map(l => `${l.title}: ${l.summary ?? ''}`.trim())
      .join('\n')

    result.sections.push({
      sectionKind: 'topics',
      heading: 'Related Documentation',
      contentText,
      contentJson: JSON.stringify([{
        title: 'Related Documentation',
        type: null,
        items,
      }]),
      sortOrder: order,
    })

    let relOrder = result.relationships.length
    for (const link of links) {
      result.relationships.push({
        fromKey: key,
        toKey: link.key,
        relationType: 'see_also',
        section: 'Related Documentation',
        sortOrder: relOrder++,
      })
    }
  }

  renderHints() {
    return {}
  }
}
