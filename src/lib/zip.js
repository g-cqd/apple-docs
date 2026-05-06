// Minimal STORE-method ZIP writer (no compression).
//
// Fonts are already compressed binaries — STORE is the right call: smaller
// CPU cost, identical output size. The writer produces a single buffer with
// local file headers, file data, central directory, and EOCD record. UTF-8
// names supported via the Language Encoding Flag (bit 11).

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Build a STORE-method zip archive from in-memory entries.
 * @param {Array<{ name: string, data: Uint8Array, mtime?: Date }>} entries
 * @returns {Uint8Array}
 */
export function buildStoreZip(entries) {
  const encoder = new TextEncoder()
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const data = entry.data
    const crc = crc32(data)
    const size = data.length
    const { dosTime, dosDate } = toDosTime(entry.mtime ?? new Date())

    // Local file header (30 bytes + name)
    const lfh = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(lfh.buffer)
    lv.setUint32(0, 0x04034b50, true)            // signature
    lv.setUint16(4, 20, true)                    // version needed
    lv.setUint16(6, 0x0800, true)                // flags: bit 11 = UTF-8 names
    lv.setUint16(8, 0, true)                     // method: 0 = STORE
    lv.setUint16(10, dosTime, true)
    lv.setUint16(12, dosDate, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)                 // compressed size
    lv.setUint32(22, size, true)                 // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)                    // extra field length
    lfh.set(nameBytes, 30)

    localParts.push(lfh, data)

    // Central directory file header (46 bytes + name)
    const cdh = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cdh.buffer)
    cv.setUint32(0, 0x02014b50, true)            // signature
    cv.setUint16(4, 0x031e, true)                // version made by (UNIX | 30)
    cv.setUint16(6, 20, true)                    // version needed
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, dosTime, true)
    cv.setUint16(14, dosDate, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)                    // extra
    cv.setUint16(32, 0, true)                    // comment
    cv.setUint16(34, 0, true)                    // disk
    cv.setUint16(36, 0, true)                    // internal attrs
    cv.setUint32(38, 0, true)                    // external attrs
    cv.setUint32(42, offset, true)               // local header offset
    cdh.set(nameBytes, 46)
    centralParts.push(cdh)

    offset += lfh.length + size
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const centralOffset = offset

  // End of central directory record (22 bytes, no zip comment)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(4, 0, true)                       // disk
  ev.setUint16(6, 0, true)                       // disk with central dir
  ev.setUint16(8, entries.length, true)          // entries on this disk
  ev.setUint16(10, entries.length, true)         // total entries
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, centralOffset, true)
  ev.setUint16(20, 0, true)

  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of localParts) { out.set(part, cursor); cursor += part.length }
  for (const part of centralParts) { out.set(part, cursor); cursor += part.length }
  out.set(eocd, cursor)
  return out
}

function toDosTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2))
  return { dosDate: dosDate & 0xffff, dosTime: dosTime & 0xffff }
}
