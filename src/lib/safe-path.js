import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Maximum filename component length supported by APFS / ext4 / common
 * filesystems. POSIX `NAME_MAX` is 255 bytes for the leaf component; the
 * pathname as a whole has a much higher cap (`PATH_MAX` ~ 1024-4096).
 */
const MAX_COMPONENT_BYTES = 255

/**
 * Worst-case length of the suffix appended by atomic-write temp files
 * (see src/lib/atomic-write.js): `.tmp-<pid>-<randomHex>`. PID can be up
 * to 7 digits on Linux, randomHex up to 16 chars. We reserve a generous
 * 32 bytes so the temp file never overflows even in the worst case.
 */
const TMP_SUFFIX_BUDGET = 32

/**
 * Length of the SHA-1 prefix appended when a basename has to be
 * shortened. 12 hex chars = 48 bits of collision resistance, which is
 * more than enough across a corpus of ~350k pages.
 */
const HASH_PREFIX_LEN = 12

/**
 * Apple's documentation tree contains a handful of Swift initializer
 * symbols whose serialized identifier (the per-parameter label list)
 * already approaches 255 bytes after Apple's own truncation hash
 * (e.g. `init(animationtool:colorprimaries:...:sourcetr-2lwnx`).
 * Adding `.json` plus the atomic-write temp suffix tips them past the
 * filesystem's per-component limit, so writing them fails with
 * ENAMETOOLONG.
 *
 * `safeFilename` deterministically maps a possibly-long `basename + ext`
 * to a filename that survives the temp-file write. Names that already
 * fit are returned unchanged. Long names get truncated and tagged with
 * a SHA-1 prefix so two distinct identifiers never collide on disk.
 *
 * Example:
 *   safeFilename('init(animationtool:colorprimaries:...sourcetr-2lwnx', '.json')
 *     → 'init(animationtool:...sourcetr-2lwnx~ab12cd34ef56.json'
 *
 * @param {string} basename  filename without extension (may be very long)
 * @param {string} ext       extension including the leading dot, e.g. '.json'
 * @returns {string}
 */
export function safeFilename(basename, ext) {
  const fullName = `${basename}${ext}`
  if (Buffer.byteLength(fullName, 'utf8') + TMP_SUFFIX_BUDGET <= MAX_COMPONENT_BYTES) {
    return fullName
  }
  const hash = createHash('sha1').update(basename).digest('hex').slice(0, HASH_PREFIX_LEN)
  // Budget = MAX - tmpSuffix - ext - separator(~) - hash
  const budget = MAX_COMPONENT_BYTES - TMP_SUFFIX_BUDGET - Buffer.byteLength(ext, 'utf8') - 1 - HASH_PREFIX_LEN
  const truncated = truncateToBytes(basename, Math.max(0, budget))
  return `${truncated}~${hash}${ext}`
}

/**
 * Build an on-disk filesystem path for a corpus key (e.g. an Apple doc
 * identifier) whose leaf component may be too long for the underlying
 * filesystem. Intermediate path components are passed through verbatim
 * — Apple's URL structure caps them at framework / class names that
 * never approach the limit.
 *
 * Reads and writes both go through this helper, so as long as the
 * caller hands us the same `key`, the same on-disk path is produced.
 *
 * @param {string} dataDir
 * @param {string} subdir e.g. 'raw-json' or 'markdown'
 * @param {string} key    corpus key (slash-separated, no trailing slash)
 * @param {string} ext    extension with leading dot, e.g. '.json'
 * @returns {string}
 */
export function keyPath(dataDir, subdir, key, ext) {
  const segments = key.split('/')
  const basename = segments.pop() ?? ''
  const safe = safeFilename(basename, ext)
  return join(dataDir, subdir, ...segments, safe)
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes without slicing
 * across a multi-byte character boundary. ASCII-only inputs (the common
 * case for Apple identifiers) take the fast path.
 */
function truncateToBytes(str, maxBytes) {
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str
  // Walk forward by code points; bail when adding the next would exceed.
  let bytes = 0
  let out = ''
  for (const ch of str) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (bytes + chBytes > maxBytes) break
    out += ch
    bytes += chBytes
  }
  return out
}
