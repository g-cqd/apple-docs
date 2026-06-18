/**
 * Storage dispatch (RFC 0001 P5 first slice): a native SQLite read path for
 * `searchPages` over the EXISTING real-SQLite corpus, served by
 * libAppleDocsCore (dlopen'd libsqlite3) via bun:ffi. The bun:sqlite WRITER
 * is untouched; this is read-only. The native attempt runs INSIDE the
 * reader-pool workers (blocking FFI on a worker thread is safe), with a
 * per-call fall back to the JS `db.searchPages` on any doubt.
 *
 * Default OFF until the measured GO/NO-GO (the concurrency gate): unlike the
 * other modules, blanket `APPLE_DOCS_NATIVE` unset/on does NOT enable
 * storage — it must be named explicitly (`APPLE_DOCS_NATIVE=storage` or
 * `…,storage`). bun:sqlite is already native C SQLite, so the bridge-era
 * win is unproven; this stays opt-in until the benchmark says otherwise.
 *
 * Byte layouts are shared verbatim with
 * swift/Sources/ADCore/StorageExports.swift — change both sides together.
 * Nullable string: [u32 len][utf8], len 0xFFFFFFFF = null.
 * Nullable u64:    [u64], value 0xFFFFFFFFFFFFFFFF = null.
 */
import { createLogger } from '../lib/logger.js'
import { getNativeLib } from '../native/loader.js'
import { NATIVE_STATUS_OK, readNativeResult } from '../native/result.js'
import { buildFilterParams } from './repos/search.js'

const MODULE = 'storage'
const NULL_STRING = 0xffffffff
const NULL_U64 = 0xffffffffffffffffn

// searchPages result column order — MUST match StorageExports.swift /
// search.js RESULT_COLUMNS (then rank, tier). The shim builds row objects
// positionally, so this also fixes bun:sqlite's key insertion order.
const SEARCH_PAGES_COLUMNS = [
  'path',
  'title',
  'role',
  'role_heading',
  'abstract',
  'declaration',
  'platforms',
  'min_ios',
  'min_macos',
  'min_watchos',
  'min_tvos',
  'min_visionos',
  'framework',
  'root_slug',
  'source_type',
  'source_metadata',
  'url_depth',
  'is_release_notes',
  'is_deprecated',
  'is_beta',
  'doc_kind',
  'language',
  'rank',
  'tier',
]

/** @type {'js' | 'native' | null} */
let forced = null // 'js' | 'native' | null
let announced = false
/** @type {import('../lib/logger.js').Logger | undefined} */
let logger

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Test seam. @param {'js' | 'native' | null} impl */
export function _forceImpl(impl) {
  forced = impl
  announced = false
}

/** Opt-in only (default OFF pre-GO): explicit `storage` token enables it. */
function moduleEnabled() {
  const raw = (process.env.APPLE_DOCS_NATIVE ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'off') return false
  if (raw === '' || raw === '1' || raw === 'on') return false
  return raw.split(',').some((entry) => entry.trim() === MODULE)
}

function nativeLib() {
  if (forced === 'js') return null
  if (forced !== 'native' && !moduleEnabled()) return null
  const lib = getNativeLib()
  if (!announced) {
    logger ??= createLogger(process.env.APPLE_DOCS_LOG_LEVEL || 'info')
    logger.info(`storage: searchPages served by ${lib ? 'native libAppleDocsCore' : 'js (native unavailable)'}`)
    announced = true
  }
  return lib
}

// Grow-only scratch (content-native.js pattern): calls are synchronous and
// single-threaded within a worker; the native side consumes the bytes
// before returning.
let scratch = new ArrayBuffer(8192)
let scratchU8 = new Uint8Array(scratch)
let scratchView = new DataView(scratch)

/** @param {number} minimum */
function growScratch(minimum) {
  let size = scratch.byteLength * 2
  while (size < minimum) size *= 2
  const next = new ArrayBuffer(size)
  const nextU8 = new Uint8Array(next)
  nextU8.set(scratchU8)
  scratch = next
  scratchU8 = nextU8
  scratchView = new DataView(scratch)
}

class Packer {
  constructor() {
    this.offset = 0
  }

  /** @param {number} extra */
  ensure(extra) {
    if (this.offset + extra > scratch.byteLength) growScratch(this.offset + extra)
  }

  /** @param {number} value */
  u32(value) {
    this.ensure(4)
    scratchView.setUint32(this.offset, value, true)
    this.offset += 4
  }

  /** @param {number | bigint} value */
  u64(value) {
    this.ensure(8)
    scratchView.setBigUint64(this.offset, BigInt(value), true)
    this.offset += 8
  }

