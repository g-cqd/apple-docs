import { ValidationError } from "../lib/errors.js"
/**
 * Deterministic `tar.zst` archive builder. Replaces the `tar.gz` path:
 * `zstd -9 -T3` is ~15% smaller AND ~5× faster than `gzip -9` on the
 * corpus shape (verified on the SF-Symbol SVG set), and multithreaded so
 * it scales on the CI runner. Higher levels (>12) trade huge time for a
 * few % more ratio — `-9` is the sweet spot; `--long=27` lifts the ratio
 * on the repetitive doc text for ~no determinism cost.
 *
 * Determinism: paths come from `listFilesSorted` (LC_ALL=C order) fed to
 * tar via a temp listfile + `--no-recursion`; zstd output is bit-identical
 * across reruns for a fixed level / thread count / zstd version (never use
 * `--adapt`). mtimes are clamped by the caller (snapshot.js). The gate in
 * `.github/workflows/snapshot.yml` verifies bit-identity across two builds.
 *
 * Decompression: macOS ships NO zstd and Apple's bsdtar lacks libzstd, so
 * consumers do NOT use `tar --zstd`. The only consumer is the Bun app
 * (`apple-docs setup`), which stream-decompresses with the built-in
 * `DecompressionStream("zstd")` and pipes plain tar to `tar -xf -` — no
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
// -9 (ratio sweet spot) / -T3 (3-core runner) / --long=27 (128 MB window).
// Pinned so the determinism gate stays byte-stable; NEVER add --adapt.
const ZSTD_ARGS = ['-9', '--long=27', '-T3', '-q', '-f']

function findZstd() {
  const candidates = [process.env.ZSTD_BIN, '/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd']
  for (const c of candidates) { if (c && existsSync(c)) return c }
  // Last resort: anything named `zstd` on PATH (covers the CI runner, where
  // it may live outside the well-known prefixes above).
  try { return Bun.which('zstd') } catch { return null }
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

  // Feed `tar -cf -` straight into the compressor with Bun's native process
  // plumbing. Node's `pipeline(tar.stdout, zstd.stdin)` throws `EINVAL …
  // send` once the piped volume reaches multi-GB on the macOS CI runner (it
  // round-trips every byte through a JS socket write); Bun wires the two
  // process pipes together directly, so the full-corpus archive streams
  // without the JS hop. Same path the consumer (setup) already uses.
  const tarProc = Bun.spawn(['tar', '-cf', '-', '--no-recursion', '-T', listPath], {
    cwd: sourceDir,
    env: { ...process.env, LC_ALL: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: effectiveDeadline,
    killSignal: 'SIGKILL',
  })
  // Drain stderr concurrently so a chatty process can't deadlock on a full pipe.
  const tarErrP = new Response(tarProc.stderr).text().catch(() => '')

  try {
    if (zstdBin) {
      // zstd reads tar's stdout on its stdin and writes the archive itself.
      const zstdProc = Bun.spawn([zstdBin, ...ZSTD_ARGS, '-o', absOutput], {
        stdin: tarProc.stdout,
        stdout: 'ignore',
        stderr: 'pipe',
        timeout: effectiveDeadline,
        killSignal: 'SIGKILL',
      })
      const zstdErrP = new Response(zstdProc.stderr).text().catch(() => '')
      const [tarCode, zstdCode] = await Promise.all([tarProc.exited, zstdProc.exited])
      if (tarCode !== 0) throw new ValidationError(`tar.zst: tar exit ${tarCode}: ${(await tarErrP).trim().slice(0, 4096) || '<no stderr>'}`)
      if (zstdCode !== 0) throw new ValidationError(`tar.zst: zstd exit ${zstdCode}: ${(await zstdErrP).trim().slice(0, 4096) || '<no stderr>'}`)
    } else {
      log.warn?.('[archive-tar.zst] zstd CLI not found — using Bun CompressionStream (slower, single-thread)')
      const compressed = tarProc.stdout.pipeThrough(new CompressionStream('zstd'))
      await Bun.write(absOutput, new Response(compressed))
      const tarCode = await tarProc.exited
      if (tarCode !== 0) throw new ValidationError(`tar.zst: tar exit ${tarCode}: ${(await tarErrP).trim().slice(0, 4096) || '<no stderr>'}`)
    }
  } catch (err) {
    try { tarProc.kill('SIGKILL') } catch { /* gone */ }
    if (existsSync(absOutput)) { try { unlinkSync(absOutput) } catch { /* tolerate */ } }
    if (err instanceof ValidationError) throw err
    throw new ValidationError(`tar.zst archive build failed: ${err?.message ?? err}`)
  } finally {
    rmSync(listDir, { recursive: true, force: true })
  }

  // Integrity gate: decompress the archive we just wrote and count its tar
  // members. `tar --no-recursion -T <files>` packs exactly one entry per
  // listed (regular) file, so a complete archive lists `files.length`
  // members. A short count means the stream was truncated — the failure that
  // silently shipped a 199 MB (vs 1.6 GB) archive past the old gzip path and
  // only blew up later in the determinism gate. Catch it here, at build time,
  // in every pass. Streams via Bun's native zstd (the same path consumers
  // use), so no system zstd is required.
  const members = await countArchiveMembers(absOutput)
  if (members !== files.length) {
    if (existsSync(absOutput)) { try { unlinkSync(absOutput) } catch { /* tolerate */ } }
    throw new ValidationError(
      `tar.zst integrity check failed for ${name ?? absOutput}: archive lists ${members} members but ${files.length} were staged — truncated or corrupt`,
    )
  }

  const stat = statSync(absOutput)
  log.info?.(`[archive-tar.zst] wrote ${absOutput} (${formatSize(stat.size)}, ${members} members verified)`)
  return { outputPath: absOutput, fileCount: files.length, size: stat.size }
}

/**
 * Count tar members in a `.tar.zst` by streaming it through Bun's zstd.
 * Exported as a test seam for the truncation-detection regression test.
 */
export async function countArchiveMembers(absOutput) {
  const stream = Bun.file(absOutput).stream().pipeThrough(new DecompressionStream('zstd'))
  const proc = Bun.spawn(['tar', '-tf', '-'], { stdin: stream, stdout: 'pipe', stderr: 'ignore' })
  const listing = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) throw new ValidationError(`tar.zst integrity check: member listing failed (tar exit ${code})`)
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
