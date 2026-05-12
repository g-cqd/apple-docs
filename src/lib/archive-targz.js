/**
 * Deterministic `tar.gz` archive builder. Drop-in replacement for
 * `createSevenZipArchive` after the May 2026 snapshot recalibration:
 * LZMA2 max compression no longer fits the GH macos-26 runner's wall
 * time budget for ~1M file entries, and the corpus shape (lots of
 * small, similar SVG files) is what DEFLATE was designed for.
 *
 * Output: a single `<name>.tar.gz` archive plus a `.sha256` sidecar
 * (via `writeSha256Sidecar` re-exported from `archive-7z.js`).
 *
 * Compression: `gzip -9` (maximum DEFLATE level). On the macos-26
 * runner, 946k SVG/JSON file entries pack to ~250-350 MiB in ~10-15
 * minutes — roughly 1.5x larger than the .7z -mx=5 target but
 * actually finishes within the workflow budget, whereas LZMA2 took
 * >60 min and timed out.
 *
 * Determinism: file paths are listed via `listFilesSorted` (LC_ALL=C
 * byte order) and fed to tar via a temp listfile + `-T <listfile>`
 * with `--no-recursion` so tar does not re-walk and reorder. `gzip -n`
 * strips the embedded timestamp + filename from the gzip header so
 * the output is bit-identical across reruns. mtimes inside the tar
 * stream are preserved by default, so reruns DO embed source mtimes;
 * if strict determinism is needed, callers should `touch -t` the
 * source tree to a fixed timestamp first. The S0.2 determinism gate
 * already runs only on the Sunday cron (workflow_dispatch builds skip
 * it), so this is acceptable for current usage.
 *
 * Decompression: stock `tar -xzf` on macOS, Linux, BSDs. No p7zip /
 * zstd / xz dependency required on consumers.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { listFilesSorted } from './archive-7z.js'

/** Default deadline. tar+gzip -9 on the macos-26 runner has packed
 *  900k-file corpora in 10-15 min in past builds (pre-a5a0244 .tar.gz
 *  green run took 47 min total with this step at ~5-10 min). 60 min
 *  is 4-6× headroom. */
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
    throw new Error(`createTarGzArchive: no files under ${sourceDir}`)
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
  // gzip flags:
  //   -9                    max DEFLATE level
  //   -n                    omit original name + mtime from the gzip header
  //                         (small but important for byte-determinism)
  //   -c                    stdout
  //
  // Run through /bin/sh so we can chain tar -> gzip -> file with
  // pipefail; otherwise an error in tar would be silently swallowed
  // by gzip's successful exit.
  const sh = [
    'set -euo pipefail',
    `tar -cf - --no-recursion -T ${escapeShellArg(listPath)} | gzip -9 -n -c > ${escapeShellArg(absOutput)}`,
  ].join('\n')

  let result
  try {
    result = spawnSync('/bin/sh', ['-c', sh], {
      cwd: sourceDir,
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: deadlineMs ?? DEFAULT_DEADLINE_MS,
    })
  } finally {
    rmSync(listDir, { recursive: true, force: true })
  }

  if (result.error) {
    throw new Error(`tar.gz archive build failed to spawn: ${result.error.message}`)
  }
  if (result.signal) {
    throw new Error(`tar.gz archive build was killed by ${result.signal} (likely a deadline hit)`)
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim().slice(0, 4096)
    throw new Error(`tar.gz archive build failed (exit ${result.status}): ${stderr || '<no stderr>'}`)
  }

  const stat = statSync(absOutput)
  log.info?.(`[archive-tar.gz] wrote ${absOutput} (${formatSize(stat.size)})`)

  return {
    outputPath: absOutput,
    fileCount: files.length,
    size: stat.size,
  }
}

/** Quote a string for /bin/sh single-quote context. */
function escapeShellArg(s) {
  // `'foo'` is literal except for the single quote itself; close+escape+reopen.
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

function formatSize(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} B`
}
