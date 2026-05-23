/**
 * Centralised env-var configuration with zod validation.
 *
 * Every `APPLE_DOCS_*` environment variable the project reads is declared
 * here. Modules consume the frozen `config` object instead of touching
 * `process.env` directly, so misconfigured environments fail loudly at
 * startup (rather than silently degrading the runtime) and the env-var
 * contract has one source of truth for the README.
 *
 * Defaults match historical CLI behaviour. Each entry's leading comment
 * documents the *meaning* of the variable; the README's configuration
 * section is generated from the same shape.
 *
 * Per-command defaults that historically differ by entry point (e.g.
 * `APPLE_DOCS_RATE` defaults to 500 during `sync` and 5 elsewhere) keep
 * their entry-point logic in `cli.js`; this module documents the
 * baseline default only.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ConfigError } from './lib/errors.js'

// Coercions that turn the string-only env into typed values. `z.coerce`
// covers numbers; booleans accept the canonical "1"/"0" + "true"/"false".
const bool = () =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v
    const s = v.trim().toLowerCase()
    if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true
    if (s === '0' || s === 'false' || s === 'off' || s === 'no' || s === '') return false
    return v
  }, z.boolean())

const posInt = () => z.coerce.number().int().min(1)
const nonNegInt = () => z.coerce.number().int().min(0)

const configSchema = z.object({
  // -- Core ----------------------------------------------------------------
  APPLE_DOCS_HOME: z.string().default(join(homedir(), '.apple-docs')),
  APPLE_DOCS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  APPLE_DOCS_DEBUG: bool().default(false),
  NODE_ENV: z.string().optional(),

  // -- Outbound HTTP (Apple / GitHub crawl) --------------------------------
  APPLE_DOCS_RATE: posInt().optional(), // entry-point-dependent default (sync=500, else=5)
  APPLE_DOCS_BURST: posInt().optional(),
  APPLE_DOCS_CONCURRENCY: posInt().optional(),
  APPLE_DOCS_PARALLEL: posInt().default(10),
  APPLE_DOCS_TIMEOUT: posInt().default(30_000),
  APPLE_DOCS_GITHUB_TIMEOUT: posInt().optional(), // falls back to APPLE_DOCS_TIMEOUT
  APPLE_DOCS_API_BASE: z.string().url().optional(),
  APPLE_DOCS_HOST_BUCKET_MAX: posInt().default(256),

  // -- Sync ----------------------------------------------------------------
  APPLE_DOCS_SKIP_RESOURCES: bool().default(false),
  APPLE_DOCS_DOWNLOAD_FONTS: bool().optional(),
  APPLE_DOCS_SYMBOLS_OFFLINE: bool().default(false),
  APPLE_DOCS_PACKAGES_SCOPE: z.enum(['official', 'full']).default('official'),
  APPLE_DOCS_PACKAGES_FETCH: z.enum(['raw', 'api']).default('raw'),
  APPLE_DOCS_PACKAGES_LIMIT: posInt().optional(),
  APPLE_DOCS_BUILD_WORKER: bool().default(false),

  // -- Auth ----------------------------------------------------------------
  GITHUB_TOKEN: z.string().optional(),
  GH_TOKEN: z.string().optional(),

  // -- MCP server ----------------------------------------------------------
  APPLE_DOCS_MCP_CACHE: z.enum(['on', 'off']).default('on'),
  APPLE_DOCS_MCP_CACHE_SCALE: z.coerce.number().positive().optional(),
  APPLE_DOCS_MCP_CACHE_STATS: bool().default(false),
  APPLE_DOCS_MCP_CONCURRENCY: posInt().default(8),
  APPLE_DOCS_MCP_QUEUE: nonNegInt().default(64),
  // Reader-pool toggle ('on' enables the worker-thread pool); the pool's
  // *size* lives in APPLE_DOCS_MCP_READER_WORKERS. The runtime check is
  // a strict equality against 'on' (src/mcp/http-server.js), so the
  // schema must accept the toggle string rather than coerce to a number.
  APPLE_DOCS_MCP_READERS: z.enum(['on', 'off']).optional(),
  APPLE_DOCS_MCP_READER_WORKERS: posInt().optional(),
  APPLE_DOCS_MCP_DEEP_READERS: posInt().optional(),

  // -- Web server ----------------------------------------------------------
  APPLE_DOCS_WEB_HOST: z.string().default('127.0.0.1'),
  APPLE_DOCS_WEB_RATE: posInt().optional(),
  APPLE_DOCS_WEB_BURST: posInt().optional(),
  APPLE_DOCS_WEB_RATE_LIMIT: bool().default(false),
  APPLE_DOCS_WEB_DEEP_INFLIGHT: posInt().default(4),
  APPLE_DOCS_WEB_DEEP_QUEUE: nonNegInt().default(8),
  APPLE_DOCS_WEB_DEEP_READERS: posInt().optional(),
  // Reader-pool mode (off|auto|on); the pool's size lives in
  // APPLE_DOCS_WEB_READER_WORKERS. Runtime reads the string directly
  // (src/web/context.js), so accept the enum rather than coerce.
  APPLE_DOCS_WEB_READERS: z.enum(['off', 'auto', 'on']).optional(),
  APPLE_DOCS_WEB_READER_WORKERS: posInt().optional(),
  APPLE_DOCS_WEB_RENDER_CONCURRENCY: posInt().optional(),
  APPLE_DOCS_WEB_SEARCH_CACHE: posInt().optional(),
  APPLE_DOCS_WEB_SEARCH_CACHE_BYTES: posInt().optional(),
  APPLE_DOCS_WEB_FONT_SUBSET_WORKERS: posInt().optional(),
  APPLE_DOCS_WEB_FONT_SUBSET_CONCURRENCY: posInt().optional(),
  APPLE_DOCS_WEB_FONT_SUBSET_LRU: posInt().optional(),
  APPLE_DOCS_WEB_FONT_SUBSET_LRU_BYTES: posInt().optional(),
  APPLE_DOCS_FONT_SUBSET_PYTHON: z.string().optional(),

  // -- Content rendering ---------------------------------------------------
  APPLE_DOCS_NO_HIGHLIGHT: bool().default(false),
  APPLE_DOCS_HIGHLIGHT_MAX: posInt().optional(),
  APPLE_DOCS_MD_MAX_BYTES: posInt().optional(),
  APPLE_DOCS_RENDER_CACHE_BYTES: posInt().optional(),
  APPLE_DOCS_RENDER_CACHE_TTL_DAYS: nonNegInt().optional(),

  // -- Internal -----------------------------------------------------------
  BUN_BIN: z.string().optional(),
  HOME: z.string().optional(),
  DYLD_FRAMEWORK_PATH: z.string().optional(),
}).passthrough()

/**
 * Parse a given environment block (`process.env` by default) against the
 * schema. Errors abort the caller with a readable summary — there is no
 * recovery path for an invalid runtime configuration.
 *
 * Exported so unit tests can pin the schema against synthetic env blocks
 * (notably the ones our launchd plists ship) without monkey-patching the
 * real `process.env`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<z.infer<typeof configSchema>>}
 */
export function loadConfig(env = process.env) {
  const result = configSchema.safeParse(env)
  if (!result.success) {
    const issues = result.error.issues
      .map((iss) => `  - ${iss.path.join('.')}: ${iss.message}`)
      .join('\n')
    throw new ConfigError(`Invalid environment configuration:\n${issues}`)
  }
  return Object.freeze(result.data)
}

export const config = loadConfig()

/**
 * Convenience boolean: true when `APPLE_DOCS_DEBUG` is set. Used as the
 * default short-circuit in `src/output/projection.js` and as the
 * passthrough toggle in `src/output/schemas.js`.
 */
export const DEBUG_PASSTHROUGH = config.APPLE_DOCS_DEBUG === true
