/**
 * Content-Security-Policy emitter for the public web server.
 *
 * Strategy: hash-based for the small fixed set of inline scripts the
 * server emits, `'self'` for everything else. No nonces — none of the
 * inline blocks vary per-request, so a static hash is cheaper than a
 * per-response nonce and just as strict.
 *
 * Each inline `<script>` body that we ship must be added to
 * INLINE_SCRIPT_HASHES. The hash is the SHA-256 of the literal text
 * between `<script>` and `</script>`, base64-encoded — exactly what the
 * browser hashes when validating `'sha256-...'` source expressions.
 *
 * Inline `<script type="application/json">` data blocks (e.g. fonts /
 * framework tree payloads) are not executed by the browser, so CSP
 * `script-src` does not gate them — no hashing required.
 */

import { NOT_FOUND_INLINE_SCRIPT } from './templates/not-found.js'

function sha256Base64(text) {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(text)
  return hasher.digest('base64')
}

/** Inline script bodies → CSP source-hash entries. */
const INLINE_SCRIPT_HASHES = Object.freeze([
  `'sha256-${sha256Base64(NOT_FOUND_INLINE_SCRIPT)}'`,
])

const POLICY_DIRECTIVES = [
  "default-src 'self'",
  `script-src 'self' ${INLINE_SCRIPT_HASHES.join(' ')}`,
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
]

/**
 * Build the Content-Security-Policy header value.
 *
 * Cached — the policy is fully static once `INLINE_SCRIPT_HASHES` is
 * computed at module load.
 */
let _cached = null
export function buildCsp() {
  if (_cached === null) _cached = POLICY_DIRECTIVES.join('; ')
  return _cached
}
