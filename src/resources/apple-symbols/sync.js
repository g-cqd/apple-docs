/**
 * SF Symbol catalog sync + snapshot pre-rendering.
 *
 * Two public entry points:
 *
 *   - syncSfSymbols   : reads the CoreGlyphs.bundle plists into the DB
 *   - prerenderSfSymbols : drives a Swift worker pool to bake every
 *                          symbol into theme-neutral SVGs on disk
 *
 * The prerender path also emits meta.json next to the snapshot so the
 * runtime renderer can detect drift and bust the cache.
 */

import { existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readPlist } from '../../lib/plist.js'
import { spawnWithDeadline } from '../../lib/spawn-with-deadline.js'
import { ensureDir } from '../../storage/files.js'
import { symbolPdfToSvg } from '../symbol-pdf-to-svg.js'
import { spawnSymbolWorker } from './symbol-worker.js'
import { normalizeStringArray } from '../apple-fonts/sfnt.js'
import { readBundleVersion, readStringsMap } from '../apple-fonts/sync.js'
import {
  getPrerenderedSymbolPath,
  symbolVariantMatrix,
} from './cache-key.js'
import { symbolSnapshotNeedsReset } from './snapshot-meta.js'
import { markUnrenderableSymbols } from './mark-unrenderable.js'
import { stampSfSymbolCodepoints } from './codepoint-stamp.js'
import { SYMBOL_RENDERER_VERSION } from './render.js'

export { stampSfSymbolCodepoints }

const SYMBOL_BUNDLES = {
  public: '/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/CoreGlyphs.bundle/Contents/Resources',
  private: '/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/CoreGlyphsPrivate.bundle/Contents/Resources',
}

// Apple's plists embed catalog meta-entries alongside real symbol names —
// `symbols` is the top-level catalog root and `year_to_release` is the
// release-grouping pivot. They appear in symbol_categories.plist /
// symbol_search.plist / name_availability.plist but have no vectorGlyph
// drawable in either bundle, so the Swift worker can't render them and
// the snapshot completeness validator flags 14 weight/scale variants ×
// 4 (2 names × 2 scopes) = 56 phantom misses.
//
// Filter at ingest so they never enter the sf_symbols table going
// forward, AND filter at prerender so a DB carrying stale rows from
// pre-filter syncs doesn't surface the failure. Exported so a one-shot
// cleanup script (or test) can also use the same source of truth.
const CATALOG_META_NAMES = new Set(['symbols', 'year_to_release'])

const SYMBOL_DEFAULT_RENDER_SIZE = 128

export async function syncSfSymbols(opts, ctx) {
  const { db, logger } = ctx
  const scope = opts.scope === 'private' ? 'private' : 'public'
  const bundleDir = opts.bundleDir ?? SYMBOL_BUNDLES[scope]
  if (!existsSync(bundleDir)) {
    logger?.warn?.(`SF Symbols ${scope} bundle not found at ${bundleDir}`)
    return 0
  }

  const order = await readPlist(join(bundleDir, 'symbol_order.plist')) ?? []
  const categories = await readPlist(join(bundleDir, 'symbol_categories.plist')) ?? {}
  const search = await readPlist(join(bundleDir, 'symbol_search.plist')) ?? {}
  const aliases = await readStringsMap(join(bundleDir, 'name_aliases.strings'))
  const availability = await readPlist(join(bundleDir, 'name_availability.plist')) ?? {}
  const version = await readBundleVersion(dirname(bundleDir))

  const names = new Set(Array.isArray(order) ? order : [])
  for (const name of Object.keys(search)) names.add(name)
  for (const name of Object.keys(categories)) names.add(name)
  for (const name of Object.keys(availability)) names.add(name)
  for (const meta of CATALOG_META_NAMES) names.delete(meta)

  let count = 0
  const ordered = Array.isArray(order) ? order : [...names].sort()
  const orderIndex = new Map(ordered.map((name, index) => [name, index]))
  for (const name of [...names].sort((a, b) => (orderIndex.get(a) ?? 999999) - (orderIndex.get(b) ?? 999999) || a.localeCompare(b))) {
    db.upsertSfSymbol({
      name,
      scope,
      categories: normalizeStringArray(categories[name]),
      keywords: normalizeStringArray(search[name]),
      aliases: normalizeStringArray(aliases[name]),
      availability: availability[name] ?? null,
      orderIndex: orderIndex.get(name) ?? null,
      bundlePath: bundleDir,
      bundleVersion: version,
    })
    count++
  }
  return count
}

// stampSfSymbolCodepoints lives in `./codepoint-stamp.js` to keep this
// file under the 400-line check; re-exported above for callsite
// compatibility.

/**
 * Pre-render every indexed SF Symbol into a flat directory of theme-neutral
 * SVG files. Spawns a long-lived Swift worker that processes one symbol per
 * line on stdin and writes a length-prefixed PDF frame back on stdout. This
 * avoids the per-symbol Swift cold-start cost (~200ms each); a single worker
 * churns through ~10–20 symbols/sec.
 */
