/**
 * Build `glyphName -> codepoint` map from an SFNT font's `cmap` and
 * `post` tables. Apple ships SF Symbols inside SF-Pro.ttf with each
 * symbol's PostScript glyph name (in `post` format 2) matching the
 * symbol's catalog name (e.g. `house.fill`), and the `cmap`
 * (format 4 or 12) mapping a Private Use Area codepoint to the glyph
 * index. Joining the two yields `symbolName -> codepoint`.
 *
 * We hand-roll the two table parsers we need rather than pulling in
 * an OpenType library — only ~250 lines of binary reading and no new
 * project deps. Reference: the OpenType spec
 *   https://learn.microsoft.com/en-us/typography/opentype/spec/cmap
 *   https://learn.microsoft.com/en-us/typography/opentype/spec/post
 */

import { readFile } from 'node:fs/promises'

/**
 * Unicode Private Use Area ranges where SF Symbol codepoints legitimately
 * live. Apple uses the supplementary PUA blocks for the symbol catalog.
 * Anything mapped outside these ranges is almost certainly a real Latin
 * glyph (we want to reject those — they're not symbols).
 */
const PUA_RANGES = Object.freeze([
  [0xe000, 0xf8ff],     // BMP Private Use Area
  [0xf0000, 0xffffd],   // Supplementary Private Use Area-A
  [0x100000, 0x10fffd], // Supplementary Private Use Area-B
])

export function isPrivateUseCodepoint(codepoint) {
  if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff) return false
  for (const [lo, hi] of PUA_RANGES) {
    if (codepoint >= lo && codepoint <= hi) return true
  }
  return false
}

/**
 * Format a codepoint as the canonical `U+XXXX` Unicode notation Apple
 * uses in the SF Symbols app. Always at least 4 hex digits, zero-padded.
 */
export function formatCodepoint(codepoint) {
  if (codepoint == null) return null
  const hex = codepoint.toString(16).toUpperCase()
  return `U+${hex.length < 4 ? hex.padStart(4, '0') : hex}`
}

/**
 * Parse the SFNT header (offset table) and the table directory.
 * Returns `{ tables: Map<tag, {offset, length}>, sfntVersion }`.
 */
function parseSfntDirectory(buf) {
  if (buf.length < 12) throw new Error('font too short for SFNT header')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const sfntVersion = view.getUint32(0, false)
  const numTables = view.getUint16(4, false)
  const tables = new Map()
  for (let i = 0; i < numTables; i++) {
    const recOffset = 12 + i * 16
    const tag = String.fromCharCode(
      buf[recOffset], buf[recOffset + 1], buf[recOffset + 2], buf[recOffset + 3],
    )
    const offset = view.getUint32(recOffset + 8, false)
    const length = view.getUint32(recOffset + 12, false)
    tables.set(tag, { offset, length })
  }
  return { tables, sfntVersion }
}

function getTable(buf, tables, tag) {
  const rec = tables.get(tag)
  if (!rec) throw new Error(`missing required table: ${tag}`)
  return buf.subarray(rec.offset, rec.offset + rec.length)
}

/**
 * Parse `cmap` and return a single `codepoint -> glyphIndex` map.
 * Prefers (platform=0/unicode, encoding=4 → full Unicode) and falls
 * back to (3/10 → Windows/UCS-4), (3/1 → Windows/UCS-2). Both
 * format 4 (BMP) and format 12 (supplementary plane) are supported.
 *
 * @param {Uint8Array} cmapTable
 * @returns {Map<number, number>}
 */
export function parseCmap(cmapTable) {
  const view = new DataView(cmapTable.buffer, cmapTable.byteOffset, cmapTable.byteLength)
  const numSubtables = view.getUint16(2, false)
  const candidates = []
  for (let i = 0; i < numSubtables; i++) {
    const recOff = 4 + i * 8
    const platformID = view.getUint16(recOff, false)
    const encodingID = view.getUint16(recOff + 2, false)
    const subtableOffset = view.getUint32(recOff + 4, false)
    candidates.push({ platformID, encodingID, subtableOffset })
  }
  // Preference order: Unicode full repertoire (0,4 / 0,6); Windows UCS-4 (3,10);
  // Unicode 2.0 BMP (0,3); Windows UCS-2 (3,1). SF-Pro.ttf ships format 12.
  const priority = (c) => {
    if (c.platformID === 0 && c.encodingID === 4) return 0
    if (c.platformID === 0 && c.encodingID === 6) return 1
    if (c.platformID === 3 && c.encodingID === 10) return 2
    if (c.platformID === 0 && c.encodingID === 3) return 3
    if (c.platformID === 3 && c.encodingID === 1) return 4
    return 99
  }
  candidates.sort((a, b) => priority(a) - priority(b))
  for (const c of candidates) {
    const map = tryParseCmapSubtable(cmapTable, view, c.subtableOffset)
    if (map && map.size > 0) return map
  }
  throw new Error('no usable cmap subtable (formats 4/12) found')
}

