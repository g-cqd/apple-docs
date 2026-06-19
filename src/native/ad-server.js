/**
 * ad-server (the native HTTP host) discovery + invocation mapping for the
 * serving flip (RFC 0005 Phase E). Binary resolution mirrors the dylib loader's
 * allowlist — operator override → install tree → dev build tree, never DATA_DIR
 * or CWD (security.md §1).
 *
 * The flip is DEFAULT-OFF (see `isNativeServeEnabled` in loader.js): only an
 * explicit `serve` token in APPLE_DOCS_NATIVE delegates to this binary, and only
 * for invocations it can faithfully honour — anything else falls back to the Bun
 * servers, so a flag the native host lacks is never silently dropped.
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
 * Bun server — for a verb not flipped, or a flag ad-server can't honour. The
 * three serve verbs flip (RFC 0005 Phase E): `web serve` + `mcp serve` →
 * `ad-server serve` (the unified HTTP host serves the web routes AND `POST /mcp`),
 * `mcp start` → `ad-server mcp` (stdio). `ad-server serve` is loopback-plaintext
 * (Caddy terminates TLS) and exposes neither app-level rate-limiting/heavy-queue
 * knobs nor a metrics endpoint, and its `/mcp` CORS policy is fixed, so any of
 * those flags (or a non-loopback host) forces the Bun path.
 *
 * @param {{ command: string, subcommand: string | undefined, flags: Record<string, unknown>, dbPath: string }} invocation
 * @returns {string[] | null}
 */
export function nativeServeArgs({ command, subcommand, flags, dbPath }) {
  if (command === 'web' && subcommand === 'serve') return webServeArgs(flags, dbPath)
  if (command === 'mcp' && subcommand === 'serve') return mcpServeArgs(flags, dbPath)
  // stdio MCP — no HTTP flags to reconcile; `ad-server mcp` takes only --db/--app-version.
  if (command === 'mcp' && subcommand === 'start') return ['mcp', '--db', dbPath, '--app-version', VERSION]
  return null
}

/** `web serve` → `ad-server serve`. @param {Record<string, unknown>} flags @param {string} dbPath @returns {string[] | null} */
function webServeArgs(flags, dbPath) {
  const host = flags.host ?? process.env.APPLE_DOCS_WEB_HOST ?? '127.0.0.1'
  if (host !== '127.0.0.1') return null
  if (flags['rate-limit']) return null
  if (flags['metrics-port'] != null || flags['metrics-host'] != null) return null

  // ad-server serve defaults to port 3032; pin the Bun `web serve` default (3000)
  // when the caller didn't specify one so the flip is endpoint-for-endpoint.
  const port = flags.port != null ? String(flags.port) : '3000'
  const args = ['serve', '--db', dbPath, '--port', port, '--app-version', VERSION]
  if (flags['base-url'] != null) args.push('--base-url', String(flags['base-url']))
  if (flags['site-name'] != null) args.push('--site-name', String(flags['site-name']))
  return args
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
