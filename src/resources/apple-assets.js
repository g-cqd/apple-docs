/**
 * Apple-asset facade. The font / symbol pipelines live in per-concern
 * modules under apple-fonts/ and apple-symbols/; this module is the
 * public entry point — it owns syncAppleFonts (the orchestrator) plus
 * the small list/search readers, and re-exports everything else.
 */

import { extname, join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { sha256 } from '../lib/hash.js'
import { ensureDir } from '../storage/files.js'
import {
  inspectSfntFile,
  parseFontFilename,
} from './apple-fonts/sfnt.js'
import { renderFontText } from './apple-fonts/render.js'
import {
  discoverAppleFontFiles,
  downloadFileIfNeeded,
  extractDmgFonts,
  hashFile,
} from './apple-fonts/sync.js'
import {
  getPrerenderedSymbolPath,
  normalizeSymbolScale,
  normalizeSymbolWeight,
  SYMBOL_SCALES,
  SYMBOL_WEIGHTS,
  symbolVariantMatrix,
} from './apple-symbols/cache-key.js'
import { customizePrerenderedSymbolSvg } from './apple-symbols/svg-helpers.js'
import { renderSfSymbol, SYMBOL_RENDERER_VERSION } from './apple-symbols/render.js'
import {
  prerenderSfSymbols,
  stampSfSymbolCodepoints,
  symbolSnapshotNeedsReset,
  syncSfSymbols,
} from './apple-symbols/sync.js'

export { inspectSfntFile, parseFontFilename }
export { SYMBOL_WEIGHTS, SYMBOL_SCALES, getPrerenderedSymbolPath }
export { renderFontText }
export { renderSfSymbol }
export { syncSfSymbols, prerenderSfSymbols, stampSfSymbolCodepoints }

const APPLE_FONT_FAMILIES = [
  { id: 'sf-pro', displayName: 'SF Pro', category: 'sans-serif', sourceUrl: 'https://devimages-cdn.apple.com/design/resources/download/SF-Pro.dmg', match: /^SF-Pro(?:-|\.|$)|^SFNS/i },
  { id: 'sf-compact', displayName: 'SF Compact', category: 'sans-serif', sourceUrl: 'https://devimages-cdn.apple.com/design/resources/download/SF-Compact.dmg', match: /^SF-Compact(?:-|\.|$)|^SFCompact/i },
  { id: 'sf-mono', displayName: 'SF Mono', category: 'monospace', sourceUrl: 'https://devimages-cdn.apple.com/design/resources/download/SF-Mono.dmg', match: /^SF-Mono(?:-|\.|$)|^SFNSMono/i },
  { id: 'new-york', displayName: 'New York', category: 'serif', sourceUrl: 'https://devimages-cdn.apple.com/design/resources/download/NY.dmg', match: /^NewYork/i },
  { id: 'sf-arabic', displayName: 'SF Arabic', category: 'sans-serif', sourceUrl: 'https://devimages-cdn.apple.com/design/resources/download/SF-Arabic.dmg', match: /^SF-Arabic(?:-|\.|$)|^SFArabic/i },
  { id: 'sf-armenian', displayName: 'SF Armenian', category: 'sans-serif', sourceUrl: 'https://devimages-cdn.apple.com/design/resources/download/SF-Armenian.dmg', match: /^SF-Armenian(?:-|\.|$)|^SFArmenian/i },
  { id: 'sf-georgian', displayName: 'SF Georgian', category: 'sans-serif', sourceUrl: 'https://devimages-cdn.apple.com/design/resources/download/SF-Georgian.dmg', match: /^SF-Georgian(?:-|\.|$)|^SFGeorgian/i },
  { id: 'sf-hebrew', displayName: 'SF Hebrew', category: 'sans-serif', sourceUrl: 'https://devimages-cdn.apple.com/design/resources/download/SF-Hebrew.dmg', match: /^SF-Hebrew(?:-|\.|$)|^SFHebrew/i },
]

const DEFAULT_FONT_DIRS = [
  '/Library/Fonts',
  '/System/Library/Fonts',
  join(homedir(), 'Library', 'Fonts'),
]

const FONT_FILE_RE = /\.(ttf|otf|ttc|dfont)$/i

export async function syncAppleFonts(opts, ctx) {
  const { db, dataDir, logger } = ctx
  const resourcesDir = join(dataDir, 'resources', 'fonts')
  const originalsDir = join(resourcesDir, 'original')
  const extractedDir = join(resourcesDir, 'extracted')
  ensureDir(originalsDir)
  ensureDir(extractedDir)

  const result = { families: APPLE_FONT_FAMILIES.length, files: 0, variable: 0, system: 0, remote: 0, downloaded: 0, extracted: 0 }
  for (const family of APPLE_FONT_FAMILIES) {
    db.upsertAppleFontFamily({
      id: family.id,
      displayName: family.displayName,
      category: family.category,
      sourceUrl: family.sourceUrl,
      extractedPath: join(extractedDir, family.id),
      status: 'available',
    })
  }

  if (opts.downloadFonts) {
    for (const family of APPLE_FONT_FAMILIES) {
      try {
        const dmgPath = join(originalsDir, `${family.id}.dmg`)
        const downloaded = await downloadFileIfNeeded(family.sourceUrl, dmgPath)
        if (downloaded) result.downloaded++
        const hash = await hashFile(dmgPath)
        const size = statSync(dmgPath).size
        const familyDir = join(extractedDir, family.id)
        const extracted = await extractDmgFonts(dmgPath, familyDir, logger)
        result.extracted += extracted.length
        db.upsertAppleFontFamily({
          id: family.id,
          displayName: family.displayName,
          category: family.category,
          sourceUrl: family.sourceUrl,
          sourceSha256: hash,
          sourceSize: size,
          sourcePath: dmgPath,
          extractedPath: familyDir,
          status: 'downloaded',
        })
      } catch (error) {
        logger?.warn?.(`Apple font download/extract failed for ${family.displayName}: ${error.message}`)
      }
    }
  }

  // Two passes so the source classification is deterministic: 'remote'
  // (extracted from an Apple DMG into our data dir) wins over 'system' if
  // the same file_name is found in both. The DB unique constraint on
  // (family_id, file_name) means a later upsert with source='system'
  // overwrites the row — so we run remote first and skip system entries
  // whose names already landed.
  const indexFile = (file, source) => {
    const family = APPLE_FONT_FAMILIES.find(f => f.match.test(file.fileName))
    if (!family) return false
    const { variant, weight, italic } = parseFontFilename(file.fileName)
    const { isVariable, axes } = inspectSfntFile(file.filePath)
    const size = statSync(file.filePath).size
    const id = sha256(`${family.id}:${file.fileName}`).slice(0, 24)
    db.upsertAppleFontFile({
      id,
      familyId: family.id,
      fileName: file.fileName,
      filePath: file.filePath,
      styleName: italic ? `${weight ?? 'Regular'} Italic` : weight,
      weight,
      variant,
      italic,
      format: extname(file.fileName).slice(1).toLowerCase(),
      source,
      isVariable,
      axes,
      size,
    })
    if (isVariable) result.variable++
    if (source === 'remote') result.remote++
    if (source === 'system') result.system++
    result.files++
    return true
  }

  const remoteFiles = discoverAppleFontFiles([extractedDir])
  const remoteNames = new Set()
  for (const file of remoteFiles) {
    if (indexFile(file, 'remote')) remoteNames.add(`${matchFamilyId(file.fileName)}:${file.fileName}`)
  }
  const systemFiles = discoverAppleFontFiles(DEFAULT_FONT_DIRS)
  for (const file of systemFiles) {
    if (remoteNames.has(`${matchFamilyId(file.fileName)}:${file.fileName}`)) continue
    indexFile(file, 'system')
  }

  return result
}

function matchFamilyId(fileName) {
  const family = APPLE_FONT_FAMILIES.find(f => f.match.test(fileName))
  return family?.id ?? ''
}

/**
 * Determinism guard for the snapshot build: re-extract any font family whose
 * extracted/ dir is missing or empty, from the cached original/<id>.dmg. The
 * snapshot is built twice and the two .tar archives are sha-diffed; a family that
 * silently failed to extract on only one pass (flaky SLA/multi-volume DMG
 * mount) made the archive non-deterministic. Idempotent: skips families that
 * already have at least one font file. No-op when downloadFonts never ran
 * (no cached DMG) — that family stays absent on both passes, still
 * deterministic.
 */
export async function ensureFontsExtracted(dataDir, logger) {
  const extractedDir = join(dataDir, 'resources', 'fonts', 'extracted')
  const originalsDir = join(dataDir, 'resources', 'fonts', 'original')
  const repaired = []
  let extracted = 0
  for (const family of APPLE_FONT_FAMILIES) {
    const familyDir = join(extractedDir, family.id)
    if (existsSync(familyDir) && readdirSync(familyDir).some(f => FONT_FILE_RE.test(f))) continue
    const dmgPath = join(originalsDir, `${family.id}.dmg`)
    if (!existsSync(dmgPath)) {
      logger?.warn?.(`Apple font family ${family.displayName} has no extracted fonts and no cached DMG; skipping`)
      continue
    }
    try {
      extracted += (await extractDmgFonts(dmgPath, familyDir, logger)).length
      repaired.push(family.id)
    } catch (error) {
      logger?.warn?.(`Apple font re-extract failed for ${family.displayName}: ${error.message}`)
    }
  }
  return { extracted, families: repaired }
}

export function listAppleFonts(ctx) {
  return { families: ctx.db.listAppleFonts() }
}

export function searchSfSymbols(query, opts, ctx) {
  return { results: ctx.db.searchSfSymbols(query, opts), query: query ?? '', scope: opts.scope ?? null }
}

export const _test = {
  customizePrerenderedSymbolSvg,
  normalizeSymbolScale,
  normalizeSymbolWeight,
  symbolRendererVersion: SYMBOL_RENDERER_VERSION,
  symbolSnapshotNeedsReset,
  symbolVariantMatrix,
}
