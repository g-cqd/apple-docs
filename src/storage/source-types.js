/**
 * Shared source-type constants. Pulled out of database.js so storage
 * migrations and runtime queries can share the table without a circular
 * import.
 */

export const ROOT_SOURCE_TYPE_BY_SLUG = new Map([
  ['app-store-review', 'guidelines'],
  ['design', 'hig'],
  ['apple-archive', 'apple-archive'],
  ['packages', 'packages'],
  ['sample-code', 'sample-code'],
  ['swift-book', 'swift-book'],
  ['swift-evolution', 'swift-evolution'],
  ['swift-org', 'swift-org'],
  ['wwdc', 'wwdc'],
])

export function deriveRootSourceType(slug, kind) {
  if (ROOT_SOURCE_TYPE_BY_SLUG.has(slug)) return ROOT_SOURCE_TYPE_BY_SLUG.get(slug)
  if (kind === 'guidelines') return 'guidelines'
  if (kind === 'design') return 'hig'
  return 'apple-docc'
}
