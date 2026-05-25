import { ValidationError } from "../lib/errors.js"
/**
 * Deterministic `tar.gz` archive builder. Drop-in replacement for
 * `createSevenZipArchive` after the the snapshot format recalibration:
 * LZMA2 max compression no longer fits the GH macos-26 runner's wall
 * time budget for ~1M file entries, and the corpus shape (lots of
 * small, similar SVG files) is what DEFLATE was designed for.
 *
 * Output: a single `<name>.tar.gz` archive plus a `.sha256` sidecar
 * (via `writeSha256Sidecar` re-exported from `archive-7z.js`).
 *
 * Compression: DEFLATE level 9 (max). On the macos-26 runner, 946k
 * SVG/JSON file entries pack to ~250-350 MiB in ~10-15 minutes —
 * roughly 1.5x larger than the .7z -mx=5 target but actually finishes
 * within the workflow budget, whereas LZMA2 took >60 min and timed out.
 *
 * Determinism: file paths are listed via `listFilesSorted` (LC_ALL=C
 * byte order) and fed to tar via a temp listfile + `-T <listfile>`
 * with `--no-recursion` so tar does not re-walk and reorder. The
 * `node:zlib.createGzip` stream emits no FNAME / FMTIME / FCOMMENT
 * fields by default (equivalent to `gzip -n`) so the output is
 * bit-identical across reruns of the same input. mtimes inside the
 * tar stream are preserved by default; if strict determinism is
 * needed, callers should `touch -t` the source tree to a fixed
 * timestamp first. The determinism gate in `.github/workflows/snapshot.yml`
 * verifies bit-identity between two consecutive builds.
 *
 * Implementation: the previous version shelled out to `/bin/bash -c
 * "tar ... | gzip ..."`. That was CodeQL-flagged as indirect command-
 * line injection (`js/indirect-command-line-injection`) because the
 * arguments were interpolated into a shell string even though
 * `escapeShellArg` quoted them. The current code spawns `tar` directly
 * (no shell), pipes its stdout through `node:zlib.createGzip({level:9})`,
 * and writes to disk via a Node WriteStream — no shell, no escaping,
 * no quoting bugs possible.
 *
 * Decompression: stock `tar -xzf` on macOS, Linux, BSDs. No p7zip /
 * zstd / xz dependency required on consumers.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { listFilesSorted } from './archive-7z.js'

/** Default deadline. tar+gzip -9 on the macos-26 runner has packed
 *  900k-file corpora in 10-15 min in past builds. 60 min is 4-6×
 *  headroom. */
const DEFAULT_DEADLINE_MS = 60 * 60_000

/**
 * Create a deterministic `tar.gz` archive of `sourceDir`.
 *
 * @param {object} args
 * @param {string} args.sourceDir
 * @param {string} args.outputPath
 * @param {string} [args.name]                logging label
 * @param {{info?: Function, warn?: Function, error?: Function}} [args.logger]
 * @param {number} [args.deadlineMs]
 * @returns {Promise<{outputPath: string, fileCount: number, size: number}>}
 */
