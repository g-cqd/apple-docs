// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * Scope-aware grouping for framework listing pages. Non-framework roots
 * (WWDC, Swift Evolution, sample code) collapse into a useless "Other"
 * bucket under the generic DocC-role grouping; these pure helpers build
 * scope-specific sections instead. `renderFrameworkPage` falls back to
 * role grouping when `buildScopeGroups` returns null.
 */

import { slugify } from '../../content/render-html.js'
import {
  groupArchiveByCategory,
  groupGuidelinesBySection,
  groupHigByCategory,
  groupPackagesByOwner,
  groupReleaseNotesByVersion,
  groupSwiftBookByPart,
  sortTechnotes,
} from './scope-groups-extra.js'

const WWDC_PATH_YEAR = /^wwdc\/wwdc(\d{4})-/

// Matching is by case-insensitive prefix, in array order — keep
// 'partially implemented' ahead of 'implemented'. Array order is also
// the display order of the status sections.
const SE_STATUS_FAMILIES = [
  ['active review', 'Active Review'],
  ['scheduled for review', 'Scheduled for Review'],
  ['awaiting review', 'Awaiting Review'],
  ['accepted', 'Accepted'],
  ['previewing', 'Previewing'],
  ['partially implemented', 'Partially Implemented'],
  ['implemented', 'Implemented'],
  ['returned for revision', 'Returned for Revision'],
  ['deferred', 'Deferred'],
  ['rejected', 'Rejected'],
  ['withdrawn', 'Withdrawn'],
  ['expired', 'Expired'],
]

function parseSourceMetadata(doc) {
  const rawMeta = doc?.source_metadata ?? doc?.sourceMetadata
  if (rawMeta == null) return null
  if (typeof rawMeta === 'object') return rawMeta
  try {
    const parsed = JSON.parse(rawMeta)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function docTitle(doc) {
  return String(doc?.title ?? doc?.key ?? doc?.path ?? '')
}

function byTitle(a, b) {
  return docTitle(a).localeCompare(docTitle(b))
}

/**
 * Group WWDC session pages by year (derived from the page path,
 * `wwdc/wwdc{YEAR}-{ID}`), newest year first, sessions sorted by title
 * within a year. Pages without a year in the path land in a trailing
 * "Other" section.
 *
 * @param {Array<{path?: string, key?: string, title?: string}>} docs
 * @returns {Array<{id: string, label: string, count: number, docs: Array}>}
 */
export function groupWwdcByYear(docs) {
  const byYear = new Map()
  const rest = []
  for (const doc of docs ?? []) {
    const match = WWDC_PATH_YEAR.exec(doc.path ?? doc.key ?? '')
    if (!match) {
      rest.push(doc)
      continue
    }
    const year = Number(match[1])
    if (!byYear.has(year)) byYear.set(year, [])
    byYear.get(year).push(doc)
  }
  const sections = [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, yearDocs]) => ({
      id: `year-${year}`,
      label: String(year),
      count: yearDocs.length,
      docs: yearDocs.sort(byTitle),
    }))
  if (rest.length > 0) {
    sections.push({ id: 'year-other', label: 'Other', count: rest.length, docs: rest.sort(byTitle) })
  }
  return sections
}

/**
 * Normalize a raw Swift Evolution status string (e.g. "Implemented
 * (Swift 5.9)", "Accepted with modifications") to its status family
 * label, or 'Other' when unrecognized/missing.
 */
export function swiftEvolutionStatusLabel(status) {
  const normalized = String(status ?? '')
    .trim()
    .toLowerCase()
  if (!normalized) return 'Other'
  for (const [prefix, label] of SE_STATUS_FAMILIES) {
    if (normalized.startsWith(prefix)) return label
  }
  return 'Other'
}

function seNumberValue(meta) {
  const match = /(\d+)/.exec(String(meta?.seNumber ?? ''))
  return match ? Number(match[1]) : -1
}

/**
 * Group Swift Evolution proposals by status family (from
 * `source_metadata.status`), newest proposal (highest SE number) first
 * within a group. Each doc gains a `meta` line (SE number + Swift
 * version) shown next to the title.
 *
 * @returns {Array<{id: string, label: string, count: number, docs: Array}>}
 */
