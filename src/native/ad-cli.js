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
 * @property {'db' | 'home' | 'none'} [corpusFlag]  how the corpus location is passed: `--db <dbPath>`
 *   (default — the read verbs), `--home <dirname(dbPath)>` (verbs that embed the HOME itself in
 *   their output, e.g. `mcp install`), or `'none'` (pure-stdout verbs whose native twin takes no
 *   corpus flag at all, e.g. `web deploy`)
 */

/**
 * @type {Record<string, VerbSpec>}
 * A key is either a bare verb or `"verb subcommand"` — the subcommand-keyed
 * form delegates exactly that subcommand (`storage stats`); every other
 * subcommand of the family falls back to Bun.
 */
const VERB_SPECS = {
  frameworks: { string: ['kind'], bool: ['json'] },
  version: { bool: ['json'] },
  'storage stats': { bool: ['json'] },
  'storage check-orphans': { bool: ['json'] },
  // GET and SET forms — both byte-diffed identical (human + --json) against the oracle on a
  // scratch corpus (set-form gate: `storage profile compact`/`balanced`, 2026-07-09).
  'storage profile': { maxPositional: 1, bool: ['json'] },
  // The write-path maintenance verbs, flipped after per-verb stdout byte-diffs against the
  // oracle on scratch corpora (2026-07-09; the port itself was oracle-gated down to
  // sha256-identical compacted cells). stderr DIAGNOSTICS deliberately differ in format
  // (JS emits JSON log lines, native plain text) — stdout is the parity surface.
  'storage gc': { string: ['drop'], int: ['older-than'], bool: ['json'] },
  'storage materialize': { string: ['format', 'roots'], bool: ['json'] },
  'storage compact': { bool: ['force', 'keep-raw', 'json'] },
  prune: { bool: ['dry-run', 'no-vacuum', 'json'] },
  consolidate: { bool: ['dry-run', 'minify', 'json'] },
  'index rebuild': { maxPositional: 1, bool: ['json'] },
  // Aligned + flipped 2026-07-09: the native summary/error envelopes now byte-match the JS
  // (`index embeddings: {…}` incl. the soft no-embedder outcome, exit 0).
  'index embeddings': { bool: ['full', 'json'] },
  // Aligned + flipped 2026-07-09: the native build now prints the JS formatWebBuild summary
  // block to stdout (its own ledger stays on stderr). Byte-shaped identical on both skip-docs
  // and full builds incl. the comma-grouped Links line; the Duration VALUE is inherently
  // volatile (wall clock), exactly as between two JS runs. No 'json' — the full JSON envelope
  // (dirs/artifacts/…) is unaudited, so --json falls back to Bun. `snapshot build` stays
  // unflipped: cross-engine archives are NOT byte-identical yet (821,107 vs 822,557 bytes on
  // the same DB) — that determinism gap needs its own gate before the release artifact flips.
  'web build': {
    string: ['out', 'base-url', 'site-name'],
    bool: ['skip-docs', 'incremental', 'full'],
  },
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
  // Pure stdout (no corpus flag on the native twin). Known, deliberate divergence: the native
  // output appends the build/serve architecture note (human + a `note` JSON field) explaining
  // that `web build` emits the static site while `ad-server serve` hosts the APIs — an
  // operator-approved addition, not drift (see WebDeploy.swift).
  'web deploy': { maxPositional: 1, bool: ['json'], corpusFlag: 'none' },
  // Embeds the resolved HOME in its printed client config, so it takes `--home`, not `--db`.
  // Bare invocation only — any flag (--http/--endpoint) falls back to Bun until the flag-shape
  // mismatch (JS `--http [url]` vs native `--http --endpoint <url>`) is reconciled.
  'mcp install': { corpusFlag: 'home' },
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
  // A subcommand invocation flips only via its own `"verb subcommand"` spec;
  // an unlisted subcommand (or any subcommand of a bare-keyed verb) falls
  // back to Bun, exactly as before.
  const key = subcommand ? `${command} ${subcommand}` : command
  const spec = VERB_SPECS[key]
  if (!spec) return null
  const pos = Array.isArray(positional) ? positional : []
  const verb = subcommand ? [command, subcommand] : [command]
  return validateFlags(verb, spec, pos, flags, dbPath)
}

/**
 * Validate an invocation against `spec` and build the ad-cli argv, or null to fall
 * back to Bun. The rules are identical for every verb: the positional arity must
 * fit `[minPositional, maxPositional]`; only the verb's own flags + the
 * STDOUT-neutral globals may appear; a string flag must be a string when present;
 * an int flag must be a clean non-negative integer string when present. The argv
 * is `[…verb, …positionals, --db, dbPath]` then string, int, then boolean flags
 * in declared order (so the `json` boolean, declared last, trails). `verb` is
 * the argv prefix — `['storage', 'stats']` for a subcommand-keyed spec.
 *
 * @param {string[]} verb @param {VerbSpec} spec @param {string[]} pos
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
  const corpusFlag = spec.corpusFlag ?? 'db'
  const corpusArgs = corpusFlag === 'none' ? [] : corpusFlag === 'home' ? ['--home', dbPath.replace(/\/apple-docs\.db$/, '')] : ['--db', dbPath]
  const args = [...verb, ...positionals, ...corpusArgs]
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
