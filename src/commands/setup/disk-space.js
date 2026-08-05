/**
 * Free-space probe + snapshot extraction preflight.
 *
 * Extraction transiently needs the temp `.tar` PLUS the extracted tree —
 * ~2× the decompressed size (~11 GB tar → ~23 GB peak on the full
 * snapshot). Checking up front beats dying mid-extract with a partial tree
 * ("No space left on device", observed).
 *
 * The probe must never fail CLOSED on a bad reading. `node:fs.statfsSync`
 * under Bun 1.3 on macOS x86_64 returns a misaligned struct — observed on a
 * host with 36 GB free:
 *
 *     { bsize: 0, bavail: 61202533, bfree: 1048576, blocks: 4096 }
 *
 * `bsize` is 0 and the real block size turns up in `blocks`, so the obvious
 * `bavail * bsize` is 0 and a guard that trusts it rejects every install on
 * that platform. That is exactly what happened to the deployment host: the
 * preflight aborted a `setup --force` that had already wiped the corpus.
 *
 * So: validate the statfs reading, fall back to POSIX `df -Pk`, and if
 * neither yields a sane number, return null and let the caller proceed
 * unguarded. A missing guard costs a clear ENOSPC from tar; a wrong guard
 * costs an install that cannot run at all.
 */

import { statfsSync, openSync, readSync, closeSync } from 'node:fs'
import { ValidationError } from '../../lib/errors.js'

/**
 * Bytes available to an unprivileged writer at `dir`, or null when it
 * cannot be determined.
 *
 * @param {string} dir
 * @returns {number|null}
 */
export function availableBytes(dir) {
  return availableViaStatfs(dir) ?? availableViaDf(dir)
}

function availableViaStatfs(dir) {
  try {
    const stat = statfsSync(dir)
    const bsize = Number(stat?.bsize)
    const bavail = Number(stat?.bavail)
    // A block size of 0 (or a nonsensical one) means the struct did not map
    // the way we expect on this platform — treat the whole reading as junk
    // rather than guessing which field is which.
    if (!Number.isFinite(bsize) || bsize <= 0 || bsize > 1 << 30) return null
    if (!Number.isFinite(bavail) || bavail < 0) return null
    const available = bavail * bsize
    return available > 0 ? available : null
  } catch {
    return null
  }
}

/**
 * POSIX `df -Pk` fallback: one header line, then one record whose 4th field
 * is available 1K-blocks. `-P` guarantees the single-line format even for
 * long device names.
 */
function availableViaDf(dir) {
  try {
    const proc = Bun.spawnSync(['df', '-Pk', dir], { stdout: 'pipe', stderr: 'ignore' })
    if (proc.exitCode !== 0) return null
    const lines = new TextDecoder().decode(proc.stdout).trim().split('\n')
    if (lines.length < 2) return null
    const fields = lines[lines.length - 1].trim().split(/\s+/)
    const kb = Number(fields[3])
    if (!Number.isFinite(kb) || kb < 0) return null
    return kb * 1024
  } catch {
    return null
  }
}

/**
 * Decompressed size of a zstd frame from its header (RFC 8878 Frame_Content_Size),
 * or null when the frame does not declare one.
 *
 * @param {string} archivePath
 * @returns {number|null}
 */
export function zstdContentSize(archivePath) {
  let fd
  try {
    fd = openSync(archivePath, 'r')
    const head = Buffer.alloc(18)
    const read = readSync(fd, head, 0, 18, 0)
    closeSync(fd)
    fd = undefined
    if (read < 6 || head.readUInt32LE(0) !== 0xfd2fb528) return null
    const descriptor = head[4]
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const dictIdFlag = descriptor & 3
    let offset = 5
    if (!singleSegment) offset += 1 // Window_Descriptor
    offset += [0, 1, 2, 4][dictIdFlag]
    if (fcsFlag === 0) return singleSegment ? head[offset] : null
    if (fcsFlag === 1) return head.readUInt16LE(offset) + 256
    if (fcsFlag === 2) return head.readUInt32LE(offset)
    return Number(head.readBigUInt64LE(offset))
  } catch {
    if (fd !== undefined) { try { closeSync(fd) } catch {} }
    return null
  }
}

/**
 * Peak bytes the extraction needs at `dataDir` for `archivePath`.
 *
 * @param {string} archivePath
 * @returns {number}
 */
export function requiredBytesForArchive(archivePath) {
  const contentSize = zstdContentSize(archivePath)
  return contentSize != null
    ? Math.ceil(contentSize * 2.05)
    : Bun.file(archivePath).size * 12 // corpus compresses ~8.6×; margin for tar+tree
}

/**
 * Throw when `dataDir` demonstrably cannot hold the extraction. Silent when
 * there is enough room, when the check is disabled, or when free space
 * cannot be determined.
 *
 * @param {string} archivePath
 * @param {string} dataDir
 * @param {{ logger?: object, env?: Record<string,string|undefined>,
 *           probe?: (dir: string) => number|null,
 *           required?: number }} [opts]
 * @returns {{ checked: boolean, needed: number, available: number|null }}
 */
export function assertEnoughDiskForExtract(archivePath, dataDir, {
  logger, env = process.env, probe = availableBytes, required,
} = {}) {
  const needed = required ?? requiredBytesForArchive(archivePath)
  if (env.APPLE_DOCS_SKIP_DISK_CHECK === '1') {
    return { checked: false, needed, available: null }
  }
  const available = probe(dataDir)
  if (available == null) {
    logger?.debug?.(
      `Could not determine free space at ${dataDir}; skipping the extraction disk preflight.`,
    )
    return { checked: false, needed, available: null }
  }
  if (available < needed) {
    throw new ValidationError(
      `Not enough disk space to extract the snapshot: need ~${(needed / 1e9).toFixed(1)} GB free ` +
      `(temp tar + extracted tree), have ${(available / 1e9).toFixed(1)} GB at ${dataDir}. ` +
      'Free up space, choose a different APPLE_DOCS_HOME, or set APPLE_DOCS_SKIP_DISK_CHECK=1 to override.',
    )
  }
  return { checked: true, needed, available }
}
