import { fetchGitHubTree, fetchRawGitHub, checkRawGitHub } from '../lib/github.js'
import { parseMarkdownToSections, splitByHeadings } from '../content/parse-markdown.js'
import { SourceAdapter } from './base.js'
import { addEntryPoints } from './entry-points.js'

const OWNER = 'swiftlang'
const REPO = 'swift-book'
const BRANCH = 'main'
const ROOT_SLUG = 'swift-book'
const CONTENT_PREFIX = 'TSPL.docc/'
const ROOT_FILE = 'The-Swift-Programming-Language'

const DOC_REF_REGEX = /<doc:([A-Za-z0-9_-]+)>/g

const BOOK_SECTION_TITLES = {
  GuidedTour: 'Welcome to Swift',
  LanguageGuide: 'Language Guide',
  ReferenceManual: 'Language Reference',
  RevisionHistory: 'Revision History',
}

function humanizeFilename(filename) {
  return filename
    .replace(/\.md$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
}

/**
 * The TOC root file uses bare `<doc:ChapterName>` references, but each chapter
 * physically lives under a section directory (GuidedTour/, LanguageGuide/,
 * ReferenceManual/, RevisionHistory/). This map lets us resolve those refs.
 */
function buildChapterIndex(keys) {
  const index = new Map()
  for (const key of keys) {
    const path = key.replace(`${ROOT_SLUG}/`, '')
    const filename = path.split('/').pop()
    if (!filename || filename === ROOT_FILE) continue
    index.set(filename.toLowerCase(), key)
  }
  return index
}

/**
 * Parse the root TOC markdown into a list of grouped topic sections.
 *
 * Recognizes DocC-flavored Markdown of the shape:
 *   ## Topics
 *   ### Group Name
 *   - <doc:ChapterName>
 *   - <doc:OtherChapter>
 */
export function parseBookTopics(markdown) {
  if (typeof markdown !== 'string' || !markdown) return []

  const topics = splitByHeadings(markdown, 2).find(s => s.heading === 'Topics')
  if (!topics) return []

  const groups = []
  for (const sub of splitByHeadings(topics.content, 3)) {
    if (!sub.heading) continue
    const items = []
    for (const m of sub.content.matchAll(DOC_REF_REGEX)) {
      items.push(m[1])
    }
    if (items.length > 0) groups.push({ title: sub.heading, items })
  }
  return groups
}

export class SwiftBookAdapter extends SourceAdapter {
  static type = 'swift-book'
  static displayName = 'The Swift Programming Language'
  static syncMode = 'flat'

  /** @type {import('./entry-points.js').EntryPoint[]} */
  static entryPoints = [{
    slug: ROOT_SLUG,
    key: `${ROOT_SLUG}/${ROOT_FILE}`,
    title: 'The Swift Programming Language',
    summary: 'The canonical Swift language guide and reference manual.',
    parents: ['swift-org/documentation', 'swift-org/documentation/tspl'],
  }]

  constructor() {
    super()
    // Populated by discover(); read by normalize() on the same instance.
    // Flat-sync only — non-adapter normalize callers (pipeline/persist.js)
    // do not see this state.
    /** @type {Map<string, string>} chapter file basename (lowercased) → full key */
    this.chapterIndex = new Map()
  }

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
        !entry.path.includes('/Snippets/'),
      )
      .map(entry => {
        const relativePath = entry.path
          .replace(CONTENT_PREFIX, '')
          .replace('.md', '')
        return `${ROOT_SLUG}/${relativePath}`
      })

    this.chapterIndex = buildChapterIndex(keys)

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
    const isRoot = filename === ROOT_FILE
    const url = isRoot
      ? 'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/'
      : `https://docs.swift.org/swift-book/documentation/the-swift-programming-language/${filename?.toLowerCase()}`

    const result = parseMarkdownToSections(markdown, key, {
      sourceType: SwiftBookAdapter.type,
      kind: isRoot ? 'collection' : 'book-chapter',
      framework: ROOT_SLUG,
      url,
    })

    if (!result.document.title && filename) {
      result.document.title = humanizeFilename(filename)
    }

    if (isRoot) {
      this.applyRootTopics(result, markdown, key)
    } else {
      this.applyChapterMetadata(result, key)
    }

    return this.validateNormalizeResult(result)
  }

  /**
   * Replace the auto-extracted "Topics" discussion section with a structured
   * `topics` section grouped by `### Group Name`, and emit `child` relationships
   * from the root to each chapter file. Chapters not yet discovered (e.g. the
   * grammar summary, which has no markdown source) are still listed in the
   * topics section but skipped from the relationships table.
   */
  applyRootTopics(result, markdown, rootKey) {
    const groups = parseBookTopics(markdown)
    if (groups.length === 0) return

    // Drop the auto-generated discussion section whose heading is "Topics" —
    // the structured topics section below replaces it.
    result.sections = result.sections.filter(s =>
      !(s.sectionKind === 'discussion' && s.heading === 'Topics')
    )

    const order = result.sections.length === 0
      ? 0
      : Math.max(...result.sections.map(s => s.sortOrder ?? 0)) + 1

    const linkSections = groups.map(group => ({
      title: group.title,
      type: null,
      items: group.items.map(chapterName => ({
        identifier: `swift-book://${chapterName}`,
        key: this.chapterIndex.get(chapterName.toLowerCase()) ?? null,
        title: humanizeFilename(chapterName),
      })),
    }))

    const contentText = linkSections
      .map(g => [g.title, ...g.items.map(it => it.title)].join('\n'))
      .join('\n')

    result.sections.push({
      sectionKind: 'topics',
      heading: 'Topics',
      contentText: contentText || null,
      contentJson: JSON.stringify(linkSections),
      sortOrder: order,
    })

    // Emit child relationships in TOC order so the rendered hierarchy matches the book.
    let relOrder = 0
    for (const group of groups) {
      for (const chapterName of group.items) {
        const toKey = this.chapterIndex.get(chapterName.toLowerCase())
        if (!toKey) continue
        result.relationships.push({
          fromKey: rootKey,
          toKey,
          relationType: 'child',
          section: group.title,
          sortOrder: relOrder++,
        })
      }
    }
  }

  /**
   * Tag chapter pages with their TSPL section group derived from the directory
   * (GuidedTour, LanguageGuide, ReferenceManual, RevisionHistory). Stored in
   * sourceMetadata so the renderer can show breadcrumbs / "in section X".
   */
  applyChapterMetadata(result, key) {
    const path = key.replace(`${ROOT_SLUG}/`, '')
    const dir = path.includes('/') ? path.split('/')[0] : null
    const sectionTitle = dir ? BOOK_SECTION_TITLES[dir] : null
    if (!sectionTitle) return
    const metadata = result.document.sourceMetadata
      ? JSON.parse(result.document.sourceMetadata)
      : {}
    metadata.bookSection = sectionTitle
    metadata.bookSectionDir = dir
    result.document.sourceMetadata = JSON.stringify(metadata)
  }

  renderHints() {
    return { showChapterNumbers: true }
  }
}

addEntryPoints(SwiftBookAdapter.entryPoints)
