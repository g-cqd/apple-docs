/**
 * Scope-specific grouping for the remaining collection-style roots —
 * App Store Review's numbered sections, release-notes versions, the
 * Swift book's parts, package owners, technote numbers, the archive's
 * legacy categories, and HIG categories. Pure functions over the page
 * list (plus a prebuilt child→category map for HIG, since that
 * structure lives in document relationships, not paths).
 */

import { slugify } from '../../content/render-html.js'

function docTitle(doc) {
  return String(doc?.title ?? doc?.key ?? doc?.path ?? '')
}

function byTitle(a, b) {
  return docTitle(a).localeCompare(docTitle(b))
}

function lastSegment(doc) {
  const path = String(doc?.path ?? doc?.key ?? '')
  return path.slice(path.lastIndexOf('/') + 1)
}

function numericParts(s) {
  return String(s)
    .split(/[._]/)
    .map((n) => Number.parseInt(n, 10))
    .filter(Number.isFinite)
}

function compareNumericParts(a, b) {
  const pa = numericParts(a)
  const pb = numericParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * App Store Review Guidelines: `app-store-review/1.2` style paths with
 * "1.2 User-Generated Content" titles. Sections per top-level number,
 * labelled by the section page's own title ("1. Safety"), rules in
 * numeric order (1.2 before 1.10) with the section page first.
 */
export function groupGuidelinesBySection(docs) {
  const bySection = new Map()
  const rest = []
  for (const doc of docs ?? []) {
    const seg = lastSegment(doc)
    const m = /^(\d+)(?:\.\d+)*$/.exec(seg)
    if (!m) {
      rest.push(doc)
      continue
    }
    const section = Number(m[1])
    if (!bySection.has(section)) bySection.set(section, [])
    bySection.get(section).push(doc)
  }
  const sections = [...bySection.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([section, sectionDocs]) => {
      sectionDocs.sort((a, b) => compareNumericParts(lastSegment(a), lastSegment(b)))
      const header = sectionDocs.find((d) => lastSegment(d) === String(section))
      return {
        id: `section-${section}`,
        label: header ? docTitle(header) : `Section ${section}`,
        count: sectionDocs.length,
        docs: sectionDocs,
      }
    })
  if (rest.length > 0) {
    sections.push({ id: 'section-other', label: 'Other', count: rest.length, docs: rest.sort(byTitle) })
  }
  return sections
}

const VERSION_IN_TITLE = /(\d+(?:[._]\d+)*)/

/**
 * Release notes: group by major version parsed from the title
 * ("iOS 18.2 Release Notes" → "iOS 18"), newest major first, newest
 * version first within a group. Versionless pages (e.g. "Foundation
 * Release Notes") land in a trailing "Other" section.
 */
export function groupReleaseNotesByVersion(docs) {
  const byMajor = new Map()
  const rest = []
  for (const doc of docs ?? []) {
    const title = docTitle(doc)
    const m = VERSION_IN_TITLE.exec(title)
    if (!m) {
      rest.push(doc)
      continue
    }
    const major = numericParts(m[1])[0]
    const product = title.slice(0, m.index).trim()
    if (!byMajor.has(major)) byMajor.set(major, { product, docs: [] })
    const group = byMajor.get(major)
    if (!group.product && product) group.product = product
    group.docs.push({ doc, version: m[1] })
  }
  const sections = [...byMajor.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([major, group]) => ({
      id: `v-${major}`,
      label: group.product ? `${group.product} ${major}` : `Version ${major}`,
      count: group.docs.length,
      docs: group.docs.sort((a, b) => compareNumericParts(b.version, a.version)).map((entry) => entry.doc),
    }))
  if (rest.length > 0) {
    sections.push({ id: 'v-other', label: 'Other', count: rest.length, docs: rest.sort(byTitle) })
  }
  return sections
}

// Book parts in reading order; path shape swift-book/<Part>/<Chapter>.
const SWIFT_BOOK_PARTS = new Map([
  ['The-Swift-Programming-Language', 'Welcome to Swift'],
  ['GuidedTour', 'A Swift Tour'],
  ['LanguageGuide', 'Language Guide'],
  ['ReferenceManual', 'Language Reference'],
  ['RevisionHistory', 'Revision History'],
])

/** The Swift book: one section per book part, in reading order. */
export function groupSwiftBookByPart(docs) {
  const byPart = new Map()
  for (const doc of docs ?? []) {
    const part = String(doc?.path ?? '').split('/')[1] ?? ''
    const label = SWIFT_BOOK_PARTS.get(part) ?? (part || 'Other')
    if (!byPart.has(label)) byPart.set(label, [])
    byPart.get(label).push(doc)
  }
  const order = new Map([...SWIFT_BOOK_PARTS.values()].map((label, i) => [label, i]))
  return [...byPart.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99) || a[0].localeCompare(b[0]))
    .map(([label, partDocs]) => ({
      id: `part-${slugify(label)}`,
      label,
      count: partDocs.length,
      docs: partDocs.sort(byTitle),
    }))
}

