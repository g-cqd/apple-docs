// Bundle entry for /assets/core.js — loaded on every page.
//
// Order matters: `initTheme` sets the data-theme attribute before
// search.js / page-toc.js paint any chrome, so the bundle never flashes
// an inverted palette. search.js / page-toc.js are still IIFE-side-effect
// modules pending Phase 2 conversions; once they expose `init()` we
// switch each to an explicit call here.
//
// Bun.build inlines the bundle members inside an outer IIFE
// (`format: 'iife'` in asset-bundler.js). The named export from theme.js
// is folded directly into bundle scope — no ESM-export shim emitted.
import { init as initTheme } from './theme.js'
import './search.js'
import './page-toc.js'

initTheme()