export async function prerenderSfSymbols(opts, ctx) {
  const { dataDir, logger } = ctx
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 16))
  const scopeFilter = opts.scope === 'public' || opts.scope === 'private' ? opts.scope : null
  const baseDir = join(dataDir, 'resources', 'symbols')
  if (opts.resetCache || await symbolSnapshotNeedsReset(baseDir)) {
    await rm(baseDir, { recursive: true, force: true }).catch(() => {})
  }
  ensureDir(baseDir)
  // Defense in depth: filter CATALOG_META_NAMES here too. The sync-time
  // filter already keeps new rows out of the DB, but a stale snapshot
  // built before that filter landed can still carry `symbols` /
  // `year_to_release` rows. Letting them through here would burn
  // 27 variants × ~scopes worth of doomed worker calls for no payoff.
  const symbols = ctx.db.listSfSymbolsCatalog()
    .filter(symbol => !scopeFilter || symbol.scope === scopeFilter)
    .filter(symbol => !CATALOG_META_NAMES.has(symbol.name))
  const result = { rendered: 0, skipped: 0, failed: 0, total: 0, symbols: symbols.length, failures: [] }

  // Cluster work by scope so each worker only handles one bundle path.
  const buckets = { public: [], private: [] }
  for (const symbol of symbols) buckets[symbol.scope].push(symbol)
  for (const scope of ['public', 'private']) {
    if (!buckets[scope].length) continue
    const scopeDir = join(baseDir, scope)
    ensureDir(scopeDir)
    const variants = symbolVariantMatrix(scope)
    result.total += buckets[scope].length * variants.length
    await renderScopeBucket({
      scope,
      symbols: buckets[scope],
      variants,
      ctx,
      concurrency,
      logger,
      onProgress: opts.onProgress,
      result,
    })
    markUnrenderableSymbols({ ctx, scope, variants, result, logger })
  }

  await Bun.write(join(baseDir, 'meta.json'), JSON.stringify({
    rendererVersion: SYMBOL_RENDERER_VERSION,
    pointSize: SYMBOL_DEFAULT_RENDER_SIZE,
    variants: {
      public: symbolVariantMatrix('public'),
      private: symbolVariantMatrix('private'),
    },
    provenance: await getSymbolRenderProvenance(),
    builtAt: new Date().toISOString(),
    counts: result,
  }, null, 2))
  return result
}

// Snapshot-meta gating lives in ./snapshot-meta.js (keeps this module under
// the 400-line ceiling); imported above for prerenderSfSymbols and re-exported
// here so callers that import it from this file keep working.
export { symbolSnapshotNeedsReset }

async function renderScopeBucket({ scope, symbols, variants, ctx, concurrency, logger, onProgress, result }) {
  // Build the on-disk inventory once and pre-filter the queue by set
  // difference. The previous shape probed every symbol×weight×scale pair
  // with existsSync+statSync (266k syscall pairs, ~23 s to skip a fully
  // rendered snapshot) and spawned the Swift workers — seconds of cold
  // start each — before knowing whether anything needed rendering.
  const rendered = inventoryRenderedSymbols(join(ctx.dataDir, 'resources', 'symbols', scope === 'private' ? 'private' : 'public'))
  const queue = []
  for (const symbol of symbols) {
    for (const variant of variants) {
      const filePath = getPrerenderedSymbolPath({ dataDir: ctx.dataDir }, scope, symbol.name, variant)
      if (rendered.has(filePath)) {
        result.skipped++
      } else {
        queue.push({ symbol, ...variant })
      }
    }
  }
  onProgress?.(result)
  if (queue.length === 0) return

  const workers = []
  const startWorker = () => spawnSymbolWorker({ scope, logger })
  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    const worker = await startWorker()
    workers.push(processSymbolQueue({ worker, queue, ctx, scope, result, onProgress, logger, restart: startWorker }))
  }
  await Promise.all(workers)
}

/** Rendered SVGs under `dir`, as a Set of absolute paths. Presence is
 *  trustworthy because the render path writes atomically (tmp + rename) —
 *  no per-file stat needed for 266k entries. */
function inventoryRenderedSymbols(dir) {
  const out = new Set()
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.svg')) continue
    out.add(join(entry.parentPath ?? entry.path ?? dir, entry.name))
  }
  return out
}

