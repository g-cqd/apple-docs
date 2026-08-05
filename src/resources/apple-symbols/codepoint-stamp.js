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
 *   forceRefresh?: boolean, spawn?: Function }} opts
 * @param {{ db, dataDir, logger }} ctx
 * @returns {Promise<{ stamped: number, total: number, requested?: number,
 *   missing?: number, fontPath: string | null, skipped?: boolean }>}
 */
export async function stampSfSymbolCodepoints(opts, ctx) {
  const { db, dataDir, logger } = ctx

  // Steady-state gate. Without it every sync paid the SF Symbols
  // landing-page scrape plus a Swift font dump to rewrite values that were
  // already there. Two row classes count as "settled":
  //   - codepoint stamped, or
  //   - codepoint NULL but already attempted against some app version
  //     (`codepoint_attempted_version`). The catalog (the running macOS's
  //     CoreGlyphs) and the released SF Symbols.app version-skew in either
  //     direction, so some names are simply not resolvable by the app at
  //     hand — retrying against the SAME app version is futile. They
  //     re-attempt when the provisioned app version changes, on `--full`
  //     (forceRefresh), or whenever a dump runs anyway for new symbols.
  // New symbols arrive from the catalog sync with NULL + unattempted,
  // which reopens the gate.
  if (!opts?.forceRefresh && !opts?.appPath && !opts?.fontPath) {
    const unattempted = db.db.query(
      "SELECT COUNT(*) AS c FROM sf_symbols WHERE scope = 'public' AND codepoint IS NULL AND codepoint_attempted_version IS NULL",
    ).get()?.c ?? 0
    if (unattempted === 0) {
      const total = db.db.query("SELECT COUNT(*) AS c FROM sf_symbols WHERE scope = 'public'").get()?.c ?? 0
      const settledNull = db.db.query(
        "SELECT COUNT(*) AS c FROM sf_symbols WHERE scope = 'public' AND codepoint IS NULL",
      ).get()?.c ?? 0
      if (total > 0) {
        logger?.info?.(
          `SF Symbol codepoints settled (${total - settledNull}/${total} stamped` +
          `${settledNull > 0 ? `; ${settledNull} unresolvable by the attempted app version — retried on app change or --full` : ''}) — skipping`,
        )
        return { stamped: 0, total, fontPath: null, skipped: true }
      }
    }
  }

  // Ensure a current SF Symbols.app is on disk before resolving paths.
  // Prefers /Applications when already current; downloads the latest
  // .dmg to <dataDir>/cache/sf-symbols/<version>/ otherwise. Caller can
  // pass `appPath`/`fontPath` to bypass the provisioner entirely
  // (used by tests and offline snapshot rebuilds).
  let appPath = opts?.appPath ?? null
  // SF Symbols version the codepoints are resolved against — stamped alongside
  // each codepoint so the snapshot's font can be matched to its codepoints.
  let version = opts?.version ?? null
  if (!appPath && !opts?.fontPath) {
    try {
      const installed = await ensureSfSymbolsApp({
        dataDir,
        logger,
        forceRefresh: opts?.forceRefresh,
      })
      appPath = installed.appPath
      version = installed.version ?? version
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

  // Resumable: outside an explicit `forceRefresh` (re-resolve everything),
  // dump every row still missing a codepoint — including previously
  // attempted ones, since a dump is running anyway and re-asking a hundred
  // names costs one extra chunk round-trip. A previously-interrupted dump
  // then converges over retries instead of re-walking the full catalog.
  const targets = opts?.forceRefresh
    ? catalog
    : catalog.filter(symbol => symbol.codepoint == null)
  if (targets.length === 0) {
    logger?.info?.(
      `SF Symbol codepoints already stamped (${catalog.length} public symbols) — nothing missing`,
    )
    return { stamped: 0, total: catalog.length, requested: 0, fontPath, skipped: true }
  }

  const names = targets.map(symbol => symbol.name)
  const { map } = await dumpSymbolCodepoints(names, {
    fontPath,
    metadataDir,
    appPath: usedAppPath,
    logger,
    // Test seam: lets unit tests replace the Swift worker spawn.
    ...(opts?.spawn ? { spawn: opts.spawn } : {}),
  })

  let stamped = 0
  const answeredNull = []
  for (const [name, codepoint] of map) {
    try {
      db.updateSfSymbolCodepoint('public', name, codepoint, version)
      if (codepoint != null) stamped++
      else answeredNull.push(name)
    } catch (err) {
      logger?.warn?.(`failed to stamp codepoint for ${name}: ${err.message ?? err}`)
    }
  }

  // The worker ANSWERED these names with no codepoint: the provisioned app
  // simply cannot resolve them (app/OS catalog version skew — the running
  // macOS's CoreGlyphs and the released SF Symbols.app drift in either
  // direction). Record the app version attempted so the steady-state gate
  // stops re-dumping them every sync; an app-version change, `--full`, or
  // any dump triggered by new symbols re-attempts them.
  if (answeredNull.length > 0) {
    const attemptedVersion = version ?? 'unknown'
    const mark = db.db.query(
      "UPDATE sf_symbols SET codepoint_attempted_version = ? WHERE scope = 'public' AND name = ?",
    )
    for (const name of answeredNull) mark.run(attemptedVersion, name)
  }

  const missing = db.db.query(
    "SELECT COUNT(*) AS c FROM sf_symbols WHERE scope = 'public' AND codepoint IS NULL",
  ).get()?.c ?? 0
  const unanswered = names.length - map.size
  const pct = ((stamped / names.length) * 100).toFixed(1)
  const summary =
    `Stamped codepoints on ${stamped} of ${names.length} requested public symbols (${pct}% coverage)`
  if (unanswered > 0) {
    // The dump died or timed out before finishing — loud, and the
    // unanswered rows stay NULL + unattempted so the next sync re-opens
    // the gate and re-requests only them.
    logger?.warn?.(
      `${summary}; dump ended early — ${unanswered} symbols unanswered, will retry on the next sync`,
    )
  } else if (answeredNull.length > 0) {
    logger?.info?.(
      `${summary}; ${answeredNull.length} catalog symbols are not resolvable by SF Symbols.app ` +
      `${version ?? '(unknown version)'} (app/OS catalog version skew) — retried on app change or --full`,
    )
  } else {
    logger?.info?.(`${summary}; catalog fully stamped (${catalog.length} public symbols)`)
  }
  return { stamped, total: catalog.length, requested: names.length, missing, unanswered, fontPath }
}
