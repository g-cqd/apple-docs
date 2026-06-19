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
 * This slice flips two read verbs: `frameworks` (→ `--kind`) and `kinds`
 * (→ `--field`). Both are read-only, take no positional, and only their single
 * filter + `--json` ride through; anything else forces the Bun path so nothing is
 * silently dropped.
 *
 * @param {{ command: string, subcommand: string | undefined, positional: string[], flags: Record<string, unknown>, dbPath: string }} invocation
 * @returns {string[] | null}
 */
export function nativeCliArgs({ command, subcommand, positional, flags, dbPath }) {
  if (subcommand) return null
  if (Array.isArray(positional) && positional.length > 0) return null
  if (command === 'frameworks') return readVerbArgs('frameworks', 'kind', flags, dbPath)
  if (command === 'kinds') return readVerbArgs('kinds', 'field', flags, dbPath)
  return null
}

/**
 * Shared shape for the two single-filter read verbs. Falls back (null) on any
 * unsupported flag, or a filter passed without a string value (`--kind --json`
 * leaves `flags.kind === true`, whose JS coercion we don't replicate).
 *
 * @param {string} verb @param {string} filter @param {Record<string, unknown>} flags @param {string} dbPath
 * @returns {string[] | null}
 */
function readVerbArgs(verb, filter, flags, dbPath) {
  const allowed = new Set([filter, 'json', ...GLOBAL_PASSTHROUGH])
  if (Object.keys(flags).some((k) => !allowed.has(k))) return null
  const filterValue = flags[filter]
  if (filterValue != null && typeof filterValue !== 'string') return null

  const args = [verb, '--db', dbPath]
  if (typeof filterValue === 'string') args.push(`--${filter}`, filterValue)
  if (flags.json) args.push('--json')
  return args
}