function tryParseCmapSubtable(cmapTable, view, offset) {
  const format = view.getUint16(offset, false)
  if (format === 4) return parseCmapFormat4(cmapTable, offset)
  if (format === 12) return parseCmapFormat12(view, offset)
  return null
}

function parseCmapFormat4(cmapTable, offset) {
  const view = new DataView(cmapTable.buffer, cmapTable.byteOffset, cmapTable.byteLength)
  const length = view.getUint16(offset + 2, false)
  const segCountX2 = view.getUint16(offset + 6, false)
  const segCount = segCountX2 / 2
  const endCodeOff = offset + 14
  const startCodeOff = endCodeOff + segCountX2 + 2 // skip reservedPad (2 bytes)
  const idDeltaOff = startCodeOff + segCountX2
  const idRangeOffsetOff = idDeltaOff + segCountX2
  const map = new Map()
  for (let i = 0; i < segCount; i++) {
    const endCode = view.getUint16(endCodeOff + i * 2, false)
    const startCode = view.getUint16(startCodeOff + i * 2, false)
    const idDelta = view.getInt16(idDeltaOff + i * 2, false)
    const idRangeOffset = view.getUint16(idRangeOffsetOff + i * 2, false)
    if (startCode === 0xffff && endCode === 0xffff) continue
    for (let cp = startCode; cp <= endCode; cp++) {
      let glyphIndex
      if (idRangeOffset === 0) {
        glyphIndex = (cp + idDelta) & 0xffff
      } else {
        const glyphIndexAddr =
          idRangeOffsetOff + i * 2 + idRangeOffset + (cp - startCode) * 2
        // Bounds guard — corrupt fonts can point outside the table.
        if (glyphIndexAddr + 2 > cmapTable.length) continue
        const raw = view.getUint16(glyphIndexAddr, false)
        if (raw === 0) continue
        glyphIndex = (raw + idDelta) & 0xffff
      }
      if (glyphIndex !== 0) map.set(cp, glyphIndex)
    }
    if (endCode === 0xffff) break
  }
  // length is referenced in the spec; suppress unused warning by reading once.
  void length
  return map
}

function parseCmapFormat12(view, offset) {
  // format 12: uint16 format, uint16 reserved, uint32 length, uint32 language,
  //            uint32 numGroups, then numGroups × (uint32 startChar, uint32 endChar, uint32 startGlyph)
  const numGroups = view.getUint32(offset + 12, false)
  const groupsOff = offset + 16
  const map = new Map()
  for (let i = 0; i < numGroups; i++) {
    const off = groupsOff + i * 12
    const startChar = view.getUint32(off, false)
    const endChar = view.getUint32(off + 4, false)
    const startGlyph = view.getUint32(off + 8, false)
    for (let cp = startChar; cp <= endChar; cp++) {
      map.set(cp, startGlyph + (cp - startChar))
    }
  }
  return map
}

/**
 * Parse `post` format 2.0 and return `glyphIndex -> glyphName`.
 * Format 2 layout:
 *   - header (32 bytes): version, italic, underline, fixedPitch, mem etc.
 *   - uint16 numGlyphs
 *   - uint16[numGlyphs] glyphNameIndex
 *      values < 258 → standard Macintosh glyph name from the fixed table
 *      values ≥ 258 → custom Pascal string index = value - 258
 *   - Pascal strings (uint8 length, then `length` bytes of ASCII)
 *
 * @param {Uint8Array} postTable
 * @returns {Map<number, string>}
 */
export function parsePost(postTable) {
  const view = new DataView(postTable.buffer, postTable.byteOffset, postTable.byteLength)
  const version = view.getUint32(0, false)
  // Only format 2 carries custom names (which is what SF-Pro.ttf uses for
  // its symbol catalog). Format 3 strips names; format 4 is Apple Type 1
  // legacy; format 1 / 2.5 we don't expect from SF-Pro.
  if (version !== 0x00020000) {
    throw new Error(`unsupported post table version 0x${version.toString(16)}; only 2.0 is supported`)
  }
  const numGlyphs = view.getUint16(32, false)
  const indices = new Array(numGlyphs)
  for (let i = 0; i < numGlyphs; i++) {
    indices[i] = view.getUint16(34 + i * 2, false)
  }
  // Pascal strings follow the index array.
  let stringsOff = 34 + numGlyphs * 2
  const customNames = []
  while (stringsOff < postTable.length) {
    const len = postTable[stringsOff]
    stringsOff += 1
    if (stringsOff + len > postTable.length) break
    const bytes = postTable.subarray(stringsOff, stringsOff + len)
    customNames.push(new TextDecoder('latin1').decode(bytes))
    stringsOff += len
  }
  const map = new Map()
  for (let i = 0; i < numGlyphs; i++) {
    const idx = indices[i]
    let name
    if (idx < 258) name = MACINTOSH_GLYPH_NAMES[idx] ?? null
    else name = customNames[idx - 258] ?? null
    if (name) map.set(i, name)
  }
  return map
}

