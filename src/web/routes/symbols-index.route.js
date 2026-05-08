import { jsonResponse } from '../responses.js'

/**
 * SF Symbols catalog endpoint. The full catalog is read straight from the
 * DB on every miss — small and cacheable. `hashable: true` lets
 * finalizeResponse compute an ETag so revisits skip the body.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function symbolsIndexHandler(_request, ctx) {
  const catalog = ctx.db.listSfSymbolsCatalog()
  return jsonResponse({ count: catalog.length, symbols: catalog }, { hashable: true })
}
