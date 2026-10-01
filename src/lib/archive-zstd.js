import { ValidationError } from "../lib/errors.js"
/**
 * Deterministic `tar.zst` archive builder. Replaces the `tar.gz` path:
 * `zstd -9 -T3` is ~15% smaller AND ~5× faster than `gzip -9` on the
 * corpus shape (verified on the SF-Symbol SVG set), and multithreaded so
 * it scales on the CI runner. Higher levels (>12) trade huge time for a
 * few % more ratio — `-9` is the sweet spot.
 *
 * Pipeline (zstd CLI present — CI and dev machines with zstd): ONE kernel pipe
 * `tar -cf - | zstd -o <out>` created by `bash` (never by Bun). Writing an
 * uncompressed intermediate tar next to the output cost ~11.5 GB of peak
 * disk on the full snapshot (the staged tree is already on disk at that
 * point) and was what tipped the xcode-27 runner into SQLITE_FULL/ENOSPC.
 * The historical reason for the intermediate file was Bun's own
 * process-to-process plumbing, which pumps a pipe unreliably past one pipe
 * buffer on Linux (small archives fine, the full corpus truncates) and Node's
 * `pipeline(tar.stdout, zstd.stdin)` throwing `EINVAL … send` at multi-GB —
 * a bash-owned pipe never goes through either, and `pipefail` surfaces a
 * failure of EITHER side. The truncation guard is kept as a post-hoc
 * decompress-and-count (`zstd -dc | tar -t | wc -l`, also bash-owned): no
 * extra disk, ~1 s per GB.
 *
 * Fallback (no zstd CLI): `tar -cf <tmp.tar>` then Bun's CompressionStream —
 * the intermediate-file discipline the consumer (setup) and the old
 * `.tar.gz` path use. Dev machines only; the tar is verified by member count.
 *
 * Output note: a streamed zstd frame carries no decompressed-size field
 * (size unknown at the pipe), so the bytes differ from the file-input form
 * once — they stay bit-identical across reruns, which is what the gate needs.
 *
 * Determinism: paths come from `listFilesSorted` (LC_ALL=C order) fed to
 * tar via a temp listfile + `--no-recursion`; zstd output is bit-identical
 * across reruns for a fixed level / thread count / zstd version (never use
 * `--adapt`). mtimes are clamped by the caller (snapshot.js). The gate in
 * `.github/workflows/snapshot.yml` verifies bit-identity across two builds.
 * `--long=27` widens the match window to 128 MB — the dominant ratio lever
 * on this corpus (cross-document DocC JSON redundancy far exceeds the
 * default window) and verified decodable by Bun's zstd on the consumer
 * (both `Bun.zstdDecompressSync` and `DecompressionStream('zstd')`).
 *
 * Decompression: macOS ships NO zstd and Apple's bsdtar lacks libzstd, so
 * the consumer (`apple-docs setup`) decodes with Bun's built-in zstd — no
 * system zstd required (see src/commands/setup.js).
 *
 * Build host: prefers the `zstd` CLI (multithreaded) and falls back to
 * Bun's single-threaded `CompressionStream("zstd")` when the CLI is absent
 * (dev machines). CI always has the CLI, so the gate uses the fast path.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { listFilesSorted } from './archive-7z.js'

const DEFAULT_DEADLINE_MS = 60 * 60_000
// -9 (ratio sweet spot) / -T3 (3-core runner) / --long=27 (128 MB match
// window). Long-window matching is the single biggest ratio lever on this
// corpus: DocC JSON payloads and SVG renders repeat across the multi-GB tar
// far beyond the default level-9 window (measured: 2183 MB → 1904 MB AND
// 65 s → 24 s on the 6.6 GB snapshot tar — the wider window also finds
// matches faster than entropy-coding unmatched bytes). Consumers decode
// with Bun's zstd, which handles the 2^27 window on both
// Bun.zstdDecompressSync and DecompressionStream('zstd') (verified on
// Bun 1.3.x; the old "no --long" note predates that support).
// Pinned so the determinism gate stays byte-stable; NEVER add --adapt.
const ZSTD_ARGS = ['-9', '-T3', '--long=27', '-q', '-f']

function findZstd() {
  const candidates = [process.env.ZSTD_BIN, '/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd']
  for (const c of candidates) { if (c && existsSync(c)) return c }
  // Last resort: anything named `zstd` on PATH (covers the CI runner, where
  // it may live outside the well-known prefixes above).
  try { return Bun.which('zstd') } catch { return null }
}

async function readStderr(proc) {
  try { return (await new Response(proc.stderr).text()).trim().slice(0, 4096) || '<no stderr>' }
  catch { return '<no stderr>' }
}

const BASH = () => Bun.which('bash') ?? '/bin/bash'

/** Run `bash -c <script> bash ...args`; resolves `{ code, stdout, stderr }`. */
async function runBash(script, args, { cwd, deadlineMs }) {
  const proc = Bun.spawn([BASH(), '-c', script, 'bash', ...args], {
    cwd,
    env: { ...process.env, LC_ALL: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: deadlineMs,
    killSignal: 'SIGKILL',
  })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, stdout, stderr: await readStderr(proc) }
}

function assertMemberCount(members, expected, name) {
  if (members !== expected) {
    throw new ValidationError(
      `tar.zst integrity check failed for ${name}: archive lists ${members} members but ${expected} were staged — truncated or corrupt`,
    )
  }
}

