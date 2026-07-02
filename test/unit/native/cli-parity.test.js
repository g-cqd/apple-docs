// Live golden parity gate for the P7 CLI flip (RFC 0007): the native `ad-cli`
// read verbs vs the Bun `cli.js` oracle, over a real corpus. The Bun path is
// pinned with APPLE_DOCS_NATIVE=off (the JS implementation is the reference);
// the native path runs the `ad-cli` binary directly. Both are captured PIPED
// (non-TTY) so the comparison is the plain, ANSI-free output.
//
// Three assertions per case: human output byte-identical; --json byte-identical
// AND intrinsically equal (parsed deep-equal — the plan's required gate). A
// final block exercises the end-to-end cli.js→ad-cli flip wiring.
//
// Skipped (not failed) when no `ad-cli` binary or no corpus is present, so the
// suite stays green on a bare checkout. Point it explicitly with AD_CLI_BIN +
// AD_PARITY_HOME.

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Each case spawns a real Bun cli.js (and sometimes a nested ad-cli) against the
// full ~2.6 GB corpus; a cold broad `kinds` (5 GROUP BYs) or an unbounded browse
// can take ~10 s, well past bun's 5 s default. Give the whole suite room.
setDefaultTimeout(30_000)

const ROOT = new URL('../../../', import.meta.url).pathname
const dec = new TextDecoder()

/** @returns {string | null} The data dir (holding apple-docs.db), or null. */
function resolveHome() {
  const candidates = [process.env.AD_PARITY_HOME, join(homedir(), 'Public/apple-docs-testing-native'), join(homedir(), '.apple-docs')].filter(Boolean)
  return candidates.find((d) => existsSync(join(/** @type {string} */ (d), 'apple-docs.db'))) ?? null
}

/** @returns {string | null} The ad-cli binary, or null. */
function resolveAdCli() {
  const candidates = [process.env.AD_CLI_BIN, join(ROOT, 'swift/.build/release/ad-cli'), join(ROOT, 'swift/.build/debug/ad-cli')].filter(Boolean)
  return candidates.find((p) => existsSync(/** @type {string} */ (p))) ?? null
}

/**
 * @returns {string | null} The libAppleDocsCore dylib, or null. The Bun search
 * oracle (`runJsNativeOn`) embeds via this dylib; without it the JS embed path is
 * unavailable and the JS SEMANTIC TIER goes DORMANT (lexical-only), so a native
 * (semantic-live) vs JS (lexical-only) search comparison would FALSELY diverge.
 * The search block is gated on this so it skips — rather than false-fails — when
 * the dylib isn't built. Read verbs don't touch it.
 */
function resolveDylib() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  const candidates = [join(ROOT, `dist/native/${process.platform}-${arch}/libAppleDocsCore.dylib`), join(ROOT, 'swift/.build/release/libAppleDocsCore.dylib')]
  return candidates.find((p) => existsSync(p)) ?? null
}

const dataDir = resolveHome()
const adCli = resolveAdCli()
const dylib = resolveDylib()
const dbPath = dataDir ? join(dataDir, 'apple-docs.db') : ''
const ready = Boolean(dataDir && adCli)
if (!ready) {
  console.warn(`cli-parity: skipped (adCli=${adCli ?? 'none'}, home=${dataDir ?? 'none'}); build ad-cli + install a corpus, or set AD_CLI_BIN + AD_PARITY_HOME`)
} else if (!dylib) {
  console.warn(
    'cli-parity: SEARCH cases skipped — libAppleDocsCore.dylib not built, so the Bun oracle’s semantic tier is dormant (lexical-only). Run `swift build -c release` (or build the AppleDocsCore product) to enable the fair semantic comparison.',
  )
}

