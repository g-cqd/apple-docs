import { inflateSync } from 'node:zlib'
import { ParseError } from '../../lib/errors.js'
// PDF object-graph extraction. Walks the (latin-1-decoded) PDF source,
// indexes every `<n> <gen> obj … endobj` block, parses its trailing
// dictionary, and records the byte offsets of any embedded stream so
// the binary payload can be inflated later without going through the
// latin-1 round-trip.
//
// Decompression uses `node:zlib.inflateSync` rather than
// `Bun.inflateSync`: Bun's implementation rejects the DEFLATE streams
// emitted by Apple's `CGPDFContext` (the zlib-wrapped stream starts
// with a valid `78 01` header but Bun reports "invalid stored block
// lengths" mid-stream, while `node:zlib` decompresses cleanly). When
// Bun ships an inflate fix this back-port becomes optional, but
// keeping `node:zlib` here costs nothing and protects against
// regression for the symbol-prerender pipeline.

export function bytesToLatin1(buf) {
  // latin-1 round-trip preserves every byte 1:1, which is what PDF text
  // assumes for non-stream content. Streams are still read from the original
  // Uint8Array via byte offsets recorded here.
  let s = ''
  const chunk = 0x10000
  for (let i = 0; i < buf.length; i += chunk) {
    s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + chunk, buf.length)))
  }
  return s
}

export function collectObjects(text, bytes) {
  // Two-pass extraction so indirect-reference `/Length N gen R` values
  // (used by Apple's symbol PDFs for larger streams) can be resolved
  // against the full object table before slicing stream bytes. Treating
  // the regex match as a literal length truncated those streams mid-
  // DEFLATE-block and broke ~12 % of symbol prerenders with
  // "invalid stored block lengths" from inflate.
  const records = []
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  for (const match of text.matchAll(re)) {
    const id = `${match[1]} ${match[2]}`
    const headerEnd = match.index + match[0].length
    const endObj = text.indexOf('endobj', headerEnd)
    if (endObj < 0) continue
    const body = text.slice(headerEnd, endObj)
    const streamStart = body.indexOf('stream')
    const dictText = streamStart >= 0 ? body.slice(0, streamStart) : body
    const dict = parseDictionary(dictText)
    let streamRange = null
    if (streamStart >= 0) {
      // The content after "stream\n" is raw bytes; locate it back in the
      // original Uint8Array by absolute offset so binary data isn't mangled
      // by the latin-1 decode round-trip above.
      let absStart = headerEnd + streamStart + 'stream'.length
      // Per spec, "stream" is followed by either CRLF or a single LF.
      if (text.charCodeAt(absStart) === 0x0d) absStart++
      if (text.charCodeAt(absStart) === 0x0a) absStart++
      streamRange = { absStart, headerEnd, body, streamStart }
    }
    records.push({ id, dict, streamRange })
  }

  // First pass: index every object so indirect refs from `/Length` can
  // dereference into already-parsed dicts. Numeric-only objects (the
  // typical /Length target shape) have `dict = {}` since they have no
  // `<<…>>`; their literal value is parsed in pass two via `findLiteralNumber`.
  const objects = new Map()
  for (const r of records) objects.set(r.id, { id: r.id, dict: r.dict, stream: null })

  // Second pass: slice each stream now that we can resolve indirect /Length.
  for (const r of records) {
    if (!r.streamRange) continue
    const { absStart, headerEnd, body, streamStart } = r.streamRange
    const literalLength = resolveStreamLength(r.dict.Length, text)
    let absEnd
    if (literalLength != null) {
      absEnd = absStart + literalLength
    } else {
      // Fallback: scan to the next `endstream` marker and trim any trailing
      // newline. Less robust than `/Length` when the compressed payload
      // happens to contain the byte sequence "endstream", but the only
      // remaining option when both forms of `/Length` are absent or unparseable.
      const endStreamRel = body.indexOf('endstream', streamStart)
      absEnd = headerEnd + endStreamRel
      while (absEnd > absStart && (bytes[absEnd - 1] === 0x0a || bytes[absEnd - 1] === 0x0d)) {
        absEnd--
      }
    }
    objects.get(r.id).stream = bytes.subarray(absStart, absEnd)
  }
  return objects
}

/**
 * Coerce a `/Length` field into a literal byte count. Returns null when
 * the value isn't a positive number and can't be resolved via an
 * indirect reference.
 *
 * @param {unknown} value - the parsed dict value at `dict.Length`
 * @param {string} text  - the latin-1 PDF source, used to look up
 *                        indirect-reference target objects
 * @returns {number | null}
 */
