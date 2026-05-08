/**
 * Static "extras" injected into the homepage's framework grid: the Apple
 * Fonts and SF Symbols entries that don't have a backing root in the DB
 * but have full pages of their own (`/fonts`, `/symbols`).
 *
 * Lives in its own module so both serve.js (live) and build.js (static)
 * consume one source of truth, and the route extraction in
 * src/web/routes/pages.route.js doesn't have to import from serve.js.
 *
 * @param {{ baseUrl?: string }} siteConfig
 */
export function buildHomepageExtras(siteConfig) {
  const baseUrl = siteConfig.baseUrl ?? ''
  return {
    design: [
      {
        slug: 'fonts',
        display_name: 'Apple Fonts',
        kind: 'design',
        href: `${baseUrl}/fonts`,
      },
      {
        slug: 'symbols',
        display_name: 'SF Symbols',
        kind: 'design',
        href: `${baseUrl}/symbols`,
      },
    ],
  }
}
