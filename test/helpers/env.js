/**
 * Process-env helpers for the native-flip unit gates. The cli-flip and serve-flip
 * suites both probe DEFAULT-OFF switches read from `APPLE_DOCS_NATIVE`, so they
 * share one save/set/restore wrapper rather than each redefining it.
 */

/**
 * Run `fn` with `APPLE_DOCS_NATIVE` set to `value` (or unset when `value` is
 * `undefined`), restoring the prior value (including "was unset") afterward — even
 * if `fn` throws.
 *
 * @template T
 * @param {string | undefined} value
 * @param {() => T} fn
 * @returns {T}
 */
export function withNative(value, fn) {
  const prev = process.env.APPLE_DOCS_NATIVE
  if (value === undefined) delete process.env.APPLE_DOCS_NATIVE
  else process.env.APPLE_DOCS_NATIVE = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.APPLE_DOCS_NATIVE
    else process.env.APPLE_DOCS_NATIVE = prev
  }
}
