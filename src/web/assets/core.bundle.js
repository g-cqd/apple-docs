// Bundle entry for /assets/core.js — loaded on every page.
//
// Order matters: theme.js sets the data-theme attribute before search.js
// renders any visual chrome, and page-toc.js binds after the document is
// parsed. The outer <script defer> tag handles DOM-readiness for all of
// them; this file is a linear list of side-effect imports.
//
// Each member is a top-level IIFE that runs once when the bundle loads.
// Bun.build inlines them inside the bundle's outer IIFE; member scopes
// stay isolated as before.
//
// File name `*.bundle.js` so it's easy to grep and (if a future iteration
// wants to) exclude bundle entries from the standalone-asset list.
import './theme.js'
import './search.js'
import './page-toc.js'