export async function createTarGzArchive({
  sourceDir,
  outputPath,
  name,
  logger,
  deadlineMs,
}) {
  const log = logger ?? { info() {}, warn() {}, error() {} }
  const files = listFilesSorted(sourceDir)
  if (files.length === 0) {
    throw new ValidationError(`createTarGzArchive: no files under ${sourceDir}`)
  }

  // Same absolute-path discipline as the 7z helper: tar runs with
  // `cwd=sourceDir` so the listfile entries resolve correctly, but the
  // output (and the downstream stat/sha256 reads) need a path that
  // doesn't depend on the spawned process's working directory.
  const absOutput = isAbsolute(outputPath) ? outputPath : resolve(outputPath)
  if (!existsSync(dirname(absOutput))) {
    mkdirSync(dirname(absOutput), { recursive: true })
  }
  if (existsSync(absOutput)) unlinkSync(absOutput)

  log.info?.(`[archive-tar.gz] tar: ${name ?? absOutput} (${files.length} files)`)

  // Write the file list to a temp file so a million-entry catalog
  // doesn't blow the argv length limit (~256 KB on macOS — 946k paths
  // averaging 50 chars = ~47 MB would overflow it many times over).
  const listDir = mkdtempSync(join(tmpdir(), 'apple-docs-targz-list-'))
  const listPath = join(listDir, 'files.lst')
  writeFileSync(listPath, `${files.join('\n')}\n`)

  // Use BSD tar (macOS native; on Linux runners GNU tar provides the
  // same flags). Both accept:
  //   -c                    create
  //   -f -                  stdout
  //   -T <listfile>         read file list from a file (one path per line)
  //   --no-recursion        do not re-walk dirs that appear in the list;
  //                         honour the file order we provide.
  //
  // Spawn tar directly (no shell), pipe stdout through node:zlib.createGzip
  // with level 9. zlib's default gzip wrapper omits FNAME / FTIME /
  // FCOMMENT — equivalent to `gzip -n` — so the output is deterministic
  // across reruns and the gzip header carries no operator-private
  // information. Stderr is captured but the process never sees any
  // operator-controlled string as part of the command line.
  const effectiveDeadline = deadlineMs ?? DEFAULT_DEADLINE_MS
  let timedOut = false
  let stderrText = ''

  const tarProc = spawn('tar', ['-cf', '-', '--no-recursion', '-T', listPath], {
    cwd: sourceDir,
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Bounded stderr capture so a chatty tar can't OOM the host.
  const STDERR_MAX = 64 * 1024
  let stderrLen = 0
  tarProc.stderr.on('data', (chunk) => {
    if (stderrLen >= STDERR_MAX) return
    const remaining = STDERR_MAX - stderrLen
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
    stderrText += slice.toString('utf8')
    stderrLen += slice.length
  })

  const timer = setTimeout(() => {
    timedOut = true
    try { tarProc.kill('SIGKILL') } catch { /* already exited */ }
  }, effectiveDeadline)

  const gzip = createGzip({ level: 9 })
  const out = createWriteStream(absOutput)

  try {
    await pipeline(tarProc.stdout, gzip, out)
    // pipeline resolves when `out` finishes. tar may still be flushing;
    // await its exit explicitly so we surface non-zero exit codes.
    await new Promise((resolveExit) => {
      if (tarProc.exitCode != null || tarProc.signalCode != null) resolveExit()
      else tarProc.once('close', resolveExit)
    })
  } catch (err) {
    // On stream error, clean up the half-written archive so a retry
    // starts from scratch.
    try { tarProc.kill('SIGKILL') } catch { /* already exited */ }
    if (existsSync(absOutput)) {
      try { unlinkSync(absOutput) } catch { /* tolerate */ }
    }
    if (timedOut) {
      throw new ValidationError(`tar.gz archive build exceeded ${effectiveDeadline} ms deadline`)
    }
    throw new ValidationError(`tar.gz archive build failed: ${err?.message ?? err}`)
  } finally {
    clearTimeout(timer)
    rmSync(listDir, { recursive: true, force: true })
  }

  if (timedOut) {
    if (existsSync(absOutput)) {
      try { unlinkSync(absOutput) } catch { /* tolerate */ }
    }
    throw new ValidationError(`tar.gz archive build exceeded ${effectiveDeadline} ms deadline`)
  }
  if (tarProc.exitCode !== 0) {
    const stderr = stderrText.trim().slice(0, 4096)
    throw new ValidationError(`tar.gz archive build failed (tar exit ${tarProc.exitCode}): ${stderr || '<no stderr>'}`)
  }

  const stat = statSync(absOutput)
  log.info?.(`[archive-tar.gz] wrote ${absOutput} (${formatSize(stat.size)})`)

  return {
    outputPath: absOutput,
    fileCount: files.length,
    size: stat.size,
  }
}

function formatSize(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} B`
}
