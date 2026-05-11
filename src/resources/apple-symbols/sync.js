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

import { existsSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readPlist } from '../../lib/plist.js'
import { spawnWithDeadline } from '../../lib/spawn-with-deadline.js'
import { ensureDir } from '../../storage/files.js'
import { symbolPdfToSvg } from '../symbol-pdf-to-svg.js'
import { SYMBOL_WORKER_SCRIPT } from '../swift-templates.js'
import { normalizeStringArray } from '../apple-fonts/sfnt.js'
import { readBundleVersion, readStringsMap } from '../apple-fonts/sync.js'
import {
  getPrerenderedSymbolPath,
  symbolVariantKey,
  symbolVariantMatrix,
} from './cache-key.js'
import { SYMBOL_RENDERER_VERSION } from './render.js'

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
// 4 (2 names × 2 scopes) = 56 phantom misses. Filter at ingest so they
// never enter the sf_symbols table.
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
  const symbols = ctx.db.listSfSymbolsCatalog()
    .filter(symbol => !scopeFilter || symbol.scope === scopeFilter)
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

export async function symbolSnapshotNeedsReset(baseDir) {
  if (!existsSync(baseDir)) return false
  const entries = readdirSync(baseDir, { withFileTypes: true })
    .filter(entry => entry.name !== 'meta.json')
  if (entries.length === 0) return false

  const meta = await readJsonIfExists(join(baseDir, 'meta.json'))
  if (!meta || meta.rendererVersion !== SYMBOL_RENDERER_VERSION) return true
  return !hasSnapshotVariantSet(meta, 'public') || !hasSnapshotVariantSet(meta, 'private')
}

async function readJsonIfExists(path) {
  try {
    return await Bun.file(path).json()
  } catch {
    return null
  }
}

function hasSnapshotVariantSet(meta, scope) {
  const expected = symbolVariantMatrix(scope).map(symbolVariantKey).sort()
  const actual = Array.isArray(meta?.variants?.[scope])
    ? meta.variants[scope].map(symbolVariantKey).sort()
    : []
  return expected.length === actual.length && expected.every((key, index) => key === actual[index])
}

async function renderScopeBucket({ scope, symbols, variants, ctx, concurrency, logger, onProgress, result }) {
  const queue = []
  for (const symbol of symbols) {
    for (const variant of variants) queue.push({ symbol, ...variant })
  }
  const workers = []
  const startWorker = () => spawnSymbolWorker({ scope, logger })
  for (let i = 0; i < concurrency; i++) {
    const worker = await startWorker()
    workers.push(processSymbolQueue({ worker, queue, ctx, scope, result, onProgress, logger, restart: startWorker }))
  }
  await Promise.all(workers)
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
    try {
      const pdfBytes = await activeWorker.render(symbol.name, weight, scale)
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
      await Bun.write(filePath, svg)
      result.rendered++
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
        // The worker may have died on a non-bitmap error; restart it.
        try { activeWorker.close() } catch {}
        activeWorker = await restart()
      }
    }
    onProgress?.(result)
  }
  try { activeWorker.close() } catch {}
}

async function spawnSymbolWorker({ scope, logger }) {
  const scriptPath = join(tmpdir(), `apple-docs-symbol-worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}.swift`)
  await Bun.write(scriptPath, SYMBOL_WORKER_SCRIPT)
  const proc = Bun.spawn(['swift', scriptPath, scope], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  })
  const reader = proc.stdout.getReader()
  let buffer = new Uint8Array(0)

  // Drain stderr into the logger so worker crashes are visible.
  void (async () => {
    try {
      const text = await new Response(proc.stderr).text()
      if (text.trim()) logger?.debug?.(`symbol worker stderr: ${text.trim()}`)
    } catch {}
  })()

  async function readBytes(n) {
    while (buffer.length < n) {
      const { value, done } = await reader.read()
      if (done) throw new Error('worker exited')
      const merged = new Uint8Array(buffer.length + value.length)
      merged.set(buffer, 0)
      merged.set(value, buffer.length)
      buffer = merged
    }
    const out = buffer.slice(0, n)
    buffer = buffer.slice(n)
    return out
  }

  return {
    async render(name, weight = 'regular', scale = 'medium') {
      // Per-frame deadline. The worker is long-lived (one process per scope
      // for the whole prerender), so we can't apply spawnWithDeadline here.
      // Instead: wrap the read in a Promise.race against a 30s timeout. On
      // timeout, the caller (processSymbolQueue) catches and restarts the
      // worker. Generous bound — most symbols render in <100 ms; the long
      // tail tops out around 5 s for the most complex cut-out symbols.
      proc.stdin.write(`${name}\t${weight}\t${scale}\n`)
      await proc.stdin.flush()
      return await Promise.race([
        (async () => {
          const header = await readBytes(8)
          const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
          const status = view.getUint32(0)
          const length = view.getUint32(4)
          const payload = await readBytes(length)
          if (status !== 0) {
            throw new Error(new TextDecoder().decode(payload) || 'worker error')
          }
          return payload
        })(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`symbol worker frame timeout after 30s for ${scope}/${name}`)),
            30_000,
          ),
        ),
      ])
    },
    close() {
      try { proc.stdin.end?.() } catch {}
      try { proc.kill() } catch {}
      void rm(scriptPath, { force: true }).catch(() => {})
    },
  }
}

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
