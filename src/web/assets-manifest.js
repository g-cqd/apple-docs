/**
 * Single source of truth for browser asset bundling.
 *
 * Both `src/web/build.js` (static site generation) and `src/web/serve.js`
 * (live dev preview / on-demand bundling) consume this manifest. Keep them
 * pointing here — historically the same bundle definition was duplicated in
 * both files, and any drift shipped subtly broken HTML (the on-the-fly
 * bundle differed byte-wise from the built one, and the assetVersion
 * cache-bust hid the difference).
 */

/**
 * Bundles emitted to /assets/<name>. Each entry points at a single
 * `entries/*.entry.js` file that imports the bundle members in the
 * correct execution order. Bun.build resolves the entry, inlines the
 * members, and emits one minified IIFE-wrapped output per bundle.
 *
 * Both `src/web/build.js` (static rendering) and `src/web/serve.js`
 * (dev preview) read this map; with the entries the two paths share
 * one toolchain (Bun.build) instead of having serve.js fall back to
 * string concatenation against the raw source files.
 */
export const ENTRY_BUNDLES = {
  'core.js': 'core.bundle.js',
  'listing.js': 'listing.bundle.js',
}

/**
 * Single-file scripts copied 1:1 to /assets/<name>. Used for page-scoped
 * controllers that aren't worth bundling because no other page imports them.
 */
export const STANDALONE_ASSETS = ['search-page.js', 'fonts-page.js', 'symbols-page.js', 'lang-toggle.js']

/**
 * Files copied to /worker/<name>. Web Workers cannot share scope with the
 * main thread, so they always ship as their own files.
 */
export const WORKER_ASSETS = ['search-worker.js']

/**
 * Static CSS files served from /assets/<name>. The build pipeline minifies
 * them; the dev server serves them as-is.
 */
export const STATIC_CSS_ASSETS = ['style.css']
