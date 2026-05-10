#!/usr/bin/env bun
/**
 * apple-docs-mcp — backward-compatible alias for `apple-docs mcp start`.
 *
 * Historically this was a parallel entry point with its own DB / lifecycle
 * setup. The drift hazard (env-var handling diverging from cli.js) caused
 * subtle differences across releases, so we collapse both binaries onto
 * cli.js by injecting the appropriate argv before delegation.
 *
 * APPLE_DOCS_HOME and APPLE_DOCS_LOG_LEVEL are honored identically by
 * cli.js (lines ~42 + ~43), so no extra env handling is required here.
 */

const args = process.argv.slice(2)
process.argv = [process.argv[0], process.argv[1], 'mcp', 'start', ...args]

await import('./cli.js')
