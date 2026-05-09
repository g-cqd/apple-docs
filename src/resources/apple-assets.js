import { basename, dirname, extname, join, resolve } from 'node:path'
import { copyFile, mkdtemp, rename, rm } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { readPlist } from '../lib/plist.js'
import { SYMBOL_PDF_SCRIPT, SYMBOL_WORKER_SCRIPT } from './swift-templates.js'
import { sha256 } from '../lib/hash.js'
import { ensureDir } from '../storage/files.js'
import { symbolPdfToSvg } from './symbol-pdf-to-svg.js'
import {
  inspectSfntFile,
  isLikelySfnt,
  normalizeStringArray,
  parseFontFilename,
} from './apple-fonts/sfnt.js'
import { renderFontText } from './apple-fonts/render.js'
import {
  discoverAppleFontFiles,
  downloadFileIfNeeded,
  extractDmgFonts,
  hashFile,
  readBundleVersion,
  readStringsMap,
} from './apple-fonts/sync.js'
import {
  getPrerenderedSymbolPath,
  normalizeSymbolScale,
  normalizeSymbolWeight,
  SYMBOL_SCALES,
  SYMBOL_WEIGHTS,
  symbolVariantKey,
  symbolVariantMatrix,
} from './apple-symbols/cache-key.js'
import {
  customizePrerenderedSymbolSvg,
  renderSymbolSvgFallback,
} from './apple-symbols/svg-helpers.js'
import { renderSfSymbol, SYMBOL_RENDERER_VERSION } from './apple-symbols/render.js'
import {
  clampInteger,
  escapeXml,
  normalizeBackground,
  normalizeColor,
  sanitizeFileName,
  tempSuffix,
} from './apple-assets-helpers.js'

export { inspectSfntFile, parseFontFilename }
export { SYMBOL_WEIGHTS, SYMBOL_SCALES, getPrerenderedSymbolPath }
export { renderFontText }
export { renderSfSymbol }

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

const SYMBOL_BUNDLES = {
  public: '/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/CoreGlyphs.bundle/Contents/Resources',
  private: '/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/CoreGlyphsPrivate.bundle/Contents/Resources',
}

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.dfont'])
const DEFAULT_FONT_DIRS = [
  '/Library/Fonts',
  '/System/Library/Fonts',
  join(homedir(), 'Library', 'Fonts'),
]

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

export function listAppleFonts(ctx) {
  return { families: ctx.db.listAppleFonts() }
}

export function searchSfSymbols(query, opts, ctx) {
  return { results: ctx.db.searchSfSymbols(query, opts), query: query ?? '', scope: opts.scope ?? null }
}

const SYMBOL_DEFAULT_RENDER_SIZE = 128

/**
 * Pre-render every indexed SF Symbol into a flat directory of theme-neutral
 * SVG files. Spawns a long-lived Swift worker that processes one symbol per
 * line on stdin and writes a length-prefixed SVG to stdout. This avoids the
 * per-symbol Swift cold-start cost (~200ms each); a single worker churns
 * through ~10–20 symbols/sec.
 *
 * @param {object} opts - { scope?, concurrency?, resetCache?, logger?, onProgress? }
 * @param {object} ctx
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
      dataDir,
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

async function symbolSnapshotNeedsReset(baseDir) {
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

async function renderScopeBucket({ scope, symbols, variants, dataDir, concurrency, logger, onProgress, result }) {
  const queue = []
  for (const symbol of symbols) {
    for (const variant of variants) queue.push({ symbol, ...variant })
  }
  const workers = []
  const startWorker = () => spawnSymbolWorker({ scope, logger })
  for (let i = 0; i < concurrency; i++) {
    const worker = await startWorker()
    workers.push(processSymbolQueue({ worker, queue, dataDir, scope, result, onProgress, logger, restart: startWorker }))
  }
  await Promise.all(workers)
}

async function processSymbolQueue({ worker, queue, dataDir, scope, result, onProgress, logger, restart }) {
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
      const svg = await finalizeSvgFromPdf(pdfBytes, {
        name: symbol.name,
        pointSize: SYMBOL_DEFAULT_RENDER_SIZE,
        color: '#000000',
        background: null,
      })
      ensureDir(dirname(filePath))
      await Bun.write(filePath, svg)
      result.rendered++
    } catch (error) {
      logger?.warn?.(`Pre-render failed for ${scope}/${symbol.name} (${weight}/${scale}): ${error.message}`)
      result.failed++
      result.failures.push({ scope, name: symbol.name, weight, scale, error: error.message })
      // The worker may have died; restart it.
      try { activeWorker.close() } catch {}
      activeWorker = await restart()
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
      // Bun's proc.stdin is a FileSink with sync write() + flush().
      proc.stdin.write(`${name}\t${weight}\t${scale}\n`)
      await proc.stdin.flush()
      const header = await readBytes(8)
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
      const status = view.getUint32(0)
      const length = view.getUint32(4)
      const payload = await readBytes(length)
      if (status !== 0) {
        throw new Error(new TextDecoder().decode(payload) || 'worker error')
      }
      return payload
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
    const proc = Bun.spawn(['/usr/bin/sw_vers'], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    if (code !== 0) return null
    const pairs = Object.fromEntries(stdout.trim().split('\n').map(line => {
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

async function run(args) {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${stderr.trim()}`)
}


export const _test = {
  customizePrerenderedSymbolSvg,
  normalizeSymbolScale,
  normalizeSymbolWeight,
  symbolRendererVersion: SYMBOL_RENDERER_VERSION,
  symbolSnapshotNeedsReset,
  symbolVariantMatrix,
}
