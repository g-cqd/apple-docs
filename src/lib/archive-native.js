/**
 * Archive dispatch: Swift ADArchive (libAppleDocsCore, streaming tar.zst —
 * no intermediate .tar, no tar/zstd host binaries) when `APPLE_DOCS_NATIVE`
 * enables the `archive` module; the JS implementation (./archive-zstd.js,
 * normative) otherwise and on any doubt. File selection always comes from
 * the same `listFilesSorted`, so both paths archive the identical member
 * set in identical order.
 *
 * The native call BLOCKS the JS thread for the whole build (minutes for the
 * full corpus) and has no deadline — acceptable because every caller is CLI
 * snapshot tooling; never call this from a server path.
 */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { createLogger } from '../lib/logger.js'
import { getNativeLib, isNativeEnabled } from '../native/loader.js'
import { nativeErrorMessage, readNativeResult } from '../native/result.js'
import { ValidationError } from './errors.js'
import { listFilesSorted } from './archive-7z.js'
import { createTarZstArchive as jsCreateTarZstArchive } from './archive-zstd.js'

export { countTarMembers } from './archive-zstd.js'

const MODULE = 'archive'
const CODEC_VERSION = 1
const LEVEL = 9
const WORKERS = 3

let forced = null // 'js' | 'native' | null
let announced = false

/** Test seam. */
export function _forceImpl(impl) {
  forced = impl
  announced = false
}

function nativeLib(logger) {
  if (forced === 'js') return null
  if (forced !== 'native' && !isNativeEnabled(MODULE)) return null
  const lib = getNativeLib()
  if (!announced) {
    const log = logger ?? createLogger(process.env.APPLE_DOCS_LOG_LEVEL || 'info')
    log.debug?.(`archive: served by ${lib ? 'native libAppleDocsCore' : 'js (native unavailable)'}`)
    announced = true
  }
  return lib
}

function packRequest(sourceDir, outputPath, files) {
  const encoder = new TextEncoder()
  const sourceBytes = encoder.encode(sourceDir)
  const outputBytes = encoder.encode(outputPath)
  const fileBytes = files.map((file) => encoder.encode(file))
  let total = 16 + 4 + sourceBytes.length + 4 + outputBytes.length
  for (const bytes of fileBytes) total += 4 + bytes.length
  const request = new Uint8Array(total)
  const view = new DataView(request.buffer)
  view.setUint32(0, CODEC_VERSION, true)
  view.setUint32(4, LEVEL, true)
  view.setUint32(8, WORKERS, true)
  view.setUint32(12, files.length, true)
  let offset = 16
  for (const bytes of [sourceBytes, outputBytes, ...fileBytes]) {
    view.setUint32(offset, bytes.length, true)
    request.set(bytes, offset + 4)
    offset += 4 + bytes.length
  }
  return request
}

/**
 * Same contract as archive-zstd.js createTarZstArchive.
 *
 * @param {{ sourceDir: string, outputPath: string, name?: string,
 *           logger?: {info?:Function,warn?:Function,error?:Function,debug?:Function}, deadlineMs?: number }} args
 * @returns {Promise<{outputPath: string, fileCount: number, size: number}>}
 */
export async function createTarZstArchive(args) {
  const { sourceDir, outputPath, name, logger } = args
  const lib = nativeLib(logger)
  if (!lib) return jsCreateTarZstArchive(args)

  const files = listFilesSorted(sourceDir)
  if (files.length === 0) throw new ValidationError(`createTarZstArchive: no files under ${sourceDir}`)
  const absOutput = isAbsolute(outputPath) ? outputPath : resolve(outputPath)
  if (!existsSync(dirname(absOutput))) mkdirSync(dirname(absOutput), { recursive: true })

  const log = logger ?? { info() {}, warn() {}, error() {} }
  log.info?.(`[archive-tar.zst] native: ${name ?? absOutput} (${files.length} files)`)
  const request = packRequest(sourceDir, absOutput, files)
  const result = readNativeResult(lib, lib.symbols.ad_archive_tar_zst(request, request.length))
  if (result.status !== 0) {
    log.warn?.(
      `[archive-tar.zst] native build failed (status ${result.status}: ${nativeErrorMessage(result)}) — js fallback`,
    )
    if (existsSync(absOutput)) {
      try {
        unlinkSync(absOutput)
      } catch {
        /* tolerate */
      }
    }
    return jsCreateTarZstArchive(args)
  }
  const done = JSON.parse(new TextDecoder().decode(result.bytes))
  if (done.fileCount !== files.length) {
    // Mirrors the JS member-count integrity gate: a drift here means the
    // tree mutated mid-build.
    throw new ValidationError(
      `tar.zst integrity check failed for ${name ?? absOutput}: native packed ${done.fileCount} members but ${files.length} were staged`,
    )
  }
  log.info?.(
    `[archive-tar.zst] wrote ${absOutput} (${(done.size / 1e6).toFixed(1)} MB, ${done.fileCount} members, native zstd ${done.zstdVersion})`,
  )
  return { outputPath: absOutput, fileCount: done.fileCount, size: done.size }
}
