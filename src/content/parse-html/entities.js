// HTML entity decoding. Handles named entities + decimal/hex numeric
// character references.

export function decodeEntities(text) {
  return text
    // Named entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    // Decimal numeric entities: &#NNN;
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    // Hex numeric entities: &#xHH; or &#XHH;
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
}