export function groupSwiftEvolutionByStatus(docs) {
  const byStatus = new Map()
  for (const doc of docs ?? []) {
    const metadata = parseSourceMetadata(doc)
    const label = swiftEvolutionStatusLabel(metadata?.status)
    const metaParts = [metadata?.seNumber, metadata?.swiftVersion ? `Swift ${metadata.swiftVersion}` : null]
    const entry = {
      ...doc,
      meta: metaParts.filter(Boolean).join(' · ') || null,
      _seNumber: seNumberValue(metadata),
    }
    if (!byStatus.has(label)) byStatus.set(label, [])
    byStatus.get(label).push(entry)
  }
  const order = new Map(SE_STATUS_FAMILIES.map(([, label], index) => [label, index]))
  return [...byStatus.entries()]
    .sort((a, b) => (order.get(a[0]) ?? SE_STATUS_FAMILIES.length) - (order.get(b[0]) ?? SE_STATUS_FAMILIES.length))
    .map(([label, statusDocs]) => ({
      id: `status-${slugify(label)}`,
      label,
      count: statusDocs.length,
      docs: statusDocs.sort((a, b) => b._seNumber - a._seNumber || byTitle(a, b)),
    }))
}

/**
 * Group sample-code projects by the first entry of
 * `source_metadata.frameworks`, alphabetically with 'Other' last.
 *
 * @returns {Array<{id: string, label: string, count: number, docs: Array}>}
 */
export function groupSampleCodeByFramework(docs) {
  const byFramework = new Map()
  for (const doc of docs ?? []) {
    const metadata = parseSourceMetadata(doc)
    const first = Array.isArray(metadata?.frameworks) ? metadata.frameworks[0] : null
    const label = typeof first === 'string' && first.trim() ? first.trim() : 'Other'
    if (!byFramework.has(label)) byFramework.set(label, [])
    byFramework.get(label).push(doc)
  }
  return [...byFramework.entries()]
    .sort((a, b) => {
      if (a[0] === 'Other') return 1
      if (b[0] === 'Other') return -1
      return a[0].localeCompare(b[0])
    })
    .map(([label, fwDocs]) => ({
      id: `fw-${slugify(label)}`,
      label,
      count: fwDocs.length,
      docs: fwDocs.sort(byTitle),
    }))
}

/**
 * Build scope-specific list sections for a root, or null when the root
 * should keep the default role-based grouping.
 *
 * @param {object|null} root Root record ({ slug, kind, source_type, ... }).
 * @param {Array} docs Document rows for the root's page list.
 * @param {{ higGroups?: Map }} [extras] Loaded by src/web/scope-group-data.js.
 * @returns {{ scope: string, sections: Array, nav?: Array<{href: string, label: string, count: number}> } | null}
 */
export function buildScopeGroups(root, docs, extras = {}) {
  const scope = root?.source_type ?? root?.slug
  const slug = root?.slug
  const docList = docs ?? []
  if (docList.length === 0) return null
  if (scope === 'wwdc' || slug === 'wwdc') {
    const sections = groupWwdcByYear(docList)
    return {
      scope: 'wwdc',
      sections,
      nav: sections.map((s) => ({ href: `#${s.id}`, label: s.label, count: s.count })),
    }
  }
  if (scope === 'swift-evolution' || slug === 'swift-evolution') {
    return { scope: 'swift-evolution', sections: groupSwiftEvolutionByStatus(docList) }
  }
  if (scope === 'sample-code' || slug === 'sample-code') {
    return { scope: 'sample-code', sections: groupSampleCodeByFramework(docList) }
  }
  if (scope === 'guidelines' || slug === 'app-store-review') {
    return { scope: 'guidelines', sections: groupGuidelinesBySection(docList) }
  }
  if (root?.kind === 'release-notes') {
    return { scope: 'release-notes', sections: groupReleaseNotesByVersion(docList) }
  }
  if (scope === 'swift-book' || slug === 'swift-book') {
    return { scope: 'swift-book', sections: groupSwiftBookByPart(docList) }
  }
  if (scope === 'packages' || slug === 'packages') {
    const sections = groupPackagesByOwner(docList)
    return {
      scope: 'packages',
      sections,
      // Owner jump-nav for the biggest catalogs only — hundreds of
      // single-package owners would drown the nav.
      nav: sections.filter((s) => s.count >= 20).map((s) => ({ href: `#${s.id}`, label: s.label, count: s.count })),
    }
  }
  if (slug === 'technotes') {
    return { scope: 'technotes', sections: sortTechnotes(docList) }
  }
  if (scope === 'apple-archive' || slug === 'apple-archive') {
    const sections = groupArchiveByCategory(docList)
    return {
      scope: 'apple-archive',
      sections,
      nav: sections.map((s) => ({ href: `#${s.id}`, label: s.label, count: s.count })),
    }
  }
  if (scope === 'hig' || slug === 'design') {
    const sections = groupHigByCategory(docList, extras.higGroups)
    if (sections) return { scope: 'hig', sections }
  }
  return null
}