function resolveStreamLength(value, text) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (value && typeof value === 'object' && typeof value.ref === 'string') {
    const refMatch = value.ref.match(/^(\d+)\s+(\d+)$/)
    if (!refMatch) return null
    const [, objNum, genNum] = refMatch
    return findLiteralNumber(text, objNum, genNum)
  }
  return null
}

/**
 * Locate `<objNum> <genNum> obj <integer> endobj` in the PDF source and
 * return the integer body. Returns null when the target object isn't a
 * bare numeric literal.
 */
function findLiteralNumber(text, objNum, genNum) {
  // Anchor on the actual obj header so we don't collide with the same
  // digit sequence appearing inside another stream's text.
  const headerRe = new RegExp(`(?:^|[\\s\\r\\n])${objNum}\\s+${genNum}\\s+obj\\b`)
  const headerMatch = text.match(headerRe)
  if (!headerMatch) return null
  const headerEnd = (headerMatch.index ?? 0) + headerMatch[0].length
  const endObj = text.indexOf('endobj', headerEnd)
  if (endObj < 0) return null
  const innerText = text.slice(headerEnd, endObj).trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(innerText)) return null
  const parsed = Number.parseFloat(innerText)
  return Number.isFinite(parsed) ? parsed : null
}

function parseDictionary(text) {
  // Minimal PDF dictionary parser. We only need to extract the entries that
  // appear in CGContext-emitted PDFs: simple names, numbers, indirect refs,
  // arrays of numbers, and nested dictionaries. Strings, hex strings, and
  // streams aren't expected here.
  const start = text.indexOf('<<')
  if (start < 0) return {}
  let i = start + 2
  const out = {}
  while (i < text.length) {
    skipWs(text, i, value => { i = value })
    if (text.startsWith('>>', i)) break
    if (text[i] !== '/') { i++; continue }
    i++
    const keyStart = i
    while (i < text.length && !/[\s/<>[\]]/.test(text[i])) i++
    const key = text.slice(keyStart, i)
    skipWs(text, i, value => { i = value })
    if (text.startsWith('<<', i)) {
      const endNested = findMatching(text, i, '<<', '>>')
      out[key] = parseDictionary(text.slice(i, endNested + 2))
      i = endNested + 2
    } else if (text[i] === '[') {
      const endArr = text.indexOf(']', i)
      out[key] = text.slice(i + 1, endArr).trim()
      i = endArr + 1
    } else if (text[i] === '/') {
      i++
      const nameStart = i
      while (i < text.length && !/[\s/<>[\]]/.test(text[i])) i++
      out[key] = `/${text.slice(nameStart, i)}`
    } else {
      const tokenStart = i
      while (i < text.length && !/[\s/<>[\]]/.test(text[i])) i++
      const token = text.slice(tokenStart, i).trim()
      // Indirect reference: "<obj> <gen> R"
      const refMatch = token.match(/^(\d+)$/)
      if (refMatch) {
        const after = text.slice(i)
        const refRest = after.match(/^\s+(\d+)\s+R\b/)
        if (refRest) {
          out[key] = { ref: `${refMatch[1]} ${refRest[1]}` }
          i += refRest[0].length
        } else {
          out[key] = Number.parseFloat(token)
        }
      } else if (/^-?\d+(?:\.\d+)?$/.test(token)) {
        out[key] = Number.parseFloat(token)
      } else {
        out[key] = token
      }
    }
  }
  return out
}

function skipWs(text, start, set) {
  let i = start
  while (i < text.length && /[\s\r\n]/.test(text[i])) i++
  set(i)
}

function findMatching(text, start, open, close) {
  let depth = 1
  let i = start + open.length
  while (i < text.length && depth > 0) {
    if (text.startsWith(open, i)) { depth++; i += open.length }
    else if (text.startsWith(close, i)) { depth--; if (depth === 0) return i; i += close.length }
    else i++
  }
  return text.length - close.length
}

export function findPage(objects) {
  for (const obj of objects.values()) {
    if (obj.dict?.Type === '/Page') return obj
  }
  return null
}

export function resolveDict(value, objects) {
  if (value == null || typeof value !== 'object') return null
  if ('ref' in value) {
    return objects.get(value.ref)?.dict ?? null
  }
  return value
}

export function resolveStreamObject(value, objects) {
  if (value == null || typeof value !== 'object') return null
  if ('ref' in value) {
    return objects.get(value.ref) ?? null
  }
  return null
}

export function decodeStream(obj) {
  const filter = obj.dict.Filter
  if (filter === '/FlateDecode') return inflateSync(obj.stream)
  if (!filter) return obj.stream
  throw new ParseError(`symbol PDF: unsupported stream filter ${filter}`)
}