/** Bun JS oracle — force the JS path (APPLE_DOCS_NATIVE=off ⇒ no cli flip). @param {string[]} args */
function runJs(args) {
  const p = Bun.spawnSync(['bun', join(ROOT, 'cli.js'), ...args, '--home', /** @type {string} */ (dataDir)], {
    env: { ...process.env, APPLE_DOCS_NATIVE: 'off' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return dec.decode(p.stdout)
}

/** Native ad-cli, invoked directly. @param {string[]} args */
function runNative(args) {
  const p = Bun.spawnSync([/** @type {string} */ (adCli), ...args, '--db', dbPath], { stdout: 'pipe', stderr: 'pipe' })
  return dec.decode(p.stdout)
}

/** cli.js with the flip ON, pinned to our ad-cli binary (end-to-end wiring). @param {string[]} args */
function runFlip(args) {
  const p = Bun.spawnSync(['bun', join(ROOT, 'cli.js'), ...args, '--home', /** @type {string} */ (dataDir)], {
    env: { ...process.env, APPLE_DOCS_NATIVE: 'cli', APPLE_DOCS_NATIVE_CLI_BIN: /** @type {string} */ (adCli) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return dec.decode(p.stdout)
}

/**
 * Bun oracle with native compute modules ON (APPLE_DOCS_NATIVE unset = the real
 * default UX: native fusion + embedder, so the SEMANTIC tier is live). Used for
 * `search`, whose results differ from the lexical-only (off) path. ad-cli search
 * is fully native and must match this. @param {string[]} args
 */
function runJsNativeOn(args) {
  const env = { ...process.env }
  delete env.APPLE_DOCS_NATIVE
  const p = Bun.spawnSync(['bun', join(ROOT, 'cli.js'), ...args, '--home', /** @type {string} */ (dataDir)], { env, stdout: 'pipe', stderr: 'pipe' })
  return dec.decode(p.stdout)
}

/** @type {Array<[string, string[]]>} */
const HUMAN_CASES = [
  ['frameworks', []],
  ['frameworks', ['--kind', 'framework']],
  ['frameworks', ['--kind', '__nonexistent__']], // empty-roots branch
  ['kinds', []],
  ['kinds', ['--field', 'role']],
  ['kinds', ['--field', 'docKind']], // kind-alias
  ['kinds', ['--field', 'bogus']], // unknown field ⇒ broad shape on both sides
  ['browse', ['swiftui', '--limit', '5']], // browse pages variant, bounded so --json fits Bun.spawnSync's stdout buffer
  ['browse', ['wwdc']], // browse wwdc groups variant
]

const JSON_CASES = HUMAN_CASES.map(([verb, flags]) => /** @type {[string, string[]]} */ ([verb, [...flags, '--json']]))

const d = ready ? describe : describe.skip

d('CLI read-verb parity: ad-cli (native) vs cli.js (Bun oracle)', () => {
  for (const [verb, flags] of HUMAN_CASES) {
    test(`human: ${verb} ${flags.join(' ')}`.trim(), () => {
      const args = [verb, ...flags]
      expect(runNative(args)).toBe(runJs(args))
    })
  }

  for (const [verb, flags] of JSON_CASES) {
    test(`json: ${verb} ${flags.join(' ')}`.trim(), () => {
      const args = [verb, ...flags]
      const native = runNative(args)
      const js = runJs(args)
      // Intrinsic parity (the required gate) + byte parity (the strong goal).
      expect(JSON.parse(native)).toEqual(JSON.parse(js))
      expect(native).toBe(js)
    })
  }
})

/** @type {Array<[string, string[]]>} */
const FLIP_CASES = [
  ['frameworks', []],
  ['frameworks', ['--json']],
  ['kinds', []],
  ['kinds', ['--field', 'role', '--json']],
]

d('CLI flip wiring: cli.js (APPLE_DOCS_NATIVE=cli) == cli.js (Bun oracle)', () => {
  for (const [verb, flags] of FLIP_CASES) {
    test(`flip: ${verb} ${flags.join(' ')}`.trim(), () => {
      const args = [verb, ...flags]
      expect(runFlip(args)).toBe(runJs(args))
    })
  }
})

/** @type {Array<[string, string[]]>} */
const BROWSE_ERROR_CASES = [
  ['unknown framework', ['browse', '__nonexistent__']],
  ['year on a non-wwdc root', ['browse', 'swiftui', '--year', '2024']],
]

d('browse errors: ad-cli == cli.js (empty stdout + exit 1)', () => {
  for (const [label, args] of BROWSE_ERROR_CASES) {
    test(label, () => {
      const js = Bun.spawnSync(['bun', join(ROOT, 'cli.js'), ...args, '--home', /** @type {string} */ (dataDir)], {
        env: { ...process.env, APPLE_DOCS_NATIVE: 'off' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const nat = Bun.spawnSync([/** @type {string} */ (adCli), ...args, '--db', dbPath], { stdout: 'pipe', stderr: 'pipe' })
      expect(dec.decode(js.stdout)).toBe('')
      expect(dec.decode(nat.stdout)).toBe('')
      expect(js.exitCode).toBe(1)
      expect(nat.exitCode).toBe(1)
    })
  }
})

// The children (--path) and wwdc-year variants need a real path/year from the
// corpus; discover one from the Bun oracle, then assert both sides agree. Skips
// (returns) gracefully if the corpus lacks swiftui pages / wwdc groups.
d('browse dynamic variants (discovered path/year)', () => {
  test('children variant via a discovered page path', () => {
    let path
    try {
      path = JSON.parse(runJs(['browse', 'swiftui', '--limit', '1', '--json'])).pages?.[0]?.path
    } catch {
      return
    }
    if (typeof path !== 'string') return
    const args = ['browse', 'swiftui', '--path', path]
    expect(runNative(args)).toBe(runJs(args))
    expect(runNative([...args, '--json'])).toBe(runJs([...args, '--json']))
  })
  test('wwdc year variant via a discovered year', () => {
    let year
    try {
      year = JSON.parse(runJs(['browse', 'wwdc', '--json'])).groups?.[0]?.year
    } catch {
      return
    }
    if (typeof year !== 'number') return
    const args = ['browse', 'wwdc', '--year', String(year)]
    expect(runNative(args)).toBe(runJs(args))
    expect(runNative([...args, '--json'])).toBe(runJs([...args, '--json']))
  })
})

// The default (unbounded) browse — human only. The formatter caps the listing at
// 50 rows + a "... and N more" footer, so the human output stays small; the --json
// variant would be megabytes and overflow Bun.spawnSync's stdout buffer (the
// JSON cases above are deliberately bounded), so it isn't asserted here.
d('browse default unbounded (human, capped display)', () => {
  test('browse swiftui', () => {
    expect(runNative(['browse', 'swiftui'])).toBe(runJs(['browse', 'swiftui']))
  })
})

// read (lookup) parity. Content reads are bounded with --max-chars so the output
// fits Bun.spawnSync's stdout buffer (a full doc can exceed it); the path/symbol
// is discovered from the corpus so the suite is corpus-agnostic.
d('read parity (discovered swiftui doc)', () => {
  // pages[0] is the slug-less root ("swiftui") → exercises the symbol resolver
  // (searchByTitle); the first path containing "/" exercises the path resolver
  // (getPage). The two differ in JS (raw vs aliased columns → metadata shape),
  // so cover both.
  /** @type {string | undefined} */
  let path
  /** @type {string | undefined} */
  let subPath
  if (ready) {
    try {
      const pages = JSON.parse(runJs(['browse', 'swiftui', '--limit', '20', '--json'])).pages ?? []
      path = pages[0]?.path
      subPath = pages.map((/** @type {any} */ p) => p.path).find((/** @type {any} */ p) => typeof p === 'string' && p.includes('/'))
    } catch {
      path = undefined
    }
  }
  /** Compare a read invocation human + --json. @param {string[]} args */
  const cmp = (args) => {
    expect(runNative(args)).toBe(runJs(args))
    const j = [...args, '--json']
    expect(runNative(j)).toBe(runJs(j))
  }

  test('not found (human "Not found:" + json {found:false})', () => {
    cmp(['read', '__no/such/doc__'])
  })
  test('content, bounded page', () => {
    if (typeof path !== 'string') return
    cmp(['read', path, '--max-chars', '8000'])
  })
  test('content via a path target (contains /, getPage resolver)', () => {
    if (typeof subPath !== 'string') return
    cmp(['read', subPath, '--max-chars', '8000'])
  })
  test('pagination page 2, bounded', () => {
    if (typeof path !== 'string') return
    cmp(['read', path, '--max-chars', '2000', '--page', '2'])
  })
  test('--max-chars below the 200 floor → error content', () => {
    if (typeof path !== 'string') return
    cmp(['read', path, '--max-chars', '100'])
  })
  test('section extraction (deterministic whether matched or not)', () => {
    if (typeof path !== 'string') return
    cmp(['read', path, '--section', 'Overview'])
  })
  test('symbol lookup via discovered title + rootSlug', () => {
    if (typeof path !== 'string') return
    let meta
    try {
      meta = JSON.parse(runJs(['read', path, '--max-chars', '300', '--json'])).metadata
    } catch {
      return
    }
    if (typeof meta?.title !== 'string' || typeof meta?.rootSlug !== 'string') return
    cmp(['read', meta.title, '--framework', meta.rootSlug, '--max-chars', '8000'])
  })
})

// search parity — the FULL cascade INCLUDING the semantic tier. Oracle = cli.js
// with native compute ON (APPLE_DOCS_NATIVE unset ⇒ semantic live); ad-cli is
// fully native and must byte-match. Bounded --limit so output fits the spawn
// buffer. FAILS until ad-cli has `search` (Stage 2+3) — these gate that work.
/** @type {Array<[string, string[]]>} */
const SEARCH_CASES = [
  ['search', ['view', '--limit', '10']],
  ['search', ['navigation', 'stack', '--limit', '10']],
  ['search', ['async', 'await', '--limit', '5']],
  ['search', ['swiftui', 'button', '--framework', 'swiftui', '--limit', '5']],
]

// Gated on the dylib too: the oracle's semantic tier needs the native embed path.
const dSearch = ready && dylib ? describe : describe.skip
dSearch('search parity (native cascade + semantic) vs cli.js native-on oracle', () => {
  for (const [verb, flags] of SEARCH_CASES) {
    test(`human: ${verb} ${flags.join(' ')}`.trim(), () => {
      const args = [verb, ...flags]
      expect(runNative(args)).toBe(runJsNativeOn(args))
    })
    test(`json: ${verb} ${flags.join(' ')}`.trim(), () => {
      const args = [verb, ...flags, '--json']
      const native = runNative(args)
      const js = runJsNativeOn(args)
      expect(JSON.parse(native)).toEqual(JSON.parse(js))
      expect(native).toBe(js)
    })
  }
  test('--read mode (top hit + bounded content)', () => {
    const args = ['search', 'view', '--limit', '5', '--read', '--max-chars', '4000']
    expect(runNative(args)).toBe(runJsNativeOn(args))
  })
})

// status parity. The GitHub update-check is non-deterministic, so both sides skip
// it via APPLE_DOCS_SKIP_UPDATE_CHECK (production still checks). Corpus stats +
// freshness (daysSinceSync via current time is stable within a run) + db/dir
// sizing are deterministic. FAILS until ad-cli has `status` (#25).
//
// Timeout: status recursively sizes raw-json/ + markdown/ (~727k files on the
// live corpus). That walk is I/O-latency-bound — a bare `find -type f` over both
// trees takes ~25 s here, and each side (Bun ~40 s, native ~40 s) sits near that
// floor — so one test (nat + js, two full walks) runs ~80 s and the 30 s default
// can never hold. 240 s ≈ 3× the measured worst case.
const STATUS_TIMEOUT = 240_000
d('status parity (update-check skipped for determinism)', () => {
  const STATUS_ENV = { ...process.env, APPLE_DOCS_NATIVE: 'off', APPLE_DOCS_SKIP_UPDATE_CHECK: '1' }
  /** @param {string[]} args */
  const js = (args) =>
    dec.decode(
      Bun.spawnSync(['bun', join(ROOT, 'cli.js'), ...args, '--home', /** @type {string} */ (dataDir)], { env: STATUS_ENV, stdout: 'pipe', stderr: 'pipe' })
        .stdout,
    )
  /** @param {string[]} args */
  const nat = (args) =>
    dec.decode(Bun.spawnSync([/** @type {string} */ (adCli), ...args, '--db', dbPath], { env: STATUS_ENV, stdout: 'pipe', stderr: 'pipe' }).stdout)

  for (const flags of [[], ['--advanced']]) {
    test(
      `human: status ${flags.join(' ')}`.trim(),
      () => {
        expect(nat(['status', ...flags])).toBe(js(['status', ...flags]))
      },
      STATUS_TIMEOUT,
    )
    test(
      `json: status ${flags.join(' ')}`.trim(),
      () => {
        const args = ['status', ...flags, '--json']
        const n = nat(args)
        const j = js(args)
        expect(JSON.parse(n)).toEqual(JSON.parse(j))
        expect(n).toBe(j)
      },
      STATUS_TIMEOUT,
    )
  }
})
