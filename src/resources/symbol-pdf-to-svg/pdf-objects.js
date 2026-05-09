// PDF object-graph extraction. Walks the (latin-1-decoded) PDF source,
// indexes every `<n> <gen> obj … endobj` block, parses its trailing
// dictionary, and records the byte offsets of any embedded stream so
// the binary payload can be inflated later without going through the
// latin-1 round-trip.
//
// Pulled out of resources/symbol-pdf-to-svg.js as part of Phase B.

import { inflateSync } from 'node:zlib'

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
  const objects = new Map()
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  let match
  while ((match = re.exec(text)) !== null) {
    const id = `${match[1]} ${match[2]}`
    const headerEnd = match.index + match[0].length
    const endObj = text.indexOf('endobj', headerEnd)
    if (endObj < 0) continue
    const body = text.slice(headerEnd, endObj)
    const streamStart = body.indexOf('stream')
    let dictText = body
    let stream = null
    if (streamStart >= 0) {
      dictText = body.slice(0, streamStart)
      // The content after "stream\n" is raw bytes; locate it back in the
      // original Uint8Array by absolute offset so binary data isn't mangled
      // by the latin-1 decode round-trip above.
      let absStart = headerEnd + streamStart + 'stream'.length
      // Per spec, "stream" is followed by either CRLF or a single LF.
      if (text.charCodeAt(absStart) === 0x0d) absStart++
      if (text.charCodeAt(absStart) === 0x0a) absStart++
      // Prefer the declared `/Length` field — Flate-compressed streams can
      // legitimately end with a 0x0A byte, and a back-search-then-trim
      // heuristic would lop that byte off and leave inflate with truncated
      // input ("unexpected end of file"). Length is mandatory in the dict.
      const lengthMatch = dictText.match(/\/Length\s+(\d+)/)
      let absEnd
      if (lengthMatch) {
        absEnd = absStart + parseInt(lengthMatch[1], 10)
      } else {
        const endStreamRel = body.indexOf('endstream', streamStart)
        absEnd = headerEnd + endStreamRel
        while (absEnd > absStart && (bytes[absEnd - 1] === 0x0a || bytes[absEnd - 1] === 0x0d)) {
          absEnd--
        }
      }
      stream = bytes.subarray(absStart, absEnd)
    }
    const dict = parseDictionary(dictText)
    objects.set(id, { id, dict, stream })
  }
  return objects
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
    while (i < text.length && !/[\s/<>\[\]]/.test(text[i])) i++
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
      while (i < text.length && !/[\s/<>\[\]]/.test(text[i])) i++
      out[key] = `/${text.slice(nameStart, i)}`
    } else {
      const tokenStart = i
      while (i < text.length && !/[\s/<>\[\]]/.test(text[i])) i++
      let token = text.slice(tokenStart, i).trim()
      // Indirect reference: "<obj> <gen> R"
      const refMatch = token.match(/^(\d+)$/)
      if (refMatch) {
        const after = text.slice(i)
        const refRest = after.match(/^\s+(\d+)\s+R\b/)
        if (refRest) {
          out[key] = { ref: `${refMatch[1]} ${refRest[1]}` }
          i += refRest[0].length
        } else {
          out[key] = parseFloat(token)
        }
      } else if (/^-?\d+(?:\.\d+)?$/.test(token)) {
        out[key] = parseFloat(token)
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
  if (!value) return null
  if (typeof value === 'object' && value !== null && 'ref' in value) {
    return objects.get(value.ref)?.dict ?? null
  }
  if (typeof value === 'object') return value
  return null
}

export function resolveStreamObject(value, objects) {
  if (!value) return null
  if (typeof value === 'object' && 'ref' in value) {
    return objects.get(value.ref) ?? null
  }
  return null
}

export function decodeStream(obj) {
  const filter = obj.dict.Filter
  if (filter === '/FlateDecode') return inflateSync(obj.stream)
  if (!filter) return obj.stream
  throw new Error(`symbol PDF: unsupported stream filter ${filter}`)
}
