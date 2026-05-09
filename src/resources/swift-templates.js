/**
 * Inline Swift programs spawned by the SF Symbols and font-render paths.
 * Each script body lives in its own file under `swift/` so the file-size
 * gate stays happy and the bodies can be diffed independently.
 *
 * SYMBOL_WORKER_SCRIPT — long-running per-scope worker that reads symbol
 *   names on stdin and emits length-prefixed PDF frames on stdout. One
 *   worker per scope, pooled by spawnSymbolWorker.
 *
 * SYMBOL_PDF_SCRIPT — one-shot variant of the above. Used by the runtime
 *   render handler when no snapshot SVG is available.
 *
 * SYMBOL_PNG_SCRIPT — AppKit-based PNG fallback. Used when the format is
 *   png and SVG rasterization (rsvg-convert / sips) failed.
 *
 * FONT_TEXT_SCRIPT — CoreText layout + glyph-path walker. Renders the
 *   user's text string in the requested font as a theme-neutral SVG with
 *   absolute glyph coordinates.
 */

export { SYMBOL_WORKER_SCRIPT } from './swift/symbol-worker.js'
export { SYMBOL_PDF_SCRIPT } from './swift/symbol-pdf.js'
export { SYMBOL_PNG_SCRIPT } from './swift/symbol-png.js'
export { FONT_TEXT_SCRIPT } from './swift/font-text.js'
