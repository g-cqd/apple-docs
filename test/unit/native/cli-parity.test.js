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

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

const dataDir = resolveHome()
const adCli = resolveAdCli()
const dbPath = dataDir ? join(dataDir, 'apple-docs.db') : ''
const ready = Boolean(dataDir && adCli)
if (!ready) {
  console.warn(`cli-parity: skipped (adCli=${adCli ?? 'none'}, home=${dataDir ?? 'none'}); build ad-cli + install a corpus, or set AD_CLI_BIN + AD_PARITY_HOME`)
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

/** @type {Array<[string, string[]]>} */
const HUMAN_CASES = [
  ['frameworks', []],
  ['frameworks', ['--kind', 'framework']],
  ['frameworks', ['--kind', '__nonexistent__']], // empty-roots branch
  ['kinds', []],
  ['kinds', ['--field', 'role']],
  ['kinds', ['--field', 'docKind']], // kind-alias
  ['kinds', ['--field', 'bogus']], // unknown field ⇒ broad shape on both sides
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
