// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * libAppleDocsCore loader — the only place that dlopens the Swift dylib.
 *
 * Kill switch (`APPLE_DOCS_NATIVE`) defaults ON since RFC 0002 phase 5:
 * unset/'' means every migrated module serves natively WHERE the dylib and
 * its data artifacts exist, and JS serves identically otherwise (outputs
 * are bit-identical — see the embed equivalence gate). `off`/'0' is the
 * escape hatch: no module ever touches native code and this file never
 * dlopens anything. Resolution order is a strict allowlist (security.md
 * §1): the operator override, the install tree, then the dev build tree —
 * never DATA_DIR, never CWD, never library search paths. Any failure
 * memoizes null and the caller's JS implementation serves, with one
 * structured warning.
 */

import { dlopen, suffix } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { createLogger } from '../lib/logger.js'
import { NATIVE_STATUS_OK, nativeErrorMessage, readNativeResult } from './result.js'

const EXPECTED_ABI = 1

// One symbol table for the whole bridge: new modules add exports here and
// bump EXPECTED_ABI together with the Swift side on any layout change.
const SYMBOLS = {
  ad_abi_version: { args: [], returns: 'u32' },
  ad_build_info: { args: [], returns: 'ptr' },
  ad_echo: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_free: { args: ['ptr'], returns: 'void' },
  ad_fusion_rrf: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_fusion_hybrid: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_fusion_mmr: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_archive_tar_zst: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_embed_init: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_embed_batch: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_embed_batch_codes: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_embed_reset: { args: [], returns: 'void' },
  ad_content_doc_markdown: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_content_plaintext: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_content_page_markdown: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_content_convert_pages: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_content_doc_markdown_batch: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_content_plaintext_batch: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_render_font_text: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_render_font_text_shaped: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_render_symbol_pdf: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_render_symbol_pdf_batch: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_render_symbol_png: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_storage_open: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_storage_close: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_storage_search_pages: { args: ['buffer', 'i64'], returns: 'ptr' },
}

const ROOT = new URL('../../', import.meta.url).pathname
let libCache // undefined = unresolved; null = unavailable; object = loaded
let logger

function log() {
  logger ??= createLogger(process.env.APPLE_DOCS_LOG_LEVEL || 'info')
  return logger
}

function candidatePaths() {
  // An explicit operator override is authoritative: when set, it is the ONLY
  // candidate, so a typo'd path fails loudly to JS instead of silently
  // loading some other build.
  if (process.env.APPLE_DOCS_NATIVE_LIB) return [process.env.APPLE_DOCS_NATIVE_LIB]
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  const fileName = `libAppleDocsCore.${suffix}`
  return [`${ROOT}dist/native/${process.platform}-${arch}/${fileName}`, `${ROOT}swift/.build/release/${fileName}`]
}

/**
 * Per-module kill switch — native-by-default (RFC 0002 phase 5).
 * `APPLE_DOCS_NATIVE`: unset/''/'1'/'on' → true for every migrated module;
 * '0'/'off' → false for everything; otherwise a comma-separated module
 * list ('fusion,archive,embed') enables exactly those.
 *
 * @param {string} module
 */
export function isNativeEnabled(module) {
  const raw = (process.env.APPLE_DOCS_NATIVE ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'off') return false
  if (raw === '' || raw === '1' || raw === 'on') return true
  return raw.split(',').some((entry) => entry.trim() === module)
}

/**
 * Memoized dlopen + ABI handshake. Returns the bound library or null
 * (never throws). Callers must already have passed `isNativeEnabled`.
 */
export function getNativeLib() {
  if (libCache !== undefined) return libCache
  const reasons = []
  for (const path of candidatePaths()) {
    if (!existsSync(path)) {
      reasons.push(`${path}: not found`)
      continue
    }
    try {
      const lib = dlopen(path, SYMBOLS)
      const abi = lib.symbols.ad_abi_version()
      if (abi !== EXPECTED_ABI) {
        // A wrong-ABI library is a build-drift signal, not a reason to try a
        // stale fallback candidate — stop and let JS serve.
        reasons.push(`${path}: ABI ${abi}, expected ${EXPECTED_ABI}`)
        break
      }
      const info = readNativeResult(lib, lib.symbols.ad_build_info())
      log().debug(`native: loaded ${path}${info.status === NATIVE_STATUS_OK ? ` ${nativeErrorMessage(info)}` : ''}`)
      libCache = lib
      return libCache
    } catch (error) {
      reasons.push(`${path}: ${error.message}`)
      break
    }
  }
  log().warn(`native: no usable libAppleDocsCore (${reasons.join('; ')}) — JS implementations serve`)
  libCache = null
  return libCache
}

/** Test seam: drop the memoized handle so env changes take effect. */
export function _resetNativeLoader() {
  libCache = undefined
}
