/**
 * ad-cli (the native read-verb CLI) discovery + invocation mapping for the P7
 * CLI flip (RFC 0007). Binary resolution mirrors the dylib loader's allowlist —
 * operator override → install tree → dev build tree, never DATA_DIR or CWD
 * (security.md §1).
 *
 * The flip is DEFAULT-OFF (see `isNativeCliEnabled` in loader.js): only an
 * explicit `cli` token in APPLE_DOCS_NATIVE delegates to this binary, and only
 * for verbs + flags it can faithfully honour — anything else falls back to the
 * Bun CLI, so a flag the native CLI lacks is never silently dropped.
 */

import { existsSync } from 'node:fs'

const ROOT = new URL('../../', import.meta.url).pathname

/**
 * Resolve the `ad-cli` executable, or null when absent. When
 * `APPLE_DOCS_NATIVE_CLI_BIN` is set it is the sole authoritative candidate, so a
 * typo'd path fails to Bun instead of silently running some other build.
 *
 * @returns {string | null}
 */
export function adCliBinaryPath() {
  const override = process.env.APPLE_DOCS_NATIVE_CLI_BIN
  if (override) return existsSync(override) ? override : null
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  const candidates = [`${ROOT}dist/native/${process.platform}-${arch}/ad-cli`, `${ROOT}swift/.build/release/ad-cli`]
  return candidates.find((path) => existsSync(path)) ?? null
}

// Globals that never change a read verb's STDOUT: `--home` is already folded into
// the resolved dbPath, and `--verbose` only raises the stderr log level. Their
// presence must NOT force the Bun path; any OTHER flag must.
const GLOBAL_PASSTHROUGH = ['home', 'verbose']

/**
 * Map a cli.js read-verb invocation to `ad-cli` argv, or null to fall back to the
 * Bun CLI — for a verb not yet flipped, or a flag/positional ad-cli can't honour.
 * This slice flips four read verbs: `frameworks` (→ `--kind`), `kinds`
 * (→ `--field`), `browse <framework>` (→ `--path/--limit/--year`), and
 * `read <target>` (→ `--framework/--section/--max-chars/--page`). Only the verb's
 * own flags + `--json` ride through; anything else forces the Bun path so nothing
 * is silently dropped.
 *
 * @param {{ command: string, subcommand: string | undefined, positional: string[], flags: Record<string, unknown>, dbPath: string }} invocation
 * @returns {string[] | null}
 */
export function nativeCliArgs({ command, subcommand, positional, flags, dbPath }) {
  if (subcommand) return null
  const pos = Array.isArray(positional) ? positional : []
  if (command === 'frameworks') return readVerbArgs('frameworks', 'kind', pos, flags, dbPath)
  if (command === 'kinds') return readVerbArgs('kinds', 'field', pos, flags, dbPath)
  if (command === 'browse') return browseArgs(pos, flags, dbPath)
  if (command === 'read') return readDocArgs(pos, flags, dbPath)
  if (command === 'search') return searchArgs(pos, flags, dbPath)
  if (command === 'status') return statusArgs(pos, flags, dbPath)
  return null
}

/**
 * `status [--advanced] [--json]`. No positional. The GitHub update-check rides on
 * the inherited env (APPLE_DOCS_SKIP_UPDATE_CHECK), not argv, so it's not a flag
 * here. Any other flag forces the Bun path.
 *
 * @param {string[]} positional @param {Record<string, unknown>} flags @param {string} dbPath
 * @returns {string[] | null}
 */
function statusArgs(positional, flags, dbPath) {
  if (positional.length > 0) return null
  const allowed = new Set(['advanced', 'json', ...GLOBAL_PASSTHROUGH])
  if (Object.keys(flags).some((k) => !allowed.has(k))) return null
  const args = ['status', '--db', dbPath]
  if (flags.advanced) args.push('--advanced')
  if (flags.json) args.push('--json')
  return args
}

// search's flag surface (cli.js search dispatch). String/int filters push down;
// the three negation toggles + --read + --json are booleans. The query is the
// joined positional(s).
const SEARCH_STRING_FLAGS = [
  'framework',
  'source',
  'kind',
  'language',
  'platform',
  'min-ios',
  'min-macos',
  'min-watchos',
  'min-tvos',
  'min-visionos',
  'track',
  'deprecated',
]
const SEARCH_INT_FLAGS = ['limit', 'year', 'max-chars', 'page']
const SEARCH_BOOL_FLAGS = ['no-fuzzy', 'no-deep', 'no-eager', 'read', 'json']

/**
 * `search <query…> [filters] [--read [--max-chars N] [--page P]] [--json]`. The
 * query is the joined positional(s); requires at least one. Every recognized flag
 * rides through (string filters as-is, int filters only as clean non-negative
 * integers, the boolean toggles as bare flags); any unknown flag forces the Bun
 * path so nothing is silently dropped.
 *
 * @param {string[]} positional @param {Record<string, unknown>} flags @param {string} dbPath
 * @returns {string[] | null}
 */
