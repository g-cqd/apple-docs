import { fetchGitHubTree, fetchRawGitHub, checkRawGitHub } from '../lib/github.js'
import { parseMarkdownToSections } from '../content/parse-markdown.js'
import { SourceAdapter } from './base.js'

const OWNER = 'swiftlang'
const REPO = 'swift-evolution'
const BRANCH = 'main'
const ROOT_SLUG = 'swift-evolution'

/**
 * Parse the structured header of a Swift Evolution proposal.
 *
 * SE proposals have headers like:
 *   # Feature Name
 *   * Proposal: [SE-0001](0001-keywords.md)
 *   * Authors: [Chris Lattner](url)
 *   * Review Manager: [Name](url)
 *   * Status: **Accepted**
 *   * Implementation: [apple/swift#12345](url)
 */
function parseProposalHeader(markdown) {
  const meta = {
    seNumber: null,
    status: null,
    swiftVersion: null,
    authors: null,
    reviewManager: null,
  }

  // SE number: * Proposal: [SE-NNNN] or * Proposal: SE-NNNN
  const seMatch = markdown.match(/\*\s*Proposal:\s*\[?(SE-\d+)\]?/i)
  if (seMatch) meta.seNumber = seMatch[1]

  // Status: * Status: **Accepted** or * Status: Accepted
  const statusMatch = markdown.match(/\*\s*Status:\s*\*{0,2}(.+?)\*{0,2}\s*$/m)
  if (statusMatch) meta.status = statusMatch[1].replace(/\*+/g, '').trim()

  // Swift version: * Implementation: Swift X.Y or * Implemented (Swift X.Y)
  const versionMatch = markdown.match(/Swift\s+(\d+\.\d+(?:\.\d+)?)/i)
  if (versionMatch) meta.swiftVersion = versionMatch[1]

  // Authors: * Authors: [Name](url), [Name2](url)
  const authorsMatch = markdown.match(/\*\s*Authors?:\s*(.+)$/m)
  if (authorsMatch) {
    const raw = authorsMatch[1]
    const names = []
    for (const m of raw.matchAll(/\[([^\]]+)\]/g)) {
      names.push(m[1])
    }
    if (names.length > 0) {
      meta.authors = names.join(', ')
    } else {
      meta.authors = raw.replace(/[[\]()]/g, '').trim()
    }
  }

  // Review Manager
  const rmMatch = markdown.match(/\*\s*Review Manager:\s*(.+)$/m)
  if (rmMatch) {
    const linkMatch = rmMatch[1].match(/\[([^\]]+)\]/)
    meta.reviewManager = linkMatch ? linkMatch[1] : rmMatch[1].trim()
  }

  return meta
}

export class SwiftEvolutionAdapter extends SourceAdapter {
  static type = 'swift-evolution'
  static displayName = 'Swift Evolution Proposals'
  static syncMode = 'flat'

  async discover(ctx) {
    if (ctx.db && !ctx.db.getRootBySlug(ROOT_SLUG)) {
      ctx.db.upsertRoot(ROOT_SLUG, 'Swift Evolution Proposals', 'collection', ROOT_SLUG)
    }

    const root = ctx.db?.getRootBySlug(ROOT_SLUG) ?? null
    const tree = await fetchGitHubTree(OWNER, REPO, BRANCH, ctx.rateLimiter)
    const keys = tree
      .filter(entry => entry.type === 'blob' && entry.path.startsWith('proposals/') && entry.path.endsWith('.md'))
      .map(entry => {
        const filename = entry.path.replace('proposals/', '').replace('.md', '')
        return `${ROOT_SLUG}/${filename}`
      })

    return this.validateDiscoveryResult({
      keys,
      roots: root ? [root] : undefined,
    })
  }

  async fetch(key, ctx) {
    const filename = key.replace(`${ROOT_SLUG}/`, '')
    const { text, etag, lastModified } = await fetchRawGitHub(
      OWNER, REPO, BRANCH,
      `proposals/${filename}.md`,
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
    const filename = key.replace(`${ROOT_SLUG}/`, '')
    const result = await checkRawGitHub(
      OWNER, REPO, BRANCH,
      `proposals/${filename}.md`,
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
    const header = parseProposalHeader(markdown)

    const seNumber = header.seNumber ?? key.split('/').pop()?.toUpperCase()
    const url = `https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/proposals/${key.replace(`${ROOT_SLUG}/`, '')}.md`

    const result = parseMarkdownToSections(markdown, key, {
      sourceType: SwiftEvolutionAdapter.type,
      kind: 'proposal',
      framework: ROOT_SLUG,
      url,
      sourceMetadata: JSON.stringify(header),
    })

    // Override title to include SE number if not already present
    if (result.document.title && seNumber && !result.document.title.includes(seNumber)) {
      result.document.title = `${seNumber}: ${result.document.title}`
    }

    return this.validateNormalizeResult(result)
  }

  renderHints() {
    return { showSENumber: true }
  }
}