  /** Nullable u64: null/undefined → sentinel. @param {number | null | undefined} value */
  nullableU64(value) {
    if (value === null || value === undefined) {
      this.u64(NULL_U64)
      return
    }
    this.u64(value)
  }

  /** Nullable string: null/undefined → sentinel. @param {unknown} value */
  string(value) {
    if (value === null || value === undefined) {
      this.u32(NULL_STRING)
      return
    }
    const text = typeof value === 'string' ? value : String(value)
    this.ensure(4 + text.length * 3)
    const { written } = encoder.encodeInto(text, scratchU8.subarray(this.offset + 4))
    scratchView.setUint32(this.offset, written, true)
    this.offset += 4 + written
  }

  finish() {
    return { bytes: scratchU8, length: this.offset }
  }
}

/** @param {string} symbol @param {Packer} packer */
function call(symbol, packer) {
  const lib = nativeLib()
  if (!lib) return null
  const fn = /** @type {any} */ (lib.symbols)[symbol]
  if (typeof fn !== 'function') return null
  try {
    const { bytes, length } = packer.finish()
    const result = readNativeResult(lib, fn(bytes, BigInt(length)))
    if (result.status !== NATIVE_STATUS_OK) return null
    return result.bytes
  } catch {
    return null
  }
}

/**
 * Opens a native read handle for `dbPath`. Returns an opaque BigInt handle
 * or null (storage disabled, dylib/FTS5 absent, or open failed → the worker
 * keeps using bun:sqlite for searchPages).
 * @param {unknown} dbPath
 */
export function nativeStorageOpen(dbPath) {
  const packer = new Packer()
  packer.u32(1)
  packer.string(typeof dbPath === 'string' ? dbPath : null)
  const bytes = call('ad_storage_open', packer)
  if (!bytes || bytes.length < 8) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getBigUint64(0, true)
}

/** Closes a native read handle. @param {bigint | null | undefined} handle */
export function nativeStorageClose(handle) {
  if (handle === null || handle === undefined) return
  const packer = new Packer()
  packer.u32(1)
  packer.u64(handle)
  call('ad_storage_close', packer)
}

/**
 * Native searchPages(ftsQuery, rawQuery, opts) on `handle`. Returns the same
 * row array bun:sqlite produces, or null to fall back to JS.
 * @param {bigint | null | undefined} handle @param {string} ftsQuery @param {string} rawQuery
 * @param {Record<string, any>} [opts]
 */
export function nativeSearchPages(handle, ftsQuery, rawQuery, opts = {}) {
  if (handle === null || handle === undefined) return null
  const f = buildFilterParams(opts)
  const packer = new Packer()
  packer.u32(1)
  packer.u64(handle)
  packer.string(ftsQuery)
  packer.string(rawQuery)
  packer.u32(opts.limit ?? 100)
  packer.string(f.$framework)
  packer.string(f.$source_type)
  packer.string(f.$sources_json)
  packer.string(f.$kind)
  packer.string(f.$language)
  packer.nullableU64(f.$year)
  packer.string(f.$track_like)
  packer.string(f.$deprecated_mode)
  packer.nullableU64(f.$min_ios)
  packer.nullableU64(f.$min_macos)
  packer.nullableU64(f.$min_watchos)
  packer.nullableU64(f.$min_tvos)
  packer.nullableU64(f.$min_visionos)
  const bytes = call('ad_storage_search_pages', packer)
  if (!bytes) return null
  return decodeRows(bytes)
}

/** Decodes [u32 columnCount][u32 rowCount] + type-tagged cells into rows. */
/** @param {Uint8Array} bytes */
function decodeRows(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 0
  const columnCount = view.getUint32(off, true)
  off += 4
  if (columnCount !== SEARCH_PAGES_COLUMNS.length) return null
  const rowCount = view.getUint32(off, true)
  off += 4
  const rows = new Array(rowCount)
  for (let r = 0; r < rowCount; r++) {
    /** @type {Record<string, any>} */
    const row = {}
    for (let c = 0; c < columnCount; c++) {
      const tag = bytes[off]
      off += 1
      let value
      switch (tag) {
        case 0:
          value = null
          break
        case 1:
          value = Number(view.getBigInt64(off, true))
          off += 8
          break
        case 2:
          value = view.getFloat64(off, true)
          off += 8
          break
        case 3: {
          const len = view.getUint32(off, true)
          off += 4
          value = decoder.decode(bytes.subarray(off, off + len))
          off += len
          break
        }
        case 4: {
          const len = view.getUint32(off, true)
          off += 4
          value = bytes.slice(off, off + len)
          off += len
          break
        }
        default:
          return null
      }
      row[SEARCH_PAGES_COLUMNS[c]] = value
    }
    rows[r] = row
  }
  return rows
}
