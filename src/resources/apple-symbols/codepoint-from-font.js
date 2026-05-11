/**
 * SFNT `cmap` table parser — codepoint → glyph-index map.
 *
 * Originally written as a name→codepoint extractor for SF Symbols (joining
 * `cmap` and `post` format 2 by glyph index), but the spike
 * `docs/spikes/sf-symbol-codepoints.md` established that catalog-shaped
 * names like `house.fill` aren't in SF-Pro.ttf's `post` table — Apple
 * resolves them at runtime through `metadata.store` via the private
 * `CoreGlyphsLib` framework. The `post`-table path is therefore dead
 * weight for symbol-name lookup; it's been removed.
 *
 * What this module is for now: feed `parseCmap` the raw bytes of a
 * font's `cmap` table to recover the legal-codepoint set used by the
 * `/api/fonts/subset` endpoint's cap check.
 *
 * Reference: https://learn.microsoft.com/en-us/typography/opentype/spec/cmap
 */

/**
 * Parse the `cmap` table from an SFNT font and return a
 * `Map<codepoint, glyphIndex>` covering the best available subtable
 * (prefers Unicode full-repertoire formats over BMP-only ones).
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
