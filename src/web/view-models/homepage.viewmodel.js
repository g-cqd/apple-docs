import { buildHomepageExtras } from '../homepage-extras.js'

/**
 * @typedef {object} HomepageProps
 * @property {Array<object>} roots Framework roots that have at least one
 *   real page (filters out collection pages whose only entry is the root
 *   itself).
 * @property {object} extras Static extras (Apple Fonts, SF Symbols) injected
 *   into the framework grid.
 */

/**
 * Build the props consumed by `renderIndexPage`. Used by both the live
 * dev server (`/`) and the static build (`dist/web/index.html`) so the
 * two paths cannot drift on filtering or extras shape.
 *
 * @param {{ db: object, siteConfig: object }} ctx
 * @returns {HomepageProps}
 */
export function buildHomepageProps(ctx) {
  const { db, siteConfig } = ctx
  const roots = db.getRoots().filter(r => {
    if (r.page_count <= 1) {
      const pages = db.getPagesByRoot(r.slug)
      if (pages.length <= 1 && (!pages[0] || pages[0].path === r.slug)) return false
    }
    return true
  })
  return {
    roots,
    extras: buildHomepageExtras(siteConfig),
  }
}
