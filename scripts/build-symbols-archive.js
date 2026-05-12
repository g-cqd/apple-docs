#!/usr/bin/env bun
/**
 * Build the combined SF Symbols pre-render archive: `symbols-<tag>.tar.gz`.
 *
 * Source: `<dataDir>/resources/symbols/`. Contains `public/` and `private/`
 * subdirectories preserving the existing weight-scale layout from the
 * symbol-bake step in `apple-docs sync`.
 *
 * Output: a single deterministic .tar.gz file plus a `.sha256` sidecar.
 *
 * Driven by `scripts/build-snapshot.js` as part of the snapshot pipeline,
 * but invocable standalone for ad-hoc rebuilds.
 *
 * Args: --data-dir <path> --out <dir> --tag <name>
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../src/lib/logger.js'
import { writeSha256Sidecar } from '../src/lib/archive-7z.js'
import { createTarGzArchive } from '../src/lib/archive-targz.js'
import { ensureDir } from '../src/storage/files.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

/**
 * Programmatic API — used by `build-snapshot.js`.
 *
 * @param {object} args
 * @param {string} args.dataDir
 * @param {string} args.outDir
 * @param {string} args.tag
 * @param {{info?: Function, warn?: Function, error?: Function}} [args.logger]
 * @returns {Promise<{name: string, path: string, sha256: string, size: number} | null>}
 *   Returns null if there are no symbols on disk to archive.
 */
export async function buildSymbolsArchive({ dataDir, outDir, tag, logger }) {
  const symbolsDir = join(dataDir, 'resources', 'symbols')
  if (!existsSync(symbolsDir)) {
    logger?.warn?.(`[symbols-archive] ${symbolsDir} missing — skipping`)
    return null
  }
  ensureDir(outDir)

  const name = `symbols-${tag}.tar.gz`
  const outputPath = join(outDir, name)
  const built = await createTarGzArchive({
    sourceDir: symbolsDir,
    outputPath,
    name,
    logger,
  })
  const { sha256 } = await writeSha256Sidecar(outputPath)
  return { name, path: outputPath, sha256, size: built.size, fileCount: built.fileCount }
}

// CLI entry — only fires when invoked directly, not when imported.
if (import.meta.main) {
  const args = parseArgs(process.argv)
  const dataDir = args['data-dir'] ?? process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
  const outDir = args.out ?? 'dist'
  const tag = args.tag ?? `snapshot-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
  if (!/^[a-z0-9._-]{1,64}$/i.test(tag)) {
    console.error(`build-symbols-archive: invalid --tag "${tag}"`)
    process.exit(2)
  }
  const logger = createLogger('info')
  const result = await buildSymbolsArchive({ dataDir, outDir, tag, logger })
  if (!result) {
    console.error('No symbols directory found; nothing built.')
    process.exit(1)
  }
  console.log(JSON.stringify(result, null, 2))
}
