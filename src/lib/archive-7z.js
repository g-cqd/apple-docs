/**
 * Deterministic native .7z archive builder.
 *
 * Produces bit-identical output across reruns from the same input tree by:
 *   - sorting member paths under `LC_ALL=C` (stable byte-wise order),
 *   - omitting mtime/ctime/atime fields via `-mtm=off -mtc=off -mta=off`,
 *   - using the locked maximum-LZMA2 flag set from docs/spikes/archive-format.md
 *     (`-mx=9 -m0=lzma2 -md=1024m -mfb=273 -mqs=on`).
 *
 * The 7z binary is discovered on PATH at call time. macOS Homebrew ships
 * `7zz` (sevenzip / Igor Pavlov upstream); Debian/Ubuntu ship `7z` via
 * `p7zip-full`. We prefer `7zz` because it tracks the upstream release
 * cadence and is the binary the bench-off was performed against.
 *
 * Decompression cost ≈ dictionary size (≈1 GiB RAM at `-md=1024m`).
 * Consumers without p7zip installed cannot extract — `apple-docs setup`
 * surfaces a clear "install p7zip" error path.
 *
 * @see docs/spikes/archive-format.md  S0.2 — Archive compression bake-off.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { spawnWithDeadline } from './spawn-with-deadline.js'

/** LZMA2 flag set.
 *
 *  Originally `-mx=9 -md=1024m -mfb=273 -mqs=on` per the S0.2 bake-off
 *  (docs/spikes/archive-format.md). That doc explicitly flagged the
 *  exit case for the 2025 budget:
 *
 *    > When additional weights/scales land and the corpus grows toward
 *    > the projected 4 GB, re-run on the expanded tree before signing
 *    > the format choice in stone … `-md=1024m` may saturate (LZMA2
 *    > dictionary ceiling).
 *
 *  May 2026: the catalog × full weight/scale matrix landed for both
 *  scopes, the full archive grew to ~946k file entries, and `-mx=9`
 *  blew past a 90-minute deadline on a macos-26 runner. The S0.2 winner
 *  is no longer reachable in any reasonable CI budget.
 *
 *  Recalibrated to `-mx=5` (the 7-Zip "Normal" preset) which trades
 *  roughly 5-10% archive size for 3-5x pack speed at this scale. The
 *  other flags are kept: `-md=1024m` is still useful for SVG/text
 *  cross-file redundancy and `-mfb=273` only matters at `-mx>=7`.
 *
 *  When the corpus stabilises, rerun the bake-off and decide whether
 *  to climb back to `-mx=9` or push `-mx=3`. */
export const LZMA2_FLAGS = Object.freeze([
  '-mx=5',
  '-m0=lzma2',
  '-md=1024m',
  '-mqs=on',
  // Determinism: strip per-file timestamps so reruns produce byte-identical
  // archives. 7z's solid-block scheme is already deterministic given a fixed
  // input order; mtimes are the only remaining source of nondeterminism.
  '-mtm=off',
  '-mtc=off',
  '-mta=off',
])

/** Default deadline. The full snapshot archive carries ~1M file entries
 *  (DB + raw JSON + markdown + ~266k pre-rendered SVG variants + fonts);
 *  at LZMA2 `-mx=5` we'd expect ~10-15 min on a macos-26 runner with
 *  current corpus shape, so 60 min leaves 4-6x headroom. The previous
 *  90-min ceiling held with `-mx=9` until it didn't; this is the new
 *  safe budget after the May 2026 compression recalibration. */
const DEFAULT_DEADLINE_MS = 60 * 60_000

/**
 * Resolve the 7z CLI on PATH. Prefers `7zz` (Homebrew `sevenzip`, upstream
 * binary) and falls back to `7z` (Debian `p7zip-full`).
 *
 * @param {{ which?: (bin: string) => string | null }} [deps]
 * @returns {string} Resolved binary name (callable via spawn — it's on PATH).
 * @throws {Error} when neither binary is available.
 */
export function resolveSevenZipBinary(deps = {}) {
  const which = deps.which ?? defaultWhich
  for (const bin of ['7zz', '7z']) {
    const resolved = which(bin)
    if (resolved) return bin
  }
  throw new Error(
    'Neither `7zz` nor `7z` is on PATH. Install p7zip to build / extract ' +
    'snapshot archives:\n' +
    '  macOS:  brew install sevenzip   # ships 7zz\n' +
    '  Debian: apt install p7zip-full  # ships 7z',
  )
}

function defaultWhich(bin) {
  const res = spawnSync('/usr/bin/env', ['which', bin], { encoding: 'utf8' })
  if (res.status === 0 && res.stdout.trim()) return res.stdout.trim()
  return null
}

