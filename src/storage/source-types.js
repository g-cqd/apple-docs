/**
 * Canonical source-type enum. Every SourceAdapter declares its `static type`,
 * but storage queries and content normalization need a single source of
 * truth — including a default for the `apple-docc` corpus and a validator so
 * boundaries can reject drift early.
 *
 * The drift test in `test/unit/source-types.test.js` asserts every adapter's
 * declared type appears in this set so the table stays in sync.
 */

export const DEFAULT_SOURCE_TYPE = 'apple-docc'

export const SOURCE_TYPES = Object.freeze([
  'apple-docc',
  'swift-docc',
  'apple-archive',
  'guidelines',
  'hig',
  'packages',
  'sample-code',
  'swift-book',
  'swift-evolution',
  'swift-org',
  'wwdc',
])

const SOURCE_TYPE_SET = new Set(SOURCE_TYPES)

export function isSourceType(value) {
  return typeof value === 'string' && SOURCE_TYPE_SET.has(value)
}

/**
 * Validate at storage boundary. Returns the value when valid, otherwise the
 * default. Callers that want to surface bad input can pre-check with
 * `isSourceType` and throw their own error.
 */
export function coerceSourceType(value) {
  return isSourceType(value) ? value : DEFAULT_SOURCE_TYPE
}

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
  return DEFAULT_SOURCE_TYPE
}
