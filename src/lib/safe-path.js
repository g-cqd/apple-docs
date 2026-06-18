import { join, resolve, sep } from 'node:path'
import { ValidationError } from './errors.js'

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
  const hash = new Bun.CryptoHasher('sha1').update(basename).digest('hex').slice(0, HASH_PREFIX_LEN)
  // Budget = MAX - tmpSuffix - ext - separator(~) - hash
  const budget = MAX_COMPONENT_BYTES - TMP_SUFFIX_BUDGET - Buffer.byteLength(ext, 'utf8') - 1 - HASH_PREFIX_LEN
  const truncated = truncateToBytes(basename, Math.max(0, budget))
  return `${truncated}~${hash}${ext}`
}

/**
 * Maximum UTF-8 bytes a web path segment may carry before it gets the
 * truncate-and-hash treatment. Deliberately below the 255-byte
 * filesystem component limit: the static build appends `/index.html`
 * plus precompressed siblings, and some host filesystems count bytes
 * differently — 200 leaves comfortable headroom everywhere.
 */
export const WEB_SEGMENT_MAX_BYTES = 200

/**
 * Bytes of the original segment preserved before the `~<sha1-12>` tag.
 * 180 + 1 + 12 = 193 ≤ WEB_SEGMENT_MAX_BYTES, so a hashed segment never
 * needs hashing again (idempotent for already-safe keys).
 */
const WEB_SEGMENT_TRUNCATE_BYTES = 180

/**
 * Map one URL path segment to a form that fits the filesystem component
 * limit of the static build while staying deterministic, so the live
 * server and the static site emit the IDENTICAL canonical URL. Segments
 * that already fit are returned unchanged; long ones are truncated on a
 * UTF-8 character boundary and tagged with a SHA-1 prefix of the FULL
 * original segment (same `~<hex12>` style as safeFilename).
 *
 * @param {string} segment
 * @returns {string}
 */
export function safeWebSegment(segment) {
  if (Buffer.byteLength(segment, 'utf8') <= WEB_SEGMENT_MAX_BYTES) return segment
  const hash = new Bun.CryptoHasher('sha1').update(segment).digest('hex').slice(0, HASH_PREFIX_LEN)
  return `${truncateToBytes(segment, WEB_SEGMENT_TRUNCATE_BYTES)}~${hash}`
}

/**
 * Fast check: does this corpus key need a hashed web path? Keys whose
 * total byte length fits the threshold can't contain an oversized
 * segment, so the hot path (350k render calls) costs one byteLength.
 *
 * @param {string} key slash-separated corpus key
 * @returns {boolean}
 */
export function webKeyNeedsMapping(key) {
  if (typeof key !== 'string' || Buffer.byteLength(key, 'utf8') <= WEB_SEGMENT_MAX_BYTES) {
    return false
  }
  return key.split('/').some((seg) => Buffer.byteLength(seg, 'utf8') > WEB_SEGMENT_MAX_BYTES)
}

/**
 * Canonical web path for a corpus key: every oversized segment is
 * replaced by its `safeWebSegment` form, everything else passes through
 * verbatim. Returns the key itself (same reference, no allocations)
 * when no segment exceeds the threshold.
 *
 * @param {string} key slash-separated corpus key
 * @returns {string}
 */
export function safeWebDocKey(key) {
  if (!webKeyNeedsMapping(key)) return key
  return key.split('/').map(safeWebSegment).join('/')
}

/**
 * Reject storage keys that would let an attacker escape `dataDir` via
 * traversal segments (`..`), absolute roots (`/`, `~`, `C:\`), embedded
 * NULs, or backslash separators we don't otherwise interpret. Throws
 * ValidationError on first violation; returns the original key on success
 * so callers can chain.
 *
 * This is the single boundary every writer calls before resolving a
 * `documents.key` against `dataDir` — a malicious sourceMetadata could
 * otherwise land an absolute or traversal path in the key and slip
 * through keyPath unchecked.
 *
 * @param {string} rawKey
 * @returns {string} the validated key (unchanged)
 */
export function validateStorageKey(rawKey) {
  if (typeof rawKey !== 'string' || rawKey.length === 0) {
    throw new ValidationError('Storage key must be a non-empty string', {
      field: 'key',
      value: rawKey,
    })
  }
  if (rawKey.startsWith('/') || rawKey.startsWith('~')) {
    throw new ValidationError(`Storage key must be relative, got absolute: ${rawKey}`, {
      field: 'key',
      value: rawKey,
    })
  }
  if (/^[A-Za-z]:[\\/]/.test(rawKey)) {
    throw new ValidationError(`Storage key must be relative, got Windows root: ${rawKey}`, {
      field: 'key',
      value: rawKey,
    })
  }
  const segments = rawKey.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new ValidationError(`Invalid path segment "${seg}" in storage key: ${rawKey}`, {
        field: 'key',
        value: rawKey,
      })
    }
    // Backslashes are not separators on POSIX but they're a common smuggling
    // vector when the same key is later interpreted by Windows code or by a
    // tool that normalizes them; rejecting at the boundary keeps the contract
    // OS-agnostic. NUL bytes terminate C strings — universal nope.
    if (seg.includes('\\') || seg.includes('\0')) {
      throw new ValidationError(`Storage key contains forbidden character: ${rawKey}`, {
        field: 'key',
        value: rawKey,
      })
    }
  }
  return rawKey
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
 * Validates the key first and asserts the resolved result lives
 * under `dataDir` — a belt-and-braces guard against a future regex bug
 * in validateStorageKey (e.g. unicode normalization corner cases).
 *
 * @param {string} dataDir
 * @param {string} subdir e.g. 'raw-json' or 'markdown'
 * @param {string} key    corpus key (slash-separated, no trailing slash)
 * @param {string} ext    extension with leading dot, e.g. '.json'
 * @returns {string}
 */
export function keyPath(dataDir, subdir, key, ext) {
  validateStorageKey(key)
  const segments = key.split('/')
  const basename = segments.pop() ?? ''
  const safe = safeFilename(basename, ext)
  const result = join(dataDir, subdir, ...segments, safe)

  // Containment invariant. resolve() canonicalizes both sides so symlink-
  // free traversal (`a/b/../../escape`) cannot slip through.
  const resolvedRoot = resolve(dataDir) + sep
  const resolvedResult = resolve(result)
  if (!resolvedResult.startsWith(resolvedRoot) && resolvedResult !== resolve(dataDir)) {
    throw new ValidationError(`Storage path escapes dataDir: ${result}`, { field: 'key', value: key })
  }
  return result
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
