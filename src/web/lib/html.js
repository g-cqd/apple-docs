/**
 * Tagged-template DSL for the web layer. Replaces the prior
 * `${escapeAttr(value)}` template-literal style with auto-escaping at
 * the boundary, a Symbol-branded HtmlString that lets callers safely
 * compose trusted children, and a lazy chunk list that defers the
 * final string join until the caller asks for it.
 *
 * Three primitives:
 *
 *   html`…${value}…`       — tagged template, returns HtmlString.
 *                            Interpolated values are escaped unless
 *                            they're already an HtmlString.
 *   raw(s)                  — wrap an already-escaped / known-trusted
 *                            string (Shiki output, pre-rendered
 *                            Markdown HTML, JSON-LD payloads escaped
 *                            via escapeJsonLd) as an HtmlString.
 *   attr(name, value)       — conditional attribute. Emits an empty
 *                            string when `value` is null / undefined /
 *                            false; otherwise renders ` name="value"`
 *                            with the value escaped.
 *
 * Output:
 *
 *   .toString()             — concatenates the internal chunk list to
 *                             a single string (the common path for
 *                             route handlers that pass the result to
 *                             `textResponse()`).
 *   .bytes()                — returns a single Uint8Array. Sets up the
 *                             zero-copy build emission planned in
 *                             phase 3b — `Bun.write(path, htmlString
 *                             .bytes())` skips the string→bytes
 *                             encoding pass per page.
 *
 * Brand check via `Symbol.for('apple-docs.html')` so cross-module
 * realm differences (e.g. test harnesses, future worker shards) still
 * recognise the same brand.
 */

const HTML_BRAND = Symbol.for('apple-docs.html')
const encoder = new TextEncoder()

/**
 * @typedef {object} HtmlString
 * @property {true} __apple_docs_html
 * @property {Array<string | Uint8Array>} _chunks
 * @property {() => string} toString
 * @property {() => Uint8Array} bytes
 */

/**
 * Test whether a value is an HtmlString produced by this module.
 * @param {unknown} value
 * @returns {value is HtmlString}
 */
export function isHtmlString(value) {
  return value != null && typeof value === 'object' && value[HTML_BRAND] === true
}

/**
 * Wrap an already-trusted string as an HtmlString so it passes through
 * `html` interpolations without escape. Use only for output produced
 * by a trusted source (Shiki, pre-rendered Markdown, JSON-LD already
 * escaped via the JSON-LD-specific helper).
 *
 * @param {string} s
 * @returns {HtmlString}
 */
export function raw(s) {
  const str = s == null ? '' : String(s)
  return makeHtml([str])
}

/**
 * Build a conditional attribute fragment. The attribute is omitted
 * entirely (empty string) when `value` is null, undefined, or false.
 * Boolean `true` renders as a valueless attribute (`disabled`,
 * `hidden`, etc.). Everything else is escaped and rendered as a
 * standard `name="value"` pair.
 *
 * @param {string} name  attribute name (NOT escaped; must come from
 *                       a trusted source — typically a static literal)
 * @param {unknown} value
 * @returns {HtmlString}
 */
export function attr(name, value) {
  if (value == null || value === false) return makeHtml([''])
  if (value === true) return makeHtml([` ${name}`])
  return makeHtml([` ${name}="${Bun.escapeHTML(String(value))}"`])
}

/**
 * The DSL's tagged-template entry point. Splices the static parts of
 * the template literal with the interpolated values, escaping
 * untrusted values and preserving HtmlString children verbatim.
 *
 * Interpolation rules:
 *   - HtmlString             → spliced unchanged (`_chunks` flattened in)
 *   - Array                  → each element is recursed (no separator)
 *   - null / undefined       → empty string
 *   - true                   → empty string (use `attr()` for valueless attributes)
 *   - false                  → empty string (matches React's conditional-render idiom)
 *   - string / number / etc. → coerced to string and escaped via Bun.escapeHTML
 *
 * @param {TemplateStringsArray} strings
 * @param  {...unknown} values
 * @returns {HtmlString}
 */
export function html(strings, ...values) {
  const chunks = []
  for (let i = 0; i < strings.length; i++) {
    chunks.push(strings[i])
    if (i < values.length) appendValue(chunks, values[i])
  }
  return makeHtml(chunks)
}

/**
 * Internal: append an interpolated value to the chunk accumulator,
 * applying the escape / splice rules.
 *
 * Hot path: this runs once per `${}` interpolation per template
 * render, so the type-test order matters (cheap typeof checks before
 * isHtmlString / Array.isArray).
 *
 * @param {Array<string | Uint8Array>} chunks
 * @param {unknown} value
 */
function appendValue(chunks, value) {
  if (value == null || value === false || value === true) return
  const t = typeof value
  if (t === 'string') {
    chunks.push(Bun.escapeHTML(value))
    return
  }
  if (t === 'number') {
    // Numbers can't contain meta-characters, skip the escape.
    chunks.push(String(value))
    return
  }
  if (isHtmlString(value)) {
    for (const chunk of value._chunks) chunks.push(chunk)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) appendValue(chunks, item)
    return
  }
  // Everything else (objects, BigInt, Symbol coercion) goes through
  // String() + escape so we never leak `[object Object]` raw.
  chunks.push(Bun.escapeHTML(String(value)))
}

/**
 * Internal constructor. Freezing keeps callers from mutating the
 * chunk list and bypassing the escape guarantees.
 *
 * @param {Array<string | Uint8Array>} chunks
 * @returns {HtmlString}
 */
function makeHtml(chunks) {
  const obj = {
    [HTML_BRAND]: true,
    _chunks: chunks,
    toString() {
      let total = ''
      for (const chunk of this._chunks) {
        total += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
      }
      return total
    },
    bytes() {
      // Encode every string chunk to UTF-8 once, concat into a single
      // Uint8Array. Bun.write accepts Uint8Array directly without
      // re-encoding — that's the zero-copy build emission win.
      const buffers = this._chunks.map(chunk =>
        typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
      )
      let total = 0
      for (const buf of buffers) total += buf.byteLength
      const out = new Uint8Array(total)
      let offset = 0
      for (const buf of buffers) {
        out.set(buf, offset)
        offset += buf.byteLength
      }
      return out
    },
  }
  return Object.freeze(obj)
}
