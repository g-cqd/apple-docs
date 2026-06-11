/**
 * libAppleDocsCore loader — the only place that dlopens the Swift dylib.
 *
 * Kill switch (`APPLE_DOCS_NATIVE`) defaults off: unset/'0'/'off' means no
 * module ever touches native code and this file never dlopens anything.
 * Resolution order is a strict allowlist (security.md §1): the operator
 * override, the install tree, then the dev build tree — never DATA_DIR,
 * never CWD, never library search paths. Any failure memoizes null and the
 * caller's JS implementation serves, with one structured warning.
 */
import { existsSync } from 'node:fs'
import { dlopen, suffix } from 'bun:ffi'
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
  return [
    `${ROOT}dist/native/${process.platform}-${arch}/${fileName}`,
    `${ROOT}swift/.build/release/${fileName}`,
  ]
}

/**
 * Per-module kill switch. `APPLE_DOCS_NATIVE`: ''/'0'/'off' → false for
 * everything; '1'/'on' → true for every migrated module; otherwise a
 * comma-separated module list ('fusion').
 *
 * @param {string} module
 */
export function isNativeEnabled(module) {
  const raw = (process.env.APPLE_DOCS_NATIVE ?? '').trim().toLowerCase()
  if (raw === '' || raw === '0' || raw === 'off') return false
  if (raw === '1' || raw === 'on') return true
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
      log().debug(
        `native: loaded ${path}${info.status === NATIVE_STATUS_OK ? ` ${nativeErrorMessage(info)}` : ''}`,
      )
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
