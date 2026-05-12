/**
 * Codepoint stamping orchestrator. Pulled out of `sync.js` to keep that
 * file inside the 400-line ceiling enforced by `scripts/check-file-size.js`.
 *
 * After `syncSfSymbols` has populated the catalog, walk every PUBLIC
 * symbol through the Swift codepoint-dump worker and stamp each
 * resolved Unicode codepoint back onto the row. Idempotent: re-running
 * against the same font writes the same value.
 *
 * Skips silently (no-op + warn) when SF Symbols.app isn't installed at
 * `/Applications/SF Symbols.app` — the worker depends on its bundled
 * SFSymbolsShared + CoreGlyphsLib frameworks (the latter exports
 * `Crypton.decryptObfuscatedFontTable`, the only known way to read the
 * encrypted catalog tables in SFSymbolsFallback.otf). On a non-mac
 * runtime that's hosting a prebuilt snapshot DB the column stays
 * populated from the snapshot itself.
 */

import { ensureSfSymbolsApp } from '../sf-symbols-app/install.js'
import { dumpSymbolCodepoints, resolveSymbolFontPath } from './codepoint-dump.js'

/**
 * @param {{ appPath?: string, fontPath?: string, metadataDir?: string,
 *   forceRefresh?: boolean }} opts
 * @param {{ db, dataDir, logger }} ctx
 * @returns {Promise<{ stamped: number, total: number, fontPath: string | null }>}
 */
export async function stampSfSymbolCodepoints(opts, ctx) {
  const { db, dataDir, logger } = ctx

  // Ensure a current SF Symbols.app is on disk before resolving paths.
  // Prefers /Applications when already current; downloads the latest
  // .dmg to <dataDir>/cache/sf-symbols/<version>/ otherwise. Caller can
  // pass `appPath`/`fontPath` to bypass the provisioner entirely
  // (used by tests and offline snapshot rebuilds).
  let appPath = opts?.appPath ?? null
  if (!appPath && !opts?.fontPath) {
    try {
      const installed = await ensureSfSymbolsApp({
        dataDir,
        logger,
        forceRefresh: opts?.forceRefresh,
      })
      appPath = installed.appPath
    } catch (err) {
      logger?.warn?.(
        `SF Symbols.app provisioning failed (${err?.message ?? err}); ` +
        `falling back to any local install`,
      )
    }
  }

  const resolved = opts?.fontPath
    ? {
        appPath: opts.appPath,
        fontPath: opts.fontPath,
        metadataDir: opts.metadataDir,
      }
    : resolveSymbolFontPath(dataDir, { appPath })
  if (!resolved || !resolved.fontPath) {
    logger?.warn?.(
      'SF Symbols.app not available; skipping SF Symbol codepoint stamping. ' +
      'Install from https://developer.apple.com/sf-symbols/ or retry with network access.',
    )
    return { stamped: 0, total: 0, fontPath: null }
  }
  const { fontPath, metadataDir, appPath: usedAppPath } = resolved
  const catalog = db.listSfSymbolsCatalog().filter(symbol => symbol.scope === 'public')
  if (catalog.length === 0) return { stamped: 0, total: 0, fontPath }

  const names = catalog.map(symbol => symbol.name)
  const { map } = await dumpSymbolCodepoints(names, {
    fontPath,
    metadataDir,
    appPath: usedAppPath,
    logger,
  })

  let stamped = 0
  for (const [name, codepoint] of map) {
    try {
      db.updateSfSymbolCodepoint('public', name, codepoint)
      if (codepoint != null) stamped++
    } catch (err) {
      logger?.warn?.(`failed to stamp codepoint for ${name}: ${err.message ?? err}`)
    }
  }
  const pct = catalog.length === 0 ? 0 : ((stamped / catalog.length) * 100).toFixed(1)
  logger?.info?.(
    `Stamped codepoints on ${stamped} of ${catalog.length} public symbols (${pct}% coverage)`,
  )
  return { stamped, total: catalog.length, fontPath }
}
