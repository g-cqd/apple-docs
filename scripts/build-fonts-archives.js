#!/usr/bin/env bun
/**
 * Build the combined fonts archive for the snapshot pipeline:
 *   - `fonts-all-<tag>.tar.gz`        — every extracted family in one archive.
 *
 * Source: `<dataDir>/resources/fonts/extracted/<family>/`. Family ids are
 * the canonical slugs from src/resources/apple-assets.js. We deliberately
 * hard-code the list here so we can build the archive even if the corpus
 * sqlite file is closed / unavailable.
 *
 * Per-family archives used to be built alongside but are no longer
 * shipped — they duplicated the full-snapshot payload at no consumer
 * benefit. A running instance that needs a single-family download can
 * subset on demand via /api/fonts/subset, or build a per-family archive
 * from `resources/fonts/extracted/<family>/` directly.
 *
 * The archive is paired with a `.sha256` sidecar.
 *
 * Args: --data-dir <path> --out <dir> --tag <name>
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../src/lib/logger.js'
import { writeSha256Sidecar } from '../src/lib/archive-7z.js'
import { createTarGzArchive } from '../src/lib/archive-targz.js'
import { ensureDir } from '../src/storage/files.js'

/** Mirror of `APPLE_FONT_FAMILIES` ids in src/resources/apple-assets.js. */
export const FONT_FAMILIES = Object.freeze([
  'sf-pro',
  'sf-compact',
  'sf-mono',
  'new-york',
  'sf-arabic',
  'sf-armenian',
  'sf-georgian',
  'sf-hebrew',
])

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
 * @param {object} args
 * @param {string} args.dataDir
 * @param {string} args.outDir
 * @param {string} args.tag
 * @param {{info?: Function, warn?: Function, error?: Function}} [args.logger]
 * @returns {Promise<{
 *   all: {name, path, sha256, size, fileCount} | null,
 *   byFamily: Record<string, never>,
 * }>}
 *   `byFamily` is intentionally always empty in the current pipeline;
 *   the field is kept for callsite + status.json compatibility.
 */
export async function buildFontsArchives({ dataDir, outDir, tag, logger }) {
  const extractedRoot = join(dataDir, 'resources', 'fonts', 'extracted')
  if (!existsSync(extractedRoot)) {
    logger?.warn?.(`[fonts-archive] ${extractedRoot} missing — skipping`)
    return { all: null, byFamily: {} }
  }
  ensureDir(outDir)

  // Combined archive (`fonts-all-<tag>.tar.gz`). Built from the extracted
  // root so member paths are `<family>/<file>`. Skip when no families
  // are present — buildSnapshot's status emitter will record `null`.
  let all = null
  const presentFamilies = readdirSync(extractedRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && readdirSync(join(extractedRoot, d.name)).length > 0)
  if (presentFamilies.length > 0) {
    const name = `fonts-all-${tag}.tar.gz`
    const outputPath = join(outDir, name)
    const built = await createTarGzArchive({
      sourceDir: extractedRoot,
      outputPath,
      name,
      logger,
    })
    const { sha256 } = await writeSha256Sidecar(outputPath)
    all = { name, path: outputPath, sha256, size: built.size, fileCount: built.fileCount }
  }

  return { all, byFamily: {} }
}

if (import.meta.main) {
  const args = parseArgs(process.argv)
  const dataDir = args['data-dir'] ?? process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
  const outDir = args.out ?? 'dist'
  const tag = args.tag ?? `snapshot-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
  if (!/^[a-z0-9._-]{1,64}$/i.test(tag)) {
    console.error(`build-fonts-archives: invalid --tag "${tag}"`)
    process.exit(2)
  }
  const logger = createLogger('info')
  const result = await buildFontsArchives({ dataDir, outDir, tag, logger })
  console.log(JSON.stringify(result, null, 2))
}
