/**
 * @typedef {object} SymbolsPageProps
 * @property {Array<{ scope: string, count: number }>} totals
 */

/**
 * Build the props consumed by `renderSymbolsPage`. Used by both the live
 * dev server (`/symbols`, `/symbols/<name>`) and the static build.
 *
 * @param {{ db: object }} ctx
 * @returns {SymbolsPageProps}
 */
export function buildSymbolsPageProps(ctx) {
  return {
    totals: ctx.db.db.query(
      'SELECT scope, COUNT(*) as count FROM sf_symbols GROUP BY scope',
    ).all(),
  }
}
