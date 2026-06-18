// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
// HTML entity decoding. Handles named entities + decimal/hex numeric
// character references.
//
// Decode order matters: `&amp;` must be processed LAST. Otherwise an
// input like `&amp;lt;` (the literal "&lt;" with the ampersand encoded)
// would round-trip incorrectly:
//   - decode `&amp;` → `&` first → `&lt;`
//   - then decode `&lt;` → `<` → "<"
// instead of the correct "<lt;" → wait, the correct output is "&lt;"
// (the input represented a literal "&lt;" string).
//
// CodeQL `js/double-escaping` flags the early-`&amp;` ordering for
// exactly this reason. Decoding `&amp;` last leaves the inner entity
// untouched: `&amp;lt;` → (no other rule matches) → `&amp;lt;` →
// `&lt;`, which is the original literal string.
export function decodeEntities(text) {
  return (
    text
      // Named entities other than &amp; (process FIRST so &amp;-encoded
      // copies of the literal entity text survive).
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/')
      .replace(/&nbsp;/g, ' ')
      // Numeric entities (decimal + hex).
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      // &amp; LAST so already-double-encoded entities round-trip correctly.
      .replace(/&amp;/g, '&')
  )
}
