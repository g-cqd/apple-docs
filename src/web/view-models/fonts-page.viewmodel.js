/**
 * @typedef {any} FontsPageProps
 * @property {Array<any>} families
 */

/**
 * Build the props consumed by `renderFontsPage`. Used by both the live
 * dev server (`/fonts`) and the static build.
 *
 * @param {{ db: any }} ctx
 * @returns {FontsPageProps}
 */
export function buildFontsPageProps(ctx) {
  return { families: ctx.db.listAppleFonts() }
}
