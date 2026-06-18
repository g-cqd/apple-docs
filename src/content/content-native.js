// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
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
 * Rollout stage: DEFAULT-ON since the §6b perf round (RFC 0004) — every
 * production-engaged surface measures ≥ JS: per-call doc-markdown 1.3×,
 * batched doc-markdown 2.9×, batched plaintext 1.07×, parallel
 * file-convert 2.97×. The per-call page/plaintext shapes still lose to
 * in-process JS (data already in JS memory), so those two dispatch ONLY
 * under the test seam — their production callers use the batches.
 */
function moduleEnabled() {
  const raw = (process.env.APPLE_DOCS_NATIVE ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'off') return false
  if (raw === '' || raw === '1' || raw === 'on') return true
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
// The packer writes DIRECTLY into the scratch with encodeInto (no
// per-field descriptor objects or intermediate Uint8Arrays — RFC 0004
// §6b); growth copies the already-written prefix.
let scratch = new ArrayBuffer(65536)
let scratchU8 = new Uint8Array(scratch)
let scratchView = new DataView(scratch)

function growScratch(minimum) {
  let size = scratch.byteLength * 2
  while (size < minimum) size *= 2
  const next = new ArrayBuffer(size)
  const nextU8 = new Uint8Array(next)
  nextU8.set(scratchU8) // preserve the written prefix
  scratch = next
  scratchU8 = nextU8
  scratchView = new DataView(scratch)
}

class Packer {
  constructor() {
    this.offset = 0
  }

  ensure(extra) {
    if (this.offset + extra > scratch.byteLength) growScratch(this.offset + extra)
  }

  u32(value) {
    this.ensure(4)
    scratchView.setUint32(this.offset, value, true)
    this.offset += 4
  }

  f64(value) {
    this.ensure(8)
    scratchView.setFloat64(this.offset, value, true)
    this.offset += 8
  }

  /** Nullable string: null/undefined → sentinel; anything else coerced. */
  string(value) {
    if (value === null || value === undefined) {
      this.u32(NULL_SENTINEL)
      return
    }
    const text = typeof value === 'string' ? value : String(value)
    // utf8 length ≤ 3× UTF-16 length; reserve worst case + the length word.
    this.ensure(4 + text.length * 3)
    const { written } = encoder.encodeInto(text, scratchU8.subarray(this.offset + 4))
    scratchView.setUint32(this.offset, written, true)
    this.offset += 4 + written
  }

  finish() {
    return { bytes: scratchU8, length: this.offset }
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
function packDocBody(packer, document, sections) {
  const platformsJson = document?.platformsJson ?? document?.platforms_json ?? null
  if (!isStringOrNullish(platformsJson)) return false // pre-parsed object — JS path
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
    const contentText = section?.contentText ?? section?.content_text ?? ''
    const sortOrder = section?.sortOrder ?? section?.sort_order
    if (!isStringOrNullish(contentJson) || typeof contentText !== 'string') return false
    if (sortOrder !== null && sortOrder !== undefined && typeof sortOrder !== 'number') return false
    packer.string(section?.sectionKind ?? section?.section_kind ?? null)
    packer.string(section?.heading ?? null)
    packer.string(contentText)
    packer.string(contentJson ?? null)
    packer.f64(sortOrder ?? 0)
  }
  return true
}

function packPlainBody(packer, document, sections) {
  packer.string(document?.title ?? null)
  packer.string(document?.abstractText ?? document?.abstract_text ?? null)
  packer.string(document?.declarationText ?? document?.declaration_text ?? null)
  packer.string(document?.headings ?? null)
  const list = Array.isArray(sections) ? sections : []
  packer.u32(list.length)
  for (const section of list) {
    const contentText = section?.contentText ?? section?.content_text ?? ''
    const sortOrder = section?.sortOrder ?? section?.sort_order
    if (typeof contentText !== 'string') return false
    if (sortOrder !== null && sortOrder !== undefined && typeof sortOrder !== 'number') return false
    packer.string(section?.heading ?? null)
    packer.string(contentText)
    packer.f64(sortOrder ?? 0)
  }
  return true
}

function docFlags(opts) {
  const includeFrontMatter = opts.includeFrontMatter !== false
  const includeTitle = opts.includeTitle !== false
  return (includeFrontMatter ? 1 : 0) | (includeTitle ? 2 : 0)
}

export function nativeDocMarkdown(document, sections, opts = {}) {
  if (forced === 'js') return null
  const packer = new Packer()
  packer.u32(1)
  packer.u32(docFlags(opts))
  if (!packDocBody(packer, document, sections)) return null
  return call('ad_content_doc_markdown', packer)
}

/**
 * Native renderPlainText(document, sections) — TEST SEAM ONLY (the
 * per-call shape loses to in-process JS at 0.48×; index-body's batch is
 * the production path). null means "use JS".
 */
export function nativePlainText(document, sections) {
  if (forced !== 'native') return null
  const packer = new Packer()
  packer.u32(1)
  if (!packPlainBody(packer, document, sections)) return null
  return call('ad_content_plaintext', packer)
}

/** Decode count × [u32 len][utf8] (sentinel = null entry). */
function decodeLenPrefixed(result, count) {
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
    out[i] = decoder.decode(result.bytes.subarray(offset, offset + len))
    offset += len
  }
  return out
}

function callBatch(symbol, packer, count) {
  const lib = nativeLib()
  if (!lib?.symbols?.[symbol]) return null
  try {
    const { bytes, length } = packer.finish()
    const result = readNativeResult(lib, lib.symbols[symbol](bytes, BigInt(length)))
    if (result.status !== NATIVE_STATUS_OK) return null
    return decodeLenPrefixed(result, count)
  } catch {
    return null
  }
}

/**
 * Batched renderMarkdown over `[{ document, sections }]` — Swift renders
 * the batch in parallel. Returns aligned strings (null = render that doc
 * in JS), or null entirely when native is unavailable / inputs sit
 * outside the codec.
 */
export function nativeDocMarkdownBatch(docs, opts = {}) {
  if (forced === 'js') return null
  if (!Array.isArray(docs) || docs.length === 0) return null
  const packer = new Packer()
  packer.u32(1)
  packer.u32(docFlags(opts))
  packer.u32(docs.length)
  for (const { document, sections } of docs) {
    if (!packDocBody(packer, document, sections)) return null
  }
  return callBatch('ad_content_doc_markdown_batch', packer, docs.length)
}

/** Batched renderPlainText over `[{ document, sections }]`. */
export function nativePlainTextBatch(docs) {
  if (forced === 'js') return null
  if (!Array.isArray(docs) || docs.length === 0) return null
  const packer = new Packer()
  packer.u32(1)
  packer.u32(docs.length)
  for (const { document, sections } of docs) {
    if (!packPlainBody(packer, document, sections)) return null
  }
  return callBatch('ad_content_plaintext_batch', packer, docs.length)
}

/**
 * Native renderPage(json, canonicalPath) — TEST SEAM ONLY (the caller
 * holds a parsed object, so this shape pays stringify+reparse and loses
 * at 0.14×; convertAll's parallel file batch is the production path).
 * The value graph round-trips losslessly through JSON.stringify
 * (insertion order preserved, numbers re-parse identically).
 */
export function nativePageMarkdown(json, canonicalPath) {
  if (forced !== 'native') return null
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
    return decodeLenPrefixed(result, entries.length)
  } catch {
    return null
  }
}

function isStringOrNullish(value) {
  // platformsJson / contentJson may arrive pre-parsed (objects) on some
  // call paths — those sit outside the codec; the caller falls back to JS.
  return value === null || value === undefined || typeof value === 'string'
}
