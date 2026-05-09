// Bundle entry for /assets/core.js — loaded on every page.
//
// Order matters: theme.js's data-theme write happens at module
// evaluation time (before initTheme() is called) so the bundle can never
// flash an inverted palette. The init() calls then wire DOM listeners
// and observers in document order.
//
// Bun.build inlines the named exports directly inside the bundle's
// outer IIFE (`format: 'iife'` in asset-bundler.js). No __esModule
// shim is emitted because nothing outside the bundle imports these.
import { init as initTheme } from './theme.js'
import { init as initSearch } from './search.js'
import { init as initPageToc } from './page-toc.js'

initTheme()
initSearch()
initPageToc()
