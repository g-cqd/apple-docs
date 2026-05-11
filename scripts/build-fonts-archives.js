#!/usr/bin/env bun
/**
 * Build the font archives shipped with each snapshot release:
 *   - `fonts-all-<tag>.7z`        — every extracted family in one archive.
 *   - `fonts-<family>-<tag>.7z`   — one archive per family.
 *
 * Source: `<dataDir>/resources/fonts/extracted/<family>/`. Family ids are
 * the canonical slugs from src/resources/apple-assets.js. We deliberately
 * hard-code the list here so we can build the archives even if the corpus
 * sqlite file is closed / unavailable.
 *
 * Each archive is paired with a `.sha256` sidecar.
 *
 * Args: --data-dir <path> --out <dir> --tag <name>
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../src/lib/logger.js'
import { createSevenZipArchive, writeSha256Sidecar } from '../src/lib/archive-7z.js'
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
 *   byFamily: Record<string, {name, path, sha256, size, fileCount}>,
 * }>}
 */
export async function buildFontsArchives({ dataDir, outDir, tag, logger }) {
  const extractedRoot = join(dataDir, 'resources', 'fonts', 'extracted')
  if (!existsSync(extractedRoot)) {
    logger?.warn?.(`[fonts-archive] ${extractedRoot} missing — skipping`)
    return { all: null, byFamily: {} }
  }
  ensureDir(outDir)

  /** @type {Record<string, any>} */
  const byFamily = {}
  for (const family of FONT_FAMILIES) {
    const familyDir = join(extractedRoot, family)
    if (!existsSync(familyDir)) {
      logger?.info?.(`[fonts-archive] no ${family} extracted; skipping`)
      continue
    }
    // Skip an empty family dir (would make 7zz fail).
    if (readdirSync(familyDir).length === 0) continue
    const name = `fonts-${family}-${tag}.7z`
    const outputPath = join(outDir, name)
    const built = await createSevenZipArchive({
      sourceDir: familyDir,
      outputPath,
      name,
      logger,
    })
    const { sha256 } = await writeSha256Sidecar(outputPath)
    byFamily[family] = { name, path: outputPath, sha256, size: built.size, fileCount: built.fileCount }
  }

  // Combined archive (`fonts-all-<tag>.7z`). Built from the same source tree
  // so member paths are `<family>/<file>`. If no families were present we
  // skip — buildSnapshot's status emitter will record `null`.
  let all = null
  const presentFamilies = readdirSync(extractedRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && readdirSync(join(extractedRoot, d.name)).length > 0)
  if (presentFamilies.length > 0) {
    const name = `fonts-all-${tag}.7z`
    const outputPath = join(outDir, name)
    const built = await createSevenZipArchive({
      sourceDir: extractedRoot,
      outputPath,
      name,
      logger,
    })
    const { sha256 } = await writeSha256Sidecar(outputPath)
    all = { name, path: outputPath, sha256, size: built.size, fileCount: built.fileCount }
  }

  return { all, byFamily }
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
