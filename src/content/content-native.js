/**
 * Content dispatch (RFC 0004 phases 1-2): native (libAppleDocsCore via
 * bun:ffi) when the `APPLE_DOCS_NATIVE` kill switch enables the `content`
 * module, JS (the normative reference) otherwise — and on ANY doubt:
 * loader failure, native error status, or packing trouble all fall back
 * to JS for that call. The native attempt lives INSIDE renderMarkdown /
 * renderPlainText / renderPage, so every caller is untouched.
 *
 * Byte layouts are shared verbatim with
 * swift/Sources/ADCore/ContentExports.swift: nullable strings are
 * [u32 len][utf8] with len 0xFFFFFFFF meaning null.
 */
import { createLogger } from '../lib/logger.js'
import { getNativeLib } from '../native/loader.js'
import { NATIVE_STATUS_OK, readNativeResult } from '../native/result.js'

const MODULE = 'content'
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

/**
 * Rollout stage: OPT-IN (RFC 0004 D-0004-6). Per-call payload dispatch
 * measured SLOWER than in-process JS for the query-time surfaces (the
 * data already lives in JS memory; the FFI tax exceeds the whole render),
 * so `content` engages only when the kill switch NAMES it — unlike the
 * default-on modules. The batched file-convert path is where native wins.
 */
function moduleEnabled() {
  const raw = (process.env.APPLE_DOCS_NATIVE ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'off' || raw === '' || raw === '1' || raw === 'on') return false
  return raw.split(',').some((entry) => entry.trim() === MODULE)
}

function nativeLib() {
  if (forced === 'js') return null
  if (forced !== 'native' && !moduleEnabled()) return null
  const lib = getNativeLib()
  if (!announced) {
    logger ??= createLogger(process.env.APPLE_DOCS_LOG_LEVEL || 'info')
    logger.info(`content: served by ${lib ? 'native libAppleDocsCore' : 'js (native unavailable)'}`)
    announced = true
  }
  return lib
}

// Grow-only scratch (fusion-native.js pattern): calls are synchronous and
// single-threaded; the native side consumes the bytes before returning.
let scratch = new ArrayBuffer(16384)
let scratchU8 = new Uint8Array(scratch)
let scratchView = new DataView(scratch)

function ensureScratch(byteLength) {
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
    this.parts = [] // [u8len, Uint8Array|null, f64|null, u32|null] descriptors
    this.total = 0
  }

  u32(value) {
    this.parts.push({ kind: 'u32', value })
    this.total += 4
  }

  f64(value) {
    this.parts.push({ kind: 'f64', value })
    this.total += 8
  }

  /** Nullable string: null/undefined → sentinel; anything else coerced. */
  string(value) {
    if (value === null || value === undefined) {
      this.parts.push({ kind: 'u32', value: NULL_SENTINEL })
      this.total += 4
      return
    }
    const utf8 = encoder.encode(typeof value === 'string' ? value : String(value))
    this.parts.push({ kind: 'u32', value: utf8.length })
    this.parts.push({ kind: 'bytes', value: utf8 })
    this.total += 4 + utf8.length
  }

  finish() {
    ensureScratch(this.total)
    let offset = 0
    for (const part of this.parts) {
      if (part.kind === 'u32') {
        scratchView.setUint32(offset, part.value, true)
        offset += 4
      } else if (part.kind === 'f64') {
        scratchView.setFloat64(offset, part.value, true)
        offset += 8
      } else {
        scratchU8.set(part.value, offset)
        offset += part.value.length
      }
    }
    return { bytes: scratchU8, length: this.total }
  }
}

function call(symbol, packer) {
  const lib = nativeLib()
  if (!lib) return null
  const fn = lib.symbols[symbol]
  if (!fn) return null
  try {
    const { bytes, length } = packer.finish()
    const result = readNativeResult(lib, fn(bytes, BigInt(length)))
    if (result.status !== NATIVE_STATUS_OK) return null
    return decoder.decode(result.bytes)
  } catch {
    return null
  }
}

/**
 * Native renderMarkdown(document, sections, opts) — null means "use JS".
 * Coercions mirror render-markdown.js coerceDocument/coerceSection.
 */
