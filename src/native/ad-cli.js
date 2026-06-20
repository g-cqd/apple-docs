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
 * The per-verb flag contract. A verb is flippable iff its invocation matches its
 * spec exactly; anything outside it (extra positional, unknown flag, mistyped
 * value) returns null so the Bun CLI handles it — nothing is silently dropped.
 *
 * @typedef {object} VerbSpec
 * @property {number} [minPositional]  minimum positionals (default 0)
 * @property {number} [maxPositional]  maximum positionals (default 0; Infinity ⇒ unbounded)
 * @property {boolean} [joinPositional]  emit all positionals joined by a space as ONE arg (the query)
 * @property {string[]} [string]  string-valued flags (`--k v`), passed through only as strings
 * @property {string[]} [int]  flags accepted only as clean non-negative integer strings (`--k n`)
 * @property {string[]} [bool]  boolean flags emitted as bare `--k` when truthy (declare `json` last)
 */

/** @type {Record<string, VerbSpec>} */
const VERB_SPECS = {
  frameworks: { string: ['kind'], bool: ['json'] },
  kinds: { string: ['field'], bool: ['json'] },
  status: { bool: ['advanced', 'json'] },
  browse: { minPositional: 1, maxPositional: 1, string: ['path'], int: ['limit', 'year'], bool: ['json'] },
  read: { minPositional: 1, maxPositional: 1, string: ['framework', 'section'], int: ['max-chars', 'page'], bool: ['json'] },
  search: {
    minPositional: 1,
    maxPositional: Number.POSITIVE_INFINITY,
    joinPositional: true,
    string: SEARCH_STRING_FLAGS,
    int: SEARCH_INT_FLAGS,
    bool: SEARCH_BOOL_FLAGS,
  },
}

/**
 * Map a cli.js read-verb invocation to `ad-cli` argv, or null to fall back to the
 * Bun CLI — for a verb not yet flipped, a subcommand, or a flag/positional the
 * native verb can't faithfully honour. Each flippable verb is described
 * declaratively in `VERB_SPECS`; the shared `validateFlags` enforces it.
 *
 * @param {{ command: string, subcommand: string | undefined, positional: string[], flags: Record<string, unknown>, dbPath: string }} invocation
 * @returns {string[] | null}
 */
export function nativeCliArgs({ command, subcommand, positional, flags, dbPath }) {
  if (subcommand) return null
  const spec = VERB_SPECS[command]
  if (!spec) return null
  const pos = Array.isArray(positional) ? positional : []
  return validateFlags(command, spec, pos, flags, dbPath)
}

/**
 * Validate an invocation against `spec` and build the ad-cli argv, or null to fall
 * back to Bun. The rules are identical for every verb: the positional arity must
 * fit `[minPositional, maxPositional]`; only the verb's own flags + the
 * STDOUT-neutral globals may appear; a string flag must be a string when present;
 * an int flag must be a clean non-negative integer string when present. The argv
 * is `[verb, …positionals, --db, dbPath]` then string, int, then boolean flags in
 * declared order (so the `json` boolean, declared last, trails).
 *
 * @param {string} verb @param {VerbSpec} spec @param {string[]} pos
 * @param {Record<string, unknown>} flags @param {string} dbPath
 * @returns {string[] | null}
 */
function validateFlags(verb, spec, pos, flags, dbPath) {
  const min = spec.minPositional ?? 0
  const max = spec.maxPositional ?? 0
  if (pos.length < min || pos.length > max) return null

  const stringFlags = spec.string ?? []
  const intFlags = spec.int ?? []
  const boolFlags = spec.bool ?? []
  const allowed = new Set([...stringFlags, ...intFlags, ...boolFlags, ...GLOBAL_PASSTHROUGH])
  if (Object.keys(flags).some((k) => !allowed.has(k))) return null
  for (const k of stringFlags) {
    if (flags[k] != null && typeof flags[k] !== 'string') return null
  }
  for (const k of intFlags) {
    const v = flags[k]
    if (v != null && (typeof v !== 'string' || !/^\d+$/.test(v))) return null
  }

  const positionals = max === 0 ? [] : spec.joinPositional ? [pos.join(' ')] : [...pos]
  const args = [verb, ...positionals, '--db', dbPath]
  for (const k of stringFlags) {
    if (typeof flags[k] === 'string') args.push(`--${k}`, flags[k])
  }
  for (const k of intFlags) {
    if (typeof flags[k] === 'string') args.push(`--${k}`, /** @type {string} */ (flags[k]))
  }
  for (const k of boolFlags) {
    if (flags[k]) args.push(`--${k}`)
  }
  return args
}