/**
 * Build the full `glyphName -> codepoint` map from a font file.
 * Iterates the cmap and joins it against the post-table glyph names.
 * When a glyph has multiple codepoints (rare for SF Symbols — usually
 * a Latin alias), we keep the lowest one for determinism.
 *
 * Filters mappings to the Private Use Area: SF Symbol catalog glyphs
 * (e.g. `house.fill`) only live there. A `post` name that happens to
 * match a glyph at a real Latin/CJK codepoint is not a symbol mapping
 * and gets dropped — this also defends against accidentally stamping
 * "U+0041" on a symbol named after the letter A.
 *
 * @param {string} filePath Absolute path to the .ttf / .otf file
 * @returns {Promise<Map<string, number>>}
 */
export async function buildNameToCodepointMap(filePath) {
  const buf = await readFile(filePath)
  return buildNameToCodepointMapFromBuffer(buf)
}

/**
 * Synchronous variant that takes a Uint8Array / Buffer directly. Useful
 * for tests that want to swap in a synthetic font.
 */
export function buildNameToCodepointMapFromBuffer(buf) {
  const { tables } = parseSfntDirectory(buf)
  const cmapTable = getTable(buf, tables, 'cmap')
  const postTable = getTable(buf, tables, 'post')
  const cmap = parseCmap(cmapTable)
  const glyphNames = parsePost(postTable)
  const out = new Map()
  for (const [codepoint, glyphIndex] of cmap) {
    if (!isPrivateUseCodepoint(codepoint)) continue
    const name = glyphNames.get(glyphIndex)
    if (!name) continue
    const prev = out.get(name)
    if (prev == null || codepoint < prev) out.set(name, codepoint)
  }
  return out
}

/** Macintosh standard glyph order used by `post` format 2 for indices < 258. */
const MACINTOSH_GLYPH_NAMES = [
  '.notdef', '.null', 'nonmarkingreturn', 'space', 'exclam', 'quotedbl', 'numbersign',
  'dollar', 'percent', 'ampersand', 'quotesingle', 'parenleft', 'parenright',
  'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash', 'zero', 'one', 'two',
  'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'colon', 'semicolon',
  'less', 'equal', 'greater', 'question', 'at', 'A', 'B', 'C', 'D', 'E', 'F', 'G',
  'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W',
  'X', 'Y', 'Z', 'bracketleft', 'backslash', 'bracketright', 'asciicircum',
  'underscore', 'grave', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k',
  'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'braceleft', 'bar', 'braceright', 'asciitilde', 'Adieresis', 'Aring', 'Ccedilla',
  'Eacute', 'Ntilde', 'Odieresis', 'Udieresis', 'aacute', 'agrave', 'acircumflex',
  'adieresis', 'atilde', 'aring', 'ccedilla', 'eacute', 'egrave', 'ecircumflex',
  'edieresis', 'iacute', 'igrave', 'icircumflex', 'idieresis', 'ntilde', 'oacute',
  'ograve', 'ocircumflex', 'odieresis', 'otilde', 'uacute', 'ugrave', 'ucircumflex',
  'udieresis', 'dagger', 'degree', 'cent', 'sterling', 'section', 'bullet',
  'paragraph', 'germandbls', 'registered', 'copyright', 'trademark', 'acute',
  'dieresis', 'notequal', 'AE', 'Oslash', 'infinity', 'plusminus', 'lessequal',
  'greaterequal', 'yen', 'mu', 'partialdiff', 'summation', 'product', 'pi',
  'integral', 'ordfeminine', 'ordmasculine', 'Omega', 'ae', 'oslash',
  'questiondown', 'exclamdown', 'logicalnot', 'radical', 'florin', 'approxequal',
  'Delta', 'guillemotleft', 'guillemotright', 'ellipsis', 'nonbreakingspace',
  'Agrave', 'Atilde', 'Otilde', 'OE', 'oe', 'endash', 'emdash', 'quotedblleft',
  'quotedblright', 'quoteleft', 'quoteright', 'divide', 'lozenge', 'ydieresis',
  'Ydieresis', 'fraction', 'currency', 'guilsinglleft', 'guilsinglright', 'fi',
  'fl', 'daggerdbl', 'periodcentered', 'quotesinglbase', 'quotedblbase',
  'perthousand', 'Acircumflex', 'Ecircumflex', 'Aacute', 'Edieresis', 'Egrave',
  'Iacute', 'Icircumflex', 'Idieresis', 'Eth', 'eth', 'Yacute', 'yacute', 'Thorn',
  'thorn', 'minus', 'multiply', 'onesuperior', 'twosuperior', 'threesuperior',
  'onehalf', 'onequarter', 'threequarters', 'franc', 'Gbreve', 'gbreve',
  'Idotaccent', 'Scedilla', 'scedilla', 'Cacute', 'cacute', 'Ccaron', 'ccaron',
  'dcroat',
]
