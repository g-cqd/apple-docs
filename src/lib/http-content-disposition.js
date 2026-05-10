/**
 * Build a `Content-Disposition: attachment; …` header value that survives
 * non-ASCII filenames and quote characters per RFC 5987.
 *
 * A naive `attachment; filename="${name.replaceAll('"','')}"` would:
 *   - Drop quotes silently — surprising for users whose font names contain `"`.
 *   - Mojibake any non-ASCII character (Apple ships SF Pro for Arabic /
 *     Hebrew / Georgian; the family display names contain Unicode).
 *   - Fail to escape `;` / `,` / backslash, allowing header smuggling.
 *
 * RFC 5987 says: provide a US-ASCII `filename=` for legacy clients AND a
 * UTF-8 `filename*=` with percent-encoded value. Modern browsers honor
 * the latter; old ones fall back to the former. Both are sanitized.
 */

const FALLBACK_FILENAME = 'download'

// Regexes assembled at runtime so the source file stays free of literal
// control characters (biome flags those under noControlCharactersInRegex
// even when bounded by a range).
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}]`, 'g')
const NON_PRINTABLE_ASCII = new RegExp(`[^${String.fromCharCode(0x20)}-${String.fromCharCode(0x7e)}]`, 'g')
const HEADER_UNSAFE = /["\\;,]/g

/**
 * @param {string} filename - the human-readable filename. May contain Unicode.
 * @returns {string} Header value, e.g.
 *   `attachment; filename="SF-Pro.zip"; filename*=UTF-8''SF-Pro.zip`
 *   `attachment; filename="SF-Hebrew.zip"; filename*=UTF-8''SF-Hebrew.zip`
 */
export function contentDispositionAttachment(filename) {
  const safe = String(filename ?? '').trim() || FALLBACK_FILENAME
  // ASCII-safe fallback: drop control chars + characters disallowed by RFC
  // 6266 from a quoted-string filename param. Non-printable code points
  // become underscore so the legacy field doesn't carry mojibake.
  const ascii = safe
    .replace(CONTROL_CHARS, '')
    .replace(HEADER_UNSAFE, '')
    .replace(NON_PRINTABLE_ASCII, '_')
    .trim() || FALLBACK_FILENAME

  // UTF-8 percent-encoded value for modern UAs.
  const utf8 = encodeURIComponent(safe)

  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}