// $1 file list, $2 zstd, $3 output, $4.. zstd flags. `pipefail`: a tar failure
// must fail the whole pipeline even though zstd (the last stage) exits 0.
const STREAM_SCRIPT = 'set -o pipefail; tar -cf - --no-recursion -T "$1" | "$2" "${@:4}" -o "$3"'
// $1 archive. Decompress + list + count entirely in the pipe — no disk.
const VERIFY_SCRIPT = 'set -o pipefail; "$1" -dc --long=27 "$2" | tar -tf - | wc -l'

async function streamTarToZstd({ sourceDir, listPath, zstdBin, absOutput, expected, name, deadlineMs }) {
  const made = await runBash(STREAM_SCRIPT, [listPath, zstdBin, absOutput, ...ZSTD_ARGS], { cwd: sourceDir, deadlineMs })
  if (made.code !== 0) throw new ValidationError(`tar.zst: tar|zstd pipeline exit ${made.code}: ${made.stderr}`)

  // Truncation guard (was: count the intermediate tar). A short count means
  // tar was cut short — the failure that once shipped a 199 MB (vs 1.6 GB)
  // archive past the old gzip path.
  const checked = await runBash(VERIFY_SCRIPT, [zstdBin, absOutput], { cwd: sourceDir, deadlineMs })
  if (checked.code !== 0) throw new ValidationError(`tar.zst integrity check: decompress/list failed (exit ${checked.code}): ${checked.stderr}`)
  assertMemberCount(Number.parseInt(checked.stdout.trim(), 10), expected, name)
}

async function tarThenBunZstd({ sourceDir, listPath, absOutput, expected, name, deadlineMs }) {
  // Intermediate tar lives next to the output (same volume). Always removed.
  const tarTmp = `${absOutput}.building.tar`
  try {
    if (existsSync(tarTmp)) unlinkSync(tarTmp)
    const tarProc = Bun.spawn(['tar', '-cf', tarTmp, '--no-recursion', '-T', listPath], {
      cwd: sourceDir,
      env: { ...process.env, LC_ALL: 'C' },
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: deadlineMs,
      killSignal: 'SIGKILL',
    })
    const tarCode = await tarProc.exited
    if (tarCode !== 0) throw new ValidationError(`tar.zst: tar exit ${tarCode}: ${await readStderr(tarProc)}`)
    assertMemberCount(await countTarMembers(tarTmp), expected, name)
    const sink = Bun.file(absOutput).writer()
    for await (const chunk of Bun.file(tarTmp).stream().pipeThrough(new CompressionStream('zstd'))) sink.write(chunk)
    await sink.end()
  } finally {
    if (existsSync(tarTmp)) { try { unlinkSync(tarTmp) } catch { /* tolerate */ } }
  }
}

/**
 * Create a deterministic `tar.zst` archive of `sourceDir`.
 *
 * @param {{ sourceDir: string, outputPath: string, name?: string,
 *           logger?: {info?:Function,warn?:Function,error?:Function}, deadlineMs?: number }} args
 * @returns {Promise<{outputPath: string, fileCount: number, size: number}>}
 */
export async function createTarZstArchive({ sourceDir, outputPath, name, logger, deadlineMs }) {
  const log = logger ?? { info() {}, warn() {}, error() {} }
  const files = listFilesSorted(sourceDir)
  if (files.length === 0) throw new ValidationError(`createTarZstArchive: no files under ${sourceDir}`)

  const absOutput = isAbsolute(outputPath) ? outputPath : resolve(outputPath)
  if (!existsSync(dirname(absOutput))) mkdirSync(dirname(absOutput), { recursive: true })
  if (existsSync(absOutput)) unlinkSync(absOutput)

  log.info?.(`[archive-tar.zst] tar: ${name ?? absOutput} (${files.length} files)`)
  const listDir = mkdtempSync(join(tmpdir(), 'apple-docs-tarzst-list-'))
  const listPath = join(listDir, 'files.lst')
  writeFileSync(listPath, `${files.join('\n')}\n`)

  const effectiveDeadline = deadlineMs ?? DEFAULT_DEADLINE_MS
  const zstdBin = findZstd()
  try {
    if (zstdBin) {
      await streamTarToZstd({ sourceDir, listPath, zstdBin, absOutput, expected: files.length, name: name ?? absOutput, deadlineMs: effectiveDeadline })
    } else {
      log.warn?.('[archive-tar.zst] zstd CLI not found — using Bun CompressionStream (slower, single-thread, intermediate tar on disk)')
      await tarThenBunZstd({ sourceDir, listPath, absOutput, expected: files.length, name: name ?? absOutput, deadlineMs: effectiveDeadline })
    }
  } catch (err) {
    if (existsSync(absOutput)) { try { unlinkSync(absOutput) } catch { /* tolerate */ } }
    if (err instanceof ValidationError) throw err
    throw new ValidationError(`tar.zst archive build failed: ${err?.message ?? err}`)
  } finally {
    rmSync(listDir, { recursive: true, force: true })
  }

  const stat = statSync(absOutput)
  log.info?.(`[archive-tar.zst] wrote ${absOutput} (${formatSize(stat.size)}, ${files.length} members)`)
  return { outputPath: absOutput, fileCount: files.length, size: stat.size }
}

/**
 * Count tar members in an uncompressed `.tar` file. Operates on a real file
 * (no stdin streaming), so it's reliable cross-platform. Exported as a test
 * seam for the truncation-detection regression test.
 */
export async function countTarMembers(tarPath) {
  const proc = Bun.spawn(['tar', '-tf', tarPath], { stdout: 'pipe', stderr: 'pipe' })
  const listing = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new ValidationError(
      `tar.zst integrity check: member listing failed (tar exit ${code}): ${await readStderr(proc)}`,
    )
  }
  let n = 0
  for (let i = 0; i < listing.length; i++) if (listing[i] === '\n') n++
  return n
}

function formatSize(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} B`
}