function searchArgs(positional, flags, dbPath) {
  if (positional.length === 0) return null
  const allowed = new Set([...SEARCH_STRING_FLAGS, ...SEARCH_INT_FLAGS, ...SEARCH_BOOL_FLAGS, ...GLOBAL_PASSTHROUGH])
  if (Object.keys(flags).some((k) => !allowed.has(k))) return null
  for (const k of SEARCH_STRING_FLAGS) {
    if (flags[k] != null && typeof flags[k] !== 'string') return null
  }
  for (const k of SEARCH_INT_FLAGS) {
    const v = flags[k]
    if (v != null && (typeof v !== 'string' || !/^\d+$/.test(v))) return null
  }

  const args = ['search', positional.join(' '), '--db', dbPath]
  for (const k of SEARCH_STRING_FLAGS) {
    if (typeof flags[k] === 'string') args.push(`--${k}`, flags[k])
  }
  for (const k of SEARCH_INT_FLAGS) {
    if (typeof flags[k] === 'string') args.push(`--${k}`, /** @type {string} */ (flags[k]))
  }
  for (const k of SEARCH_BOOL_FLAGS) {
    if (k !== 'json' && flags[k]) args.push(`--${k}`)
  }
  if (flags.json) args.push('--json')
  return args
}

/**
 * Shared shape for the two single-filter, no-positional read verbs. Falls back
 * (null) on any positional, unsupported flag, or a filter passed without a string
 * value (`--kind --json` leaves `flags.kind === true`, whose JS coercion we don't
 * replicate).
 *
 * @param {string} verb @param {string} filter @param {string[]} positional @param {Record<string, unknown>} flags @param {string} dbPath
 * @returns {string[] | null}
 */
function readVerbArgs(verb, filter, positional, flags, dbPath) {
  if (positional.length > 0) return null
  const allowed = new Set([filter, 'json', ...GLOBAL_PASSTHROUGH])
  if (Object.keys(flags).some((k) => !allowed.has(k))) return null
  const filterValue = flags[filter]
  if (filterValue != null && typeof filterValue !== 'string') return null

  const args = [verb, '--db', dbPath]
  if (typeof filterValue === 'string') args.push(`--${filter}`, filterValue)
  if (flags.json) args.push('--json')
  return args
}

/**
 * `browse <framework> [--path P] [--limit N] [--year Y] [--json]`. Needs exactly
 * one positional (the framework); falls back when it's missing (cli.js shows help)
 * or duplicated. `--limit`/`--year` ride through only as clean non-negative
 * integers (a NaN/negative is left to the Bun path, whose coercion we don't
 * mirror), and `--path` only as a string.
 *
 * @param {string[]} positional @param {Record<string, unknown>} flags @param {string} dbPath
 * @returns {string[] | null}
 */
function browseArgs(positional, flags, dbPath) {
  if (positional.length !== 1) return null
  const allowed = new Set(['path', 'limit', 'year', 'json', ...GLOBAL_PASSTHROUGH])
  if (Object.keys(flags).some((k) => !allowed.has(k))) return null
  if (flags.path != null && typeof flags.path !== 'string') return null
  for (const k of ['limit', 'year']) {
    const v = flags[k]
    if (v != null && (typeof v !== 'string' || !/^\d+$/.test(v))) return null
  }

  const args = ['browse', positional[0], '--db', dbPath]
  if (typeof flags.path === 'string') args.push('--path', flags.path)
  if (typeof flags.limit === 'string') args.push('--limit', flags.limit)
  if (typeof flags.year === 'string') args.push('--year', flags.year)
  if (flags.json) args.push('--json')
  return args
}

/**
 * `read <target> [--framework F] [--section S] [--max-chars N] [--page P] [--json]`.
 * The target (a path when it contains `/`, else a symbol) is the sole positional;
 * cli.js shows help when it's missing, so fall back then. `--max-chars`/`--page`
 * ride through only as clean non-negative integers (the native verb itself honours
 * the `< 200` floor, so a small value is NOT a fallback trigger); `--framework`/
 * `--section` only as strings.
 *
 * @param {string[]} positional @param {Record<string, unknown>} flags @param {string} dbPath
 * @returns {string[] | null}
 */
function readDocArgs(positional, flags, dbPath) {
  if (positional.length !== 1) return null
  const allowed = new Set(['framework', 'section', 'max-chars', 'page', 'json', ...GLOBAL_PASSTHROUGH])
  if (Object.keys(flags).some((k) => !allowed.has(k))) return null
  for (const k of ['framework', 'section']) {
    if (flags[k] != null && typeof flags[k] !== 'string') return null
  }
  for (const k of ['max-chars', 'page']) {
    const v = flags[k]
    if (v != null && (typeof v !== 'string' || !/^\d+$/.test(v))) return null
  }

  const args = ['read', positional[0], '--db', dbPath]
  if (typeof flags.framework === 'string') args.push('--framework', flags.framework)
  if (typeof flags.section === 'string') args.push('--section', flags.section)
  if (typeof flags['max-chars'] === 'string') args.push('--max-chars', flags['max-chars'])
  if (typeof flags.page === 'string') args.push('--page', flags.page)
  if (flags.json) args.push('--json')
  return args
}
