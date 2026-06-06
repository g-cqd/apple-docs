/**
 * Section content codec for the `on-demand` (compacted) storage profile.
 *
 * `storage compact` zstd-compresses document_sections.content_text /
 * content_json in place to shrink an ultra-lean install. Compression is
 * opportunistic — a value is only stored compressed when that actually saves
 * bytes, so small sections stay plain strings. Decoding is therefore
 * type-directed and fully backward-compatible: an uncompressed corpus reads
 * through untouched.
 *   - a string column value is returned as-is,
 *   - a BLOB (a Uint8Array, read back from a compressed cell) is zstd-decoded.
 */

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * Compress a section content value for storage. Returns the original string
 * when compression wouldn't save space (so tiny rows aren't bloated), `''` for
 * empty, or null for null/undefined.
 * @param {string|null|undefined} text
 * @returns {string|Uint8Array|null}
 */
export function encodeSectionContent(text) {
  if (text == null) return null
  const str = String(text)
  if (str.length === 0) return ''
  const raw = Buffer.from(str, 'utf8')
  const z = Bun.zstdCompressSync(raw)
  return z.length < raw.length ? z : str
}

/**
 * Decode a section content value read from the DB. Strings pass through;
 * zstd BLOBs are inflated to a UTF-8 string.
 * @param {string|Uint8Array|null|undefined} value
 * @returns {string|null|undefined}
 */
export function decodeSectionContent(value) {
  if (value == null || typeof value === 'string') return value
  if (
    value.length >= 4 &&
    value[0] === ZSTD_MAGIC[0] && value[1] === ZSTD_MAGIC[1] &&
    value[2] === ZSTD_MAGIC[2] && value[3] === ZSTD_MAGIC[3]
  ) {
    return Buffer.from(Bun.zstdDecompressSync(value)).toString('utf8')
  }
  // Non-zstd blob (shouldn't happen) — best-effort UTF-8 decode.
  return Buffer.from(value).toString('utf8')
}

/**
 * In-place decode of `content_text` / `content_json` on a raw section row.
 * No-op on an uncompressed corpus.
 * @template {{ content_text?: unknown, content_json?: unknown }} T
 * @param {T} row
 * @returns {T}
 */
export function decodeSectionRow(row) {
  if (!row) return row
  if (row.content_text != null) row.content_text = decodeSectionContent(row.content_text)
  if (row.content_json != null) row.content_json = decodeSectionContent(row.content_json)
  return row
}
