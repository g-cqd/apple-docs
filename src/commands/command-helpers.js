import { getAdapterTypes } from '../sources/registry.js'

export const ROOT_CATALOG_SOURCE_TYPES = new Set(['apple-docc', 'hig'])

/**
 * Normalizes an optional list of comma-separated or array values to a lowercase
 * array, or null if the input is nullish.
 * @param {string[] | null | undefined} values
 * @returns {string[] | null}
 */
export function normalizeList(values) {
  return values?.map(value => value.toLowerCase()) ?? null
}

/**
 * Validates that every entry in requestedSources is a known adapter type.
 * Throws if any unknown source type is found.
 * @param {string[] | null} requestedSources
 */
export function validateRequestedSources(requestedSources) {
  if (!requestedSources) return

  const knownSources = new Set(getAdapterTypes())
  const unknownSources = requestedSources.filter(source => !knownSources.has(source))
  if (unknownSources.length > 0) {
    throw new Error(`Unknown source type(s): ${unknownSources.join(', ')}`)
  }
}

/**
 * Filters discovered roots for a given adapter down to only those that match
 * the optional requestedRoots allow-list.
 * @param {object} adapter
 * @param {{ roots?: object[] }} discovery
 * @param {object} db
 * @param {string[] | null} requestedRoots
 * @returns {object[]}
 */
export function selectRootsForAdapter(adapter, discovery, db, requestedRoots) {
  const requestedRootSet = requestedRoots ? new Set(requestedRoots) : null
  const discoveredRoots = discovery.roots ?? db.getRoots().filter(root => root.source_type === adapter.constructor.type)

  return discoveredRoots.filter(root => {
    if (!root?.slug) return false
    if (!requestedRootSet) return true
    return requestedRootSet.has(root.slug)
  })
}

/**
 * Filters pages by both an optional root allow-list and an optional source-type
 * allow-list. Used by the sync pipeline.
 * @param {object[]} pages
 * @param {string[] | null} requestedRoots
 * @param {string[] | null} requestedSources
 * @returns {object[]}
 */
export function filterPages(pages, requestedRoots, requestedSources) {
  const rootSet = requestedRoots ? new Set(requestedRoots) : null
  const sourceSet = requestedSources ? new Set(requestedSources) : null

  return pages.filter(page => {
    if (rootSet && !rootSet.has(page.root_slug)) return false
    if (sourceSet && !sourceSet.has(page.source_type)) return false
    return true
  })
}

/**
 * Filters pages to only those belonging to one of the requested roots.
 * Returns all pages unchanged when requestedRoots is null. Used by the update
 * pipeline.
 * @param {object[]} pages
 * @param {string[] | null} requestedRoots
 * @returns {object[]}
 */
export function filterPagesByRoots(pages, requestedRoots) {
  if (!requestedRoots) return pages
  const requestedRootSet = new Set(requestedRoots)
  return pages.filter(page => requestedRootSet.has(page.root_slug))
}

/**
 * Run adapter discovery in parallel and return results keyed by source type.
 * @param {object[]} adapters
 * @param {object} ctx
 * @returns {Promise<{ discoveries: Map<string, object>, errors: Map<string, Error> }>}
 */
export async function discoverAdaptersInParallel(adapters, ctx) {
  const settled = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return {
          type: adapter.constructor.type,
          discovery: await adapter.discover(ctx),
          error: null,
        }
      } catch (error) {
        return {
          type: adapter.constructor.type,
          discovery: null,
          error,
        }
      }
    }),
  )

  const discoveries = new Map()
  const errors = new Map()

  for (const result of settled) {
    if (!result.error) {
      const { type, discovery } = result
      discoveries.set(type, discovery)
      continue
    }

    errors.set(result.type, result.error)
  }

  return { discoveries, errors }
}
