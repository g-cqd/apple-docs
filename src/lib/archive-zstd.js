import { ValidationError } from "../lib/errors.js"
/**
 * Deterministic `tar.zst` archive builder. Replaces the `tar.gz` path:
 * `zstd -9 -T3` is ~15% smaller AND ~5× faster than `gzip -9` on the
 * corpus shape (verified on the SF-Symbol SVG set), and multithreaded so
 * it scales on the CI runner. Higher levels (>12) trade huge time for a
 * few % more ratio — `-9` is the sweet spot.
 *
 * Pipeline: `tar -cf <tmp.tar>` then `zstd <tmp.tar> -o <out>`. We go through
 * a temp file rather than streaming `tar … | zstd …`: Bun's process plumbing
 * pumps a process-to-process pipe unreliably past one pipe buffer on Linux
 * (small archives are fine, the full corpus truncates), and Node's
 * `pipeline(tar.stdout, zstd.stdin)` throws `EINVAL … send` at multi-GB. A
 * real intermediate file sidesteps both — the same discipline the consumer
 * (setup) and the old `.tar.gz` path use.
 *
 * Determinism: paths come from `listFilesSorted` (LC_ALL=C order) fed to
 * tar via a temp listfile + `--no-recursion`; zstd output is bit-identical
 * across reruns for a fixed level / thread count / zstd version (never use
 * `--adapt`). mtimes are clamped by the caller (snapshot.js). The gate in
 * `.github/workflows/snapshot.yml` verifies bit-identity across two builds.
 * No `--long`: its larger window adds marginal ratio but is rejected by some
 * zstd decoders (Bun's `DecompressionStream` on the consumer), so the default
 * level-9 window keeps every consumer able to decode.
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
// -9 (ratio sweet spot) / -T3 (3-core runner). Pinned so the determinism gate
// stays byte-stable; NEVER add --adapt, and NO --long (see header).
const ZSTD_ARGS = ['-9', '-T3', '-q', '-f']

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
  // Intermediate tar lives next to the output (same volume, which has room for
  // the snapshot anyway). Removed in `finally`.
  const tarTmp = `${absOutput}.building.tar`

  try {
    // 1. tar -> real file (no streaming).
    if (existsSync(tarTmp)) unlinkSync(tarTmp)
    const tarProc = Bun.spawn(['tar', '-cf', tarTmp, '--no-recursion', '-T', listPath], {
      cwd: sourceDir,
      env: { ...process.env, LC_ALL: 'C' },
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: effectiveDeadline,
      killSignal: 'SIGKILL',
    })
    const tarCode = await tarProc.exited
    if (tarCode !== 0) throw new ValidationError(`tar.zst: tar exit ${tarCode}: ${await readStderr(tarProc)}`)

    // 2. Integrity gate: count members of the uncompressed tar. `--no-recursion
    //    -T <files>` packs exactly one entry per listed (regular) file, so a
    //    complete tar lists `files.length`. A short count means tar truncated —
    //    the failure mode that silently shipped a 199 MB (vs 1.6 GB) archive
    //    past the old gzip path. Catch it here, before compression.
    const members = await countTarMembers(tarTmp)
    if (members !== files.length) {
      throw new ValidationError(
        `tar.zst integrity check failed for ${name ?? absOutput}: tar lists ${members} members but ${files.length} were staged — truncated or corrupt`,
      )
    }

    // 3. zstd the tar file -> output (zstd reads a real file; exit 0 ⇒ complete).
    if (zstdBin) {
      const zstdProc = Bun.spawn([zstdBin, ...ZSTD_ARGS, '-o', absOutput, tarTmp], {
        stdout: 'ignore', stderr: 'pipe', timeout: effectiveDeadline, killSignal: 'SIGKILL',
      })
      const zstdCode = await zstdProc.exited
      if (zstdCode !== 0) throw new ValidationError(`tar.zst: zstd exit ${zstdCode}: ${await readStderr(zstdProc)}`)
    } else {
      log.warn?.('[archive-tar.zst] zstd CLI not found — using Bun CompressionStream (slower, single-thread)')
      const sink = Bun.file(absOutput).writer()
      for await (const chunk of Bun.file(tarTmp).stream().pipeThrough(new CompressionStream('zstd'))) sink.write(chunk)
      await sink.end()
    }
  } catch (err) {
    if (existsSync(absOutput)) { try { unlinkSync(absOutput) } catch { /* tolerate */ } }
    if (err instanceof ValidationError) throw err
    throw new ValidationError(`tar.zst archive build failed: ${err?.message ?? err}`)
  } finally {
    rmSync(listDir, { recursive: true, force: true })
    if (existsSync(tarTmp)) { try { unlinkSync(tarTmp) } catch { /* tolerate */ } }
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
