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
/** @type {'js'|'native'|null} */
let forced = null // 'js' | 'native' | null
let announced = false
let logger

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Test seam. */
export function _forceImpl(/** @type {any} */ impl) {
  forced = impl
  announced = false
}

/** True when the dylib is loaded and the `render` token is on — the
 * prerender uses this to pick the batched in-process path over the worker
 * pool (per-chunk null still degrades to the pool). */
export function nativeRenderAvailable() {
  return nativeLib() !== null
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

function ensure(/** @type {any} */ byteLength) {
  if (scratch.byteLength < byteLength) {
    let size = scratch.byteLength * 2
    while (size < byteLength) size *= 2
    const next = new Uint8Array(size)
    next.set(scratchU8) // preserve the written prefix (batch requests grow past 8 KB)
    scratch = next.buffer
    scratchU8 = next
    scratchView = new DataView(scratch)
  }
}

class Packer {
  constructor() {
    this.offset = 0
  }
  u32(/** @type {any} */ value) {
    ensure(this.offset + 4)
    scratchView.setUint32(this.offset, value, true)
    this.offset += 4
  }
  f64(/** @type {any} */ value) {
    ensure(this.offset + 8)
    scratchView.setFloat64(this.offset, value, true)
    this.offset += 8
  }
  string(/** @type {any} */ value) {
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

function callBytes(/** @type {any} */ symbol, /** @type {any} */ packer) {
  const lib = /** @type {any} */ (nativeLib())
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

function callUtf8(/** @type {any} */ symbol, /** @type {any} */ packer) {
  const bytes = callBytes(symbol, packer)
  return bytes === null ? null : decoder.decode(bytes)
}

/** Decode count × [u32 len][bytes] (sentinel = null entry) into subarrays
 * of the (JS-owned) result copy. */
function decodeLenPrefixedBytes(/** @type {any} */ result, /** @type {any} */ count) {
  const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength)
  const out = new Array(count)
  let offset = 0
  for (let i = 0; i < count; i++) {
    const len = view.getUint32(offset, true)
    offset += 4
    if (len === NULL_SENTINEL) {
      out[i] = null
      continue
    }
    out[i] = result.bytes.subarray(offset, offset + len)
    offset += len
  }
  return out
}

function callBatch(/** @type {any} */ symbol, /** @type {any} */ packer, /** @type {any} */ count) {
  const lib = /** @type {any} */ (nativeLib())
  if (!lib?.symbols?.[symbol]) return null
  try {
    const { bytes, length } = packer.finish()
    const result = readNativeResult(lib, lib.symbols[symbol](bytes, BigInt(length)))
    if (result.status !== NATIVE_STATUS_OK) return null
    return decodeLenPrefixedBytes(result, count)
  } catch {
    return null
  }
}

/**
 * Native CoreText font-text → SVG. Returns the SVG string or null (use the
 * spawn path). darwin-only in the dylib; the JS caller's path-safety and
 * SFNT validation run BEFORE this.
 */
export function nativeFontTextSvg(/** @type {any} */ { fontPath, text, pointSize }) {
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
 * Native HarfBuzz-shaped font-text → SVG (RFC 0003 phase 4 — the Linux
 * path that replaces the hb-view host binary). Returns the SVG string or
 * null (HarfBuzz absent / font won't shape → use the hb-view spawn /
 * placeholder). Cross-platform; on darwin the engine chain prefers
 * CoreText, so this is exercised on Linux + by the parity gate.
 */
export function nativeFontTextShaped(/** @type {any} */ { fontPath, text, pointSize }) {
  if (forced === 'js') return null
  if (typeof fontPath !== 'string' || typeof text !== 'string') return null
  const packer = new Packer()
  packer.u32(1)
  packer.string(fontPath)
  packer.string(text)
  packer.f64(Number(pointSize) || 0)
  return callUtf8('ad_render_font_text_shaped', packer)
}

/**
 * Native SF Symbol → vector PDF bytes (Uint8Array) or null (use the spawn
 * path). darwin-only (AppKit). D-0003-3: only engaged after the probe
 * confirms the in-process AppKit render is crash-free + byte-identical.
 */
export function nativeSymbolPdf(/** @type {any} */ { name, scope, weight = 'regular', scale = 'medium' }) {
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

/**
 * Native SF Symbol → vector PDF, batched (RFC 0003 phase 2 — prerender
 * switch). `items` is [{name, scope, weight?, scale?}]. Returns an array
 * aligned to `items` of Uint8Array (PDF) | null (that one symbol didn't
 * render natively → spawn it to classify), or null for the whole batch
 * (native off / dylib absent / non-darwin / call failed → worker pool).
 * One FFI call fans out across cores inside the dylib.
 */
export function nativeSymbolPdfBatch(/** @type {any} */ items) {
  if (forced === 'js') return null
  if (!Array.isArray(items) || items.length === 0) return null
  const packer = new Packer()
  packer.u32(1)
  packer.u32(items.length)
  for (const it of items) {
    if (typeof it?.name !== 'string' || typeof it?.scope !== 'string') return null
    packer.string(it.name)
    packer.string(it.scope)
    packer.string(it.weight ?? 'regular')
    packer.string(it.scale ?? 'medium')
  }
  return callBatch('ad_render_symbol_pdf_batch', packer, items.length)
}

/**
 * Native SF Symbol → PNG bytes (Uint8Array) or null (use the spawn path).
 * darwin-only (AppKit NSBitmap). The request mirrors SYMBOL_PNG_SCRIPT's
 * argv exactly so the bytes match: color/background are nullable hex (null
 * → labelColor / no background). D-0003-3 Probe B gates the wiring.
 */
export function nativeSymbolPng(/** @type {any} */ { name, scope, pointSize, color, background, weight = 'regular', scale = 'medium' }) {
  if (forced === 'js') return null
  if (typeof name !== 'string' || typeof scope !== 'string') return null
  const packer = new Packer()
  packer.u32(1)
  packer.string(name)
  packer.string(scope)
  packer.f64(Number(pointSize) || 0)
  packer.string(color ?? null)
  packer.string(background ?? null)
  packer.string(weight)
  packer.string(scale)
  return callBytes('ad_render_symbol_png', packer)
}
