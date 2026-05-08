/**
 * @typedef {object} FontsPageProps
 * @property {Array<object>} families
 */

/**
 * Build the props consumed by `renderFontsPage`. Used by both the live
 * dev server (`/fonts`) and the static build.
 *
 * @param {{ db: object }} ctx
 * @returns {FontsPageProps}
 */
export function buildFontsPageProps(ctx) {
  return { families: ctx.db.listAppleFonts() }
}