async function processSymbolQueue({ worker, queue, ctx, scope, result, onProgress, logger, restart }) {
  const dataDir = ctx.dataDir
  let activeWorker = worker
  while (queue.length > 0) {
    const item = queue.shift()
    if (!item) break
    const { symbol, weight, scale } = item
    const filePath = getPrerenderedSymbolPath({ dataDir }, scope, symbol.name, { weight, scale })
    if (existsSync(filePath) && statSync(filePath).size > 0) {
      result.skipped++
      onProgress?.(result)
      continue
    }
    // Split the failure surfaces: the Swift worker (renders the PDF on
    // stdout) and the JS-side PDF→SVG parser are separate concerns.
    // Restarting the Swift worker on a parser error costs ~200 ms of
    // cold-start per call — irrelevant on the happy path, but a
    // 30-minute prerender tax when the parser hits a recurring bug.
    let pdfBytes
    try {
      pdfBytes = await activeWorker.render(symbol.name, weight, scale)
    } catch (error) {
      const msg = error.message ?? String(error)
      // Bitmap-only symbols (most private/emoji.* entries, some
      // private misc) genuinely don't have a vector form. The Swift
      // worker reports this via respondsToSelector; log at debug so
      // we don't flood at warn level. Treat as `skipped` rather than
      // `failed`, and mark the catalog row so the snapshot validator
      // doesn't flag the missing files as an error.
      const bitmapOnly = msg.includes('bitmap-backed') || msg.includes('no vectorGlyph')
      if (bitmapOnly) {
        logger?.debug?.(`Skip ${scope}/${symbol.name} (${weight}/${scale}): no vector form`)
        result.skipped++
        try { ctx.db.markSfSymbolBitmapOnly(scope, symbol.name) } catch {}
      } else {
        logger?.warn?.(`Pre-render failed for ${scope}/${symbol.name} (${weight}/${scale}): ${msg}`)
        result.failed++
        result.failures.push({ scope, name: symbol.name, weight, scale, error: msg })
        // Worker actually died (broken pipe, crash, etc.) — restart.
        try { activeWorker.close() } catch {}
        activeWorker = await restart()
      }
      onProgress?.(result)
      continue
    }

    try {
      // Pre-rendered SVGs are used both as <img src> targets (where
      // currentColor would resolve correctly) AND as CSS `mask-image`
      // sources for the symbols-grid tiles (where the browser only reads
      // the alpha channel — `currentColor` evaluates against a context
      // that doesn't exist, yielding zero alpha). Bake an opaque color in
      // so the mask has solid coverage, then have the API route swap it
      // out when the user requests an explicit foreground.
      const svg = await symbolPdfToSvg(pdfBytes, {
        name: symbol.name,
        pointSize: SYMBOL_DEFAULT_RENDER_SIZE,
        color: '#000000',
        background: null,
      })
      ensureDir(dirname(filePath))
      // Atomic write: the inventory pre-filter trusts file presence, so a
      // crash mid-write must never leave a truncated .svg behind.
      const tempPath = `${filePath}.tmp-${process.pid}`
      await Bun.write(tempPath, svg)
      renameSync(tempPath, filePath)
      result.rendered++
    } catch (error) {
      // Parser failure — the Swift worker is healthy, no restart needed.
      const msg = error.message ?? String(error)
      logger?.warn?.(`Pre-render failed for ${scope}/${symbol.name} (${weight}/${scale}): ${msg}`)
      result.failed++
      result.failures.push({ scope, name: symbol.name, weight, scale, error: msg })
    }
    onProgress?.(result)
  }
  try { activeWorker.close() } catch {}
}

// The Swift worker (spawn + length-prefixed frame protocol) lives in
// ./symbol-worker.js to keep this module under the 400-line ceiling.

async function getSymbolRenderProvenance() {
  return {
    macOS: await readMacOSVersion(),
    sources: {
      public: await getSymbolSourceProvenance('public'),
      private: await getSymbolSourceProvenance('private'),
    },
  }
}

async function getSymbolSourceProvenance(scope) {
  const resourcesPath = SYMBOL_BUNDLES[scope]
  const contentsPath = dirname(resourcesPath)
  return {
    renderer: scope === 'private'
      ? 'Bundle.image(forResource:) from CoreGlyphsPrivate.bundle'
      : 'NSImage(systemSymbolName:) from the system SF Symbols catalog',
    font: null,
    bundle: scope === 'private' ? 'CoreGlyphsPrivate.bundle' : 'CoreGlyphs.bundle',
    resourcesPath,
    contentsPath,
    bundleVersion: await readBundleVersion(contentsPath).catch(() => null),
  }
}

async function readMacOSVersion() {
  try {
    const { stdout, exitCode } = await spawnWithDeadline(['/usr/bin/sw_vers'], { deadlineMs: 5_000 })
    if (exitCode !== 0) return null
    const text = new TextDecoder().decode(stdout)
    const pairs = Object.fromEntries(text.trim().split('\n').map(line => {
      const [key, ...rest] = line.split(':')
      return [key.trim(), rest.join(':').trim()]
    }).filter(([key]) => key))
    return {
      productName: pairs.ProductName ?? null,
      productVersion: pairs.ProductVersion ?? null,
      buildVersion: pairs.BuildVersion ?? null,
    }
  } catch {
    return null
  }
}