/**
 * Swift package catalog: `packages/<owner>/<repo>` grouped by owner,
 * largest catalogs first so apple/swiftlang/vapor surface at the top.
 */
export function groupPackagesByOwner(docs) {
  const byOwner = new Map()
  const rest = []
  for (const doc of docs ?? []) {
    const owner = String(doc?.path ?? '').split('/')[1]
    if (!owner) {
      rest.push(doc)
      continue
    }
    if (!byOwner.has(owner)) byOwner.set(owner, [])
    byOwner.get(owner).push(doc)
  }
  const sections = [...byOwner.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([owner, ownerDocs]) => ({
      id: `owner-${slugify(owner)}`,
      label: owner,
      count: ownerDocs.length,
      docs: ownerDocs.sort(byTitle),
    }))
  if (rest.length > 0) {
    sections.push({ id: 'owner-other', label: 'Other', count: rest.length, docs: rest.sort(byTitle) })
  }
  return sections
}

const TN_NUMBER = /TN(\d+)/i

/** Technotes: a single section, newest TN number first. */
export function sortTechnotes(docs) {
  const items = [...(docs ?? [])].sort((a, b) => {
    const ta = TN_NUMBER.exec(docTitle(a))
    const tb = TN_NUMBER.exec(docTitle(b))
    if (ta && tb) return Number(tb[1]) - Number(ta[1])
    if (ta) return -1
    if (tb) return 1
    return byTitle(a, b)
  })
  return [{ id: 'technotes-all', label: 'All technotes — newest first', count: items.length, docs: items }]
}

// Legacy archive categories are concatenated lowercase words; the
// common ones get a readable label, the long tail a capital letter.
const ARCHIVE_LABELS = new Map([
  ['cocoa', 'Cocoa'],
  ['carbon', 'Carbon'],
  ['quicktime', 'QuickTime'],
  ['webobjects', 'WebObjects'],
  ['appleapplications', 'Apple Applications'],
  ['graphicsimaging', 'Graphics & Imaging'],
  ['networkinginternet', 'Networking & Internet'],
  ['hardwaredrivers', 'Hardware & Drivers'],
  ['devicedrivers', 'Device Drivers'],
  ['developertools', 'Developer Tools'],
  ['userexperience', 'User Experience'],
  ['internetweb', 'Internet & Web'],
  ['macosx', 'Mac OS X'],
])

/**
 * Apple Developer Archive: the crawl preserves each document's legacy
 * technology category in `framework` (cocoa, carbon, quicktime, ...)
 * even though no root carries those slugs — group by it, biggest
 * categories first.
 */
export function groupArchiveByCategory(docs) {
  const byCategory = new Map()
  for (const doc of docs ?? []) {
    const raw = String(doc?.framework ?? '')
      .trim()
      .toLowerCase()
    const label = raw ? (ARCHIVE_LABELS.get(raw) ?? raw.charAt(0).toUpperCase() + raw.slice(1)) : 'Other'
    if (!byCategory.has(label)) byCategory.set(label, [])
    byCategory.get(label).push(doc)
  }
  return [...byCategory.entries()]
    .sort((a, b) => {
      if (a[0] === 'Other') return 1
      if (b[0] === 'Other') return -1
      return b[1].length - a[1].length || a[0].localeCompare(b[0])
    })
    .map(([label, categoryDocs]) => ({
      id: `cat-${slugify(label)}`,
      label,
      count: categoryDocs.length,
      docs: categoryDocs.sort(byTitle),
    }))
}

/**
 * Human Interface Guidelines: topics grouped by their category page
 * (Foundations, Patterns, Components subgroups, ...). The membership
 * lives in document relationships, so callers pass the prebuilt
 * `higGroups` map (topic path → { label, order }); see
 * src/web/scope-group-data.js. Category pages head their own section.
 */
export function groupHigByCategory(docs, higGroups) {
  if (!(higGroups instanceof Map) || higGroups.size === 0) return null
  const sections = new Map()
  const rest = []
  const parentPaths = new Map([...higGroups.values()].map((g) => [g.parentPath, g]))
  for (const doc of docs ?? []) {
    const path = String(doc?.path ?? '')
    const own = parentPaths.get(path)
    const membership = higGroups.get(path)
    const group = own ?? membership
    if (!group) {
      rest.push(doc)
      continue
    }
    if (!sections.has(group.label)) sections.set(group.label, { order: group.order, header: null, docs: [] })
    const section = sections.get(group.label)
    if (own) section.header = doc
    else section.docs.push(doc)
  }
  const out = [...sections.entries()]
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
    .map(([label, section]) => {
      const items = section.docs.sort(byTitle)
      if (section.header) items.unshift(section.header)
      return { id: `hig-${slugify(label)}`, label, count: items.length, docs: items }
    })
  if (rest.length > 0) {
    out.push({ id: 'hig-other', label: 'Other', count: rest.length, docs: rest.sort(byTitle) })
  }
  return out
}
