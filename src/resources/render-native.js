/**
 * Render dispatch (RFC 0003 P3-darwin phase 1): the in-process Swift
 * renderers (libAppleDocsCore ad_render_*) behind the `render`
 * kill-switch token — replacing the ~200 ms `swift script.swift` JIT
 * cold-start on cache-miss query renders.
 *
 * Stateless request/response, so this uses the fusion-native shape:
 * announce-once, `_forceImpl`, and a PER-CALL fallback — a null return
 * means "use the spawn path" (native off, dylib absent, non-darwin, or a
 * render that produced nothing), so every caller degrades cleanly.
 *
 * Byte layouts are shared verbatim with
 * swift/Sources/ADCore/RenderExports.swift: nullable strings are
 * [u32 len][utf8] with len 0xFFFFFFFF meaning null.
 */
import { createLogger } from '../lib/logger.js'
import { getNativeLib, isNativeEnabled } from '../native/loader.js'
import { NATIVE_STATUS_OK, readNativeResult } from '../native/result.js'

const MODULE = 'render'
const NULL_SENTINEL = 0xffffffff
let forced = null // 'js' | 'native' | null
let announced = false
let logger

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Test seam. */
export function _forceImpl(impl) {
  forced = impl
  announced = false
}

function nativeLib() {
  if (forced === 'js') return null
  if (forced !== 'native' && !isNativeEnabled(MODULE)) return null
  const lib = getNativeLib()
  if (!announced) {
    logger ??= createLogger(process.env.APPLE_DOCS_LOG_LEVEL || 'info')
    logger.info(`render: served by ${lib ? 'native libAppleDocsCore' : 'js (native unavailable)'}`)
    announced = true
  }
  return lib
}

// Grow-only scratch (fusion-native pattern): synchronous, single-threaded;
// the native side consumes the bytes before the call returns.
let scratch = new ArrayBuffer(8192)
let scratchU8 = new Uint8Array(scratch)
let scratchView = new DataView(scratch)

function ensure(byteLength) {
  if (scratch.byteLength < byteLength) {
    let size = scratch.byteLength * 2
    while (size < byteLength) size *= 2
    scratch = new ArrayBuffer(size)
    scratchU8 = new Uint8Array(scratch)
    scratchView = new DataView(scratch)
  }
}

class Packer {
  constructor() {
    this.offset = 0
  }
  u32(value) {
    ensure(this.offset + 4)
    scratchView.setUint32(this.offset, value, true)
    this.offset += 4
  }
  f64(value) {
    ensure(this.offset + 8)
    scratchView.setFloat64(this.offset, value, true)
    this.offset += 8
  }
  string(value) {
    if (value === null || value === undefined) {
      this.u32(NULL_SENTINEL)
      return
    }
    const utf8 = encoder.encode(typeof value === 'string' ? value : String(value))
    this.u32(utf8.length)
    ensure(this.offset + utf8.length)
    scratchU8.set(utf8, this.offset)
    this.offset += utf8.length
  }
  finish() {
    return { bytes: scratchU8, length: this.offset }
  }
}

function callBytes(symbol, packer) {
  const lib = nativeLib()
  if (!lib?.symbols?.[symbol]) return null
  try {
    const { bytes, length } = packer.finish()
    const result = readNativeResult(lib, lib.symbols[symbol](bytes, BigInt(length)))
    if (result.status !== NATIVE_STATUS_OK) return null
    return result.bytes
  } catch {
    return null
  }
}

function callUtf8(symbol, packer) {
  const bytes = callBytes(symbol, packer)
  return bytes === null ? null : decoder.decode(bytes)
}

/**
 * Native CoreText font-text → SVG. Returns the SVG string or null (use the
 * spawn path). darwin-only in the dylib; the JS caller's path-safety and
 * SFNT validation run BEFORE this.
 */
export function nativeFontTextSvg({ fontPath, text, pointSize }) {
  if (forced === 'js') return null
  if (typeof fontPath !== 'string' || typeof text !== 'string') return null
  const packer = new Packer()
  packer.u32(1)
  packer.string(fontPath)
  packer.string(text)
  packer.f64(Number(pointSize) || 0)
  return callUtf8('ad_render_font_text', packer)
}

/**
 * Native SF Symbol → vector PDF bytes (Uint8Array) or null (use the spawn
 * path). darwin-only (AppKit). D-0003-3: only engaged after the probe
 * confirms the in-process AppKit render is crash-free + byte-identical.
 */
export function nativeSymbolPdf({ name, scope, weight = 'regular', scale = 'medium' }) {
  if (forced === 'js') return null
  if (typeof name !== 'string' || typeof scope !== 'string') return null
  const packer = new Packer()
  packer.u32(1)
  packer.string(name)
  packer.string(scope)
  packer.string(weight)
  packer.string(scale)
  return callBytes('ad_render_symbol_pdf', packer)
}