/**
 * Walk a directory tree and return every regular file path, relative to
 * `root`, sorted byte-wise (LC_ALL=C equivalent). Directories are not
 * listed — 7z infers them from member paths.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function listFilesSorted(root) {
  /** @type {string[]} */
  const files = []
  walk(root, '', files)
  // Byte-wise (POSIX) ordering: JS string < operator compares UTF-16 code
  // units, which matches LC_ALL=C ordering for ASCII paths. Snapshot paths
  // are ASCII (font / symbol / framework names), so this is the same order
  // a `find … | LC_ALL=C sort` would produce.
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return files
}

function walk(absRoot, relDir, out) {
  const absDir = relDir ? join(absRoot, relDir) : absRoot
  const entries = readdirSync(absDir, { withFileTypes: true })
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      walk(absRoot, rel, out)
    } else if (entry.isFile()) {
      out.push(rel)
    }
    // Symlinks and special files are intentionally ignored — none belong in a
    // snapshot archive and the existing tar validator rejects them too.
  }
}

/**
 * Create a deterministic .7z archive from `sourceDir`.
 *
 * The archive is built with `cwd = sourceDir` and an explicit `@listfile`
 * fed via stdin, so member paths in the resulting archive are relative to
 * `sourceDir` (no leading `./` or absolute prefix).
 *
 * @param {object} args
 * @param {string} args.sourceDir       Absolute path to the tree to archive.
 * @param {string} args.outputPath      Absolute path to write the .7z to.
 * @param {string} [args.name]          Logical name for logging (defaults to basename of outputPath).
 * @param {{info?: Function, warn?: Function, error?: Function}} [args.logger]
 * @param {number} [args.deadlineMs]    Override the spawn deadline.
 * @param {{spawn?: typeof Bun.spawn, which?: Function}} [args.deps]
 * @returns {Promise<{outputPath: string, fileCount: number, size: number, binary: string}>}
 */
export async function createSevenZipArchive({
  sourceDir,
  outputPath,
  name,
  logger,
  deadlineMs,
  deps = {},
}) {
  const log = logger ?? { info() {}, warn() {}, error() {} }
  const binary = resolveSevenZipBinary(deps)
  const files = listFilesSorted(sourceDir)
  if (files.length === 0) {
    throw new Error(`createSevenZipArchive: no files under ${sourceDir}`)
  }

  // `7zz a` appends to an existing archive, which would silently make output
  // nondeterministic across runs that don't start from a clean slate. Delete
  // any prior artefact before invoking.
  if (existsSync(outputPath)) unlinkSync(outputPath)

  log.info?.(`[archive-7z] ${binary}: ${name ?? outputPath} (${files.length} files)`)

  // 7zz requires a seekable listfile (`errno=29 : Illegal seek` on /dev/stdin),
  // so write the sorted file list to a temp file in the parent of outputPath.
  // The listfile encodes the canonical member order — combined with the
  // mtime-off flags this gives bit-identical output across reruns.
  const listDir = mkdtempSync(join(tmpdir(), 'apple-docs-7z-list-'))
  const listPath = join(listDir, 'files.lst')
  writeFileSync(listPath, `${files.join('\n')}\n`)

  const args = [
    binary,
    'a',
    '-t7z',
    ...LZMA2_FLAGS,
    outputPath,
    `@${listPath}`,
  ]

  try {
    const { stderr, exitCode } = await spawnWithDeadline(args, {
      deadlineMs: deadlineMs ?? DEFAULT_DEADLINE_MS,
      cwd: sourceDir,
      env: {
        ...process.env,
        // Force POSIX ordering for any 7zz-internal sort fallback.
        LC_ALL: 'C',
      },
    })
    if (exitCode !== 0) {
      throw new Error(`7z archive build failed (exit ${exitCode}): ${stderr.trim()}`)
    }
  } finally {
    rmSync(listDir, { recursive: true, force: true })
  }

  const stat = statSync(outputPath)
  log.info?.(`[archive-7z] wrote ${outputPath} (${formatSize(stat.size)})`)

  return {
    outputPath,
    fileCount: files.length,
    size: stat.size,
    binary,
  }
}

/**
 * Compute the SHA-256 of a file and write a `<filename>.sha256` sidecar
 * in the shasum(1) format (`<hex>  <basename>\n`).
 *
 * @param {string} archivePath
 * @returns {Promise<{sidecarPath: string, sha256: string}>}
 */
export async function writeSha256Sidecar(archivePath) {
  const bytes = await Bun.file(archivePath).arrayBuffer()
  const sha256 = new Bun.CryptoHasher('sha256').update(new Uint8Array(bytes)).digest('hex')
  // basename only — matches `shasum -a 256 <file>` output when the caller
  // runs shasum with a bare filename from the file's parent dir.
  const filename = archivePath.split(sep).pop()
  const sidecarPath = `${archivePath}.sha256`
  await Bun.write(sidecarPath, `${sha256}  ${filename}\n`)
  return { sidecarPath, sha256 }
}

function formatSize(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} B`
}

// Internal helpers (walk, defaultWhich) are exercised through the public
// API surface (createSevenZipArchive, resolveSevenZipBinary) and don't
// need a dedicated test export.
