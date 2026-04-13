import { fetchGitHubTree, fetchRawGitHub, checkRawGitHub } from '../lib/github.js'
import { parseMarkdownToSections } from '../content/parse-markdown.js'
import { SourceAdapter } from './base.js'

const OWNER = 'swiftlang'
const REPO = 'swift-book'
const BRANCH = 'main'
const ROOT_SLUG = 'swift-book'
const CONTENT_PREFIX = 'TSPL.docc/'

/**
 * Derive a human-readable chapter title from a DocC-flavored Markdown filename.
 * e.g., 'TheBasics' → 'The Basics', 'StringsAndCharacters' → 'Strings And Characters'
 */
function humanizeFilename(filename) {
  return filename
    .replace(/\.md$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
}

export class SwiftBookAdapter extends SourceAdapter {
  static type = 'swift-book'
  static displayName = 'The Swift Programming Language'
  static syncMode = 'flat'

  async discover(ctx) {
    if (ctx.db && !ctx.db.getRootBySlug(ROOT_SLUG)) {
      ctx.db.upsertRoot(ROOT_SLUG, 'The Swift Programming Language', 'collection', ROOT_SLUG)
    }

    const root = ctx.db?.getRootBySlug(ROOT_SLUG) ?? null
    const tree = await fetchGitHubTree(OWNER, REPO, BRANCH, ctx.rateLimiter)
    const keys = tree
      .filter(entry =>
        entry.type === 'blob' &&
        entry.path.startsWith(CONTENT_PREFIX) &&
        entry.path.endsWith('.md') &&
        !entry.path.includes('/Snippets/') &&
        !entry.path.endsWith('TSPL.md'),
      )
      .map(entry => {
        const relativePath = entry.path
          .replace(CONTENT_PREFIX, '')
          .replace('.md', '')
        return `${ROOT_SLUG}/${relativePath}`
      })

    return this.validateDiscoveryResult({
      keys,
      roots: root ? [root] : undefined,
    })
  }

  async fetch(key, ctx) {
    const relativePath = key.replace(`${ROOT_SLUG}/`, '')
    const { text, etag, lastModified } = await fetchRawGitHub(
      OWNER, REPO, BRANCH,
      `${CONTENT_PREFIX}${relativePath}.md`,
      ctx.rateLimiter,
    )

    return this.validateFetchResult({
      key,
      payload: text,
      etag,
      lastModified,
    })
  }

  async check(key, previousState, ctx) {
    const relativePath = key.replace(`${ROOT_SLUG}/`, '')
    const result = await checkRawGitHub(
      OWNER, REPO, BRANCH,
      `${CONTENT_PREFIX}${relativePath}.md`,
      previousState?.etag ?? null,
      ctx.rateLimiter,
    )

    return this.validateCheckResult({
      status: result.status,
      changed: result.status === 'modified',
      deleted: result.status === 'deleted',
      newState: { etag: result.etag ?? previousState?.etag ?? null },
    })
  }

  normalize(key, rawPayload) {
    const markdown = typeof rawPayload === 'string' ? rawPayload : String(rawPayload)
    const filename = key.split('/').pop()
    const url = `https://docs.swift.org/swift-book/documentation/the-swift-programming-language/${filename?.toLowerCase()}`

    const result = parseMarkdownToSections(markdown, key, {
      sourceType: SwiftBookAdapter.type,
      kind: 'book-chapter',
      framework: ROOT_SLUG,
      url,
    })

    // If no title was extracted from the Markdown, derive from filename
    if (!result.document.title && filename) {
      result.document.title = humanizeFilename(filename)
    }

    return this.validateNormalizeResult(result)
  }
}