export function nativeDocMarkdown(document, sections, opts = {}) {
  if (forced === 'js') return null
  const platformsJson = document?.platformsJson ?? document?.platforms_json ?? null
  if (!isStringOrNullish(platformsJson)) return null // pre-parsed object — JS path
  const packer = new Packer()
  packer.u32(1)
  const includeFrontMatter = opts.includeFrontMatter !== false
  const includeTitle = opts.includeTitle !== false
  packer.u32((includeFrontMatter ? 1 : 0) | (includeTitle ? 2 : 0))
  packer.string(document?.key ?? document?.path ?? null)
  packer.string(document?.title ?? null)
  packer.string(document?.framework ?? null)
  packer.string(document?.frameworkDisplay ?? document?.framework_display ?? null)
  packer.string(document?.role ?? null)
  packer.string(document?.roleHeading ?? document?.role_heading ?? null)
  packer.string(platformsJson ?? null)
  const list = Array.isArray(sections) ? sections : []
  packer.u32(list.length)
  for (const section of list) {
    const contentJson = section?.contentJson ?? section?.content_json ?? null
    const sortOrder = section?.sortOrder ?? section?.sort_order
    if (!isStringOrNullish(contentJson)) return null
    if (sortOrder !== null && sortOrder !== undefined && typeof sortOrder !== 'number') return null
    packer.string(section?.sectionKind ?? section?.section_kind ?? null)
    packer.string(section?.heading ?? null)
    packer.string(section?.contentText ?? section?.content_text ?? '')
    packer.string(contentJson ?? null)
    packer.f64(sortOrder ?? 0)
  }
  return call('ad_content_doc_markdown', packer)
}

/** Native renderPlainText(document, sections) — null means "use JS". */
export function nativePlainText(document, sections) {
  if (forced === 'js') return null
  const packer = new Packer()
  packer.u32(1)
  packer.string(document?.title ?? null)
  packer.string(document?.abstractText ?? document?.abstract_text ?? null)
  packer.string(document?.declarationText ?? document?.declaration_text ?? null)
  packer.string(document?.headings ?? null)
  const list = Array.isArray(sections) ? sections : []
  packer.u32(list.length)
  for (const section of list) {
    const sortOrder = section?.sortOrder ?? section?.sort_order
    if (sortOrder !== null && sortOrder !== undefined && typeof sortOrder !== 'number') return null
    packer.string(section?.heading ?? null)
    packer.string(section?.contentText ?? section?.content_text ?? '')
    packer.f64(sortOrder ?? 0)
  }
  return call('ad_content_plaintext', packer)
}

/**
 * Native renderPage(json, canonicalPath) — null means "use JS". The caller
 * holds a parsed object; the value graph round-trips losslessly through
 * JSON.stringify (insertion order preserved, numbers re-parse identically).
 */
export function nativePageMarkdown(json, canonicalPath) {
  if (forced === 'js') return null
  if (!json || typeof json !== 'object') return null
  let raw
  try {
    raw = JSON.stringify(json)
  } catch {
    return null // circular or otherwise unstringifiable — JS path handles it
  }
  const packer = new Packer()
  packer.u32(1)
  packer.string(typeof canonicalPath === 'string' ? canonicalPath : '')
  packer.string(raw)
  return call('ad_content_page_markdown', packer)
}

/**
 * Batched file convert (RFC 0004 D-0004-6): entries are
 * `{ path, filePath }` (canonical doc path + absolute raw-json path);
 * Swift reads+parses+renders each file. Returns an array aligned with
 * `entries` where each slot is the markdown string or null (that page
 * failed natively — convert it in JS), or null entirely when native is
 * unavailable.
 */
export function nativeConvertPages(entries) {
  if (forced === 'js') return null
  if (!Array.isArray(entries) || entries.length === 0) return null
  const lib = nativeLib()
  if (!lib?.symbols?.ad_content_convert_pages) return null
  const packer = new Packer()
  packer.u32(1)
  packer.u32(entries.length)
  for (const entry of entries) {
    packer.string(typeof entry?.path === 'string' ? entry.path : null)
    packer.string(typeof entry?.filePath === 'string' ? entry.filePath : null)
  }
  try {
    const { bytes, length } = packer.finish()
    const result = readNativeResult(lib, lib.symbols.ad_content_convert_pages(bytes, BigInt(length)))
    if (result.status !== NATIVE_STATUS_OK) return null
    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength)
    const out = new Array(entries.length)
    let offset = 0
    for (let i = 0; i < entries.length; i++) {
      const len = view.getUint32(offset, true)
      offset += 4
      if (len === NULL_SENTINEL) {
        out[i] = null
        continue
      }
      out[i] = decoder.decode(result.bytes.subarray(offset, offset + len))
      offset += len
    }
    return out
  } catch {
    return null
  }
}

function isStringOrNullish(value) {
  // platformsJson / contentJson may arrive pre-parsed (objects) on some
  // call paths — those sit outside the codec; the caller falls back to JS.
  return value === null || value === undefined || typeof value === 'string'
}
