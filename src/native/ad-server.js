/**
 * ad-server (the native HTTP host) discovery + invocation mapping for the
 * serving flip (RFC 0005 Phase E). Binary resolution mirrors the dylib loader's
 * allowlist — operator override → install tree → dev build tree, never DATA_DIR
 * or CWD (security.md §1).
 *
 * The flip is DEFAULT-ON (see `isNativeServeEnabled` in loader.js — bake
 * complete) and delegates only invocations the native host can faithfully
 * honour — anything else falls back to the Bun servers, so a flag ad-server
 * lacks is never silently dropped. `web serve` is currently HELD on the Bun
 * path entirely (see nativeServeArgs) until ad-server serves the full site.
 */

import { existsSync } from 'node:fs'
import { VERSION } from '../lib/version.js'

const ROOT = new URL('../../', import.meta.url).pathname

/**
 * Resolve the `ad-server` executable, or null when absent. When
 * `APPLE_DOCS_NATIVE_BIN` is set it is the sole authoritative candidate, so a
 * typo'd path fails to Bun instead of silently running some other build.
 *
 * @returns {string | null}
 */
export function adServerBinaryPath() {
  const override = process.env.APPLE_DOCS_NATIVE_BIN
  if (override) return existsSync(override) ? override : null
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  const candidates = [`${ROOT}dist/native/${process.platform}-${arch}/ad-server`, `${ROOT}swift/.build/release/ad-server`]
  return candidates.find((path) => existsSync(path)) ?? null
}

/**
 * Map a cli.js serve invocation to `ad-server` argv, or null to fall back to the
 * Bun server — for a verb not flipped, or a flag ad-server can't honour. Two
 * serve verbs flip (RFC 0005 Phase E): `mcp serve` → `ad-server serve` (the
 * unified HTTP host serves `POST /mcp`), `mcp start` → `ad-server mcp` (stdio).
 * `ad-server serve` is loopback-plaintext (Caddy terminates TLS) and exposes
 * neither app-level rate-limiting/heavy-queue knobs nor a metrics endpoint, and
 * its `/mcp` CORS policy is fixed, so any of those flags (or a non-loopback
 * host) forces the Bun path.
 *
 * `web serve` is HELD on the Bun path (2026-07-18): ad-server covers the
 * API/data/discovery/MCP routes byte-for-byte, but not the HTML pages
 * (/, /docs/*, /fonts, /symbols), /assets/*, or /api/search — a delegated
 * `web serve` would 404 the site the verb exists to serve (measured in
 * reports/e2e/web-serve-ab.json). Restore the mapping once ad-server passes the
 * full live-serving A/B; it was: `serve --db <db> --port <port|3000>
 * --app-version <VERSION> [--base-url …] [--site-name …]`, loopback-only, with
 * rate-limit/metrics flags still falling back to Bun.
 *
 * @param {{ command: string, subcommand: string | undefined, flags: Record<string, unknown>, dbPath: string }} invocation
 * @returns {string[] | null}
 */
export function nativeServeArgs({ command, subcommand, flags, dbPath }) {
  if (command === 'web' && subcommand === 'serve') return null
  if (command === 'mcp' && subcommand === 'serve') return mcpServeArgs(flags, dbPath)
  // stdio MCP — no HTTP flags to reconcile; `ad-server mcp` takes only --db/--app-version.
  if (command === 'mcp' && subcommand === 'start') return ['mcp', '--db', dbPath, '--app-version', VERSION]
  return null
}

/** `mcp serve` (HTTP MCP) → `ad-server serve` (hosts POST /mcp). @param {Record<string, unknown>} flags @param {string} dbPath @returns {string[] | null} */
function mcpServeArgs(flags, dbPath) {
  const host = flags.host ?? '127.0.0.1'
  if (host !== '127.0.0.1') return null
  if (flags['allow-origin'] != null) return null
  if (flags.concurrency != null || flags.queue != null) return null
  if (flags['metrics-port'] != null || flags['metrics-host'] != null) return null

  const port = flags.port != null ? String(flags.port) : '3031'
  return ['serve', '--db', dbPath, '--port', port, '--app-version', VERSION]
}
