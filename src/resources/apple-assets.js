import { basename, dirname, extname, join, resolve } from 'node:path'
import { copyFile, mkdtemp, rename, rm } from 'node:fs/promises'
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { readPlist } from '../lib/plist.js'
import { SYMBOL_PDF_SCRIPT, SYMBOL_WORKER_SCRIPT } from './swift-templates.js'
import { sha256 } from '../lib/hash.js'
import { ensureDir } from '../storage/files.js'
import { symbolPdfToSvg } from './symbol-pdf-to-svg.js'

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

/** Per-call random suffix for Swift temp script paths. PID alone is
 *  predictable on a shared host — appending randomness rules out the
 *  symlink-race-then-clobber attack surface flagged in the audit
 *  (deep-exhaustive §2.1, P3.4). */
function tempSuffix() {
  return Math.random().toString(36).slice(2, 10)
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

const SYMBOL_RENDERER_VERSION = 8
const SYMBOL_DEFAULT_RENDER_SIZE = 128

export function getPrerenderedSymbolPath(ctx, scope, name, opts = {}) {
  const cleanScope = scope === 'private' ? 'private' : 'public'
  const weight = normalizeSymbolWeight(opts.weight)
  const scale = normalizeSymbolScale(opts.scale)
  if (cleanScope === 'public' && (weight !== 'regular' || scale !== 'medium')) {
    return join(ctx.dataDir, 'resources', 'symbols', cleanScope, `${weight}-${scale}`, `${sanitizeFileName(name)}.svg`)
  }
  return join(ctx.dataDir, 'resources', 'symbols', cleanScope, `${sanitizeFileName(name)}.svg`)
}

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

function symbolVariantKey(variant) {
  return `${normalizeSymbolWeight(variant?.weight)}/${normalizeSymbolScale(variant?.scale)}`
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



export const SYMBOL_WEIGHTS = ['ultralight', 'thin', 'light', 'regular', 'medium', 'semibold', 'bold', 'heavy', 'black']
export const SYMBOL_SCALES = ['small', 'medium', 'large']

function normalizeSymbolWeight(value) {
  const weight = String(value ?? '').toLowerCase()
  return SYMBOL_WEIGHTS.includes(weight) ? weight : 'regular'
}

function normalizeSymbolScale(value) {
  const scale = String(value ?? '').toLowerCase()
  return SYMBOL_SCALES.includes(scale) ? scale : 'medium'
}

function symbolVariantMatrix(scope) {
  if (scope === 'private') return [{ weight: 'regular', scale: 'medium' }]
  const variants = []
  for (const weight of SYMBOL_WEIGHTS) {
    for (const scale of SYMBOL_SCALES) variants.push({ weight, scale })
  }
  return variants
}

export async function renderSfSymbol(opts, ctx) {
  const scope = opts.scope === 'private' ? 'private' : 'public'
  const format = opts.format === 'svg' ? 'svg' : 'png'
  const pointSize = clampInteger(opts.size ?? opts.pointSize ?? 64, 8, 1024)
  const requestedWeight = normalizeSymbolWeight(opts.weight)
  const requestedScale = normalizeSymbolScale(opts.scale)
  const weight = scope === 'public' ? requestedWeight : 'regular'
  const scale = scope === 'public' ? requestedScale : 'medium'
  // SVG accepts the literal string "currentColor" so it inherits the page's
  // CSS color. PNG cannot — Apple's renderer needs a concrete sRGB value, so
  // we fall back to black for PNG when "currentColor" is requested.
  const rawColor = opts.color ?? '#000000'
  const color = format === 'svg' && String(rawColor).toLowerCase() === 'currentcolor'
    ? 'currentColor'
    : normalizeColor(rawColor)
  const background = normalizeBackground(opts.background ?? opts.bg)
  const cacheKey = sha256(JSON.stringify({
    // Bumping `renderer` invalidates every cached SVG/PNG so the next
    // request refreshes against the current snapshot/live renderer contract.
    //   - 2: tried `_vectorGlyph` without flip + forced evenodd (broke many)
    //   - 3: switched to `outlinePath` (single flat path; loses per-layer
    //        XOR/exclusion → tray.badge.sparkles renders as a blob)
    //   - 4: canonical pipeline — vectorGlyph.drawInContext: into a 2048pt
    //        PDF page, then pdftocairo → SVG, then strip the clipPath
    //        wrapper and recompute viewBox from path data. Lost cut-out
    //        layers on .fill symbols (xmark.bin.circle.fill, health.fill).
    //   - 5: same Swift PDF emitter, but parse the PDF in JS and convert
    //        `/ca 0` ExtGState fills into SVG `<mask>` cut-outs. True
    //        vector fidelity for every layer-cutout symbol.
    //   - 6: weight + scale plumbed through to NSSymbolConfiguration so
    //        the inspector controls actually re-render the preview.
    //   - 7: alpha-zero cut layers now emit fill-rule-preserving internal
    //        SVG masks instead of the old even-odd clip subtraction shortcut.
    //   - 8: runtime renders derive from snapshot SVG geometry first; live
    //        CoreGlyphs/AppKit rendering is fallback only.
    renderer: SYMBOL_RENDERER_VERSION,
    type: 'sf-symbol',
    scope,
    name: opts.name,
    format,
    pointSize,
    weight,
    scale,
    color,
    background,
  })).slice(0, 32)
  const cached = ctx.db.getSfSymbolRender(cacheKey)
  if (cached && existsSync(cached.file_path)) return cached

  const symbol = ctx.db.getSfSymbol(scope, opts.name)
  if (!symbol) throw new Error(`SF Symbol not found: ${scope}/${opts.name}`)

  const renderDir = join(ctx.dataDir, 'resources', 'symbol-renders', scope)
  ensureDir(renderDir)
  const filePath = join(renderDir, `${sanitizeFileName(opts.name)}.${cacheKey}.${format}`)
  let data
  let mode = 'live'
  const snapshotSvg = await renderSymbolSvgFromSnapshot({
    name: opts.name,
    scope,
    pointSize,
    weight,
    scale,
    color,
    background,
  }, ctx)
  if (snapshotSvg) {
    if (format === 'svg') {
      data = snapshotSvg
      mode = 'snapshot'
    } else {
      try {
        data = await renderPngFromSvg(snapshotSvg, { pointSize })
        mode = 'snapshot'
      } catch (error) {
        ctx.logger?.warn?.(`SF Symbol snapshot PNG rasterization failed for ${scope}/${opts.name}: ${error.message}`)
      }
    }
  }
  if (!data) {
    if (format === 'svg') {
      try {
        data = await renderSymbolSvgCurves({ name: opts.name, scope, pointSize, weight, scale, color, background })
      } catch (error) {
        ctx.logger?.warn?.(`SF Symbol SVG outline render failed for ${scope}/${opts.name}: ${error.message}`)
        data = renderSymbolSvgFallback({ name: opts.name, scope, pointSize, color, background })
      }
    } else {
      data = await renderSymbolPng({ name: opts.name, scope, pointSize, weight, scale, color, background })
    }
  }
  await Bun.write(filePath, data)
  const bytes = await Bun.file(filePath).arrayBuffer()
  const row = {
    cacheKey,
    name: opts.name,
    scope,
    format,
    mode,
    weight,
    symbolScale: scale,
    pointSize,
    color,
    filePath,
    mimeType: format === 'svg' ? 'image/svg+xml; charset=utf-8' : 'image/png',
    sha256: sha256(bytes),
    size: bytes.byteLength,
  }
  ctx.db.upsertSfSymbolRender(row)
  return ctx.db.getSfSymbolRender(cacheKey)
}

export async function renderFontText(opts, ctx) {
  const font = ctx.db.getAppleFontFile(opts.fontId)
  if (!font) throw new Error(`Font file not found: ${opts.fontId}`)
  const text = String(opts.text ?? 'Typography')
  const pointSize = clampInteger(opts.size ?? 96, 8, 512)
  let content
  // CoreText / CTFontManagerRegisterFontsForURL behaviour on a non-SFNT
  // file is "undefined" in practice — observed to either segfault, register
  // a phantom descriptor, or stall indefinitely on macOS CI runners (the
  // last case wedges the request handler and the server eventually drops
  // listening for the test fetch). Probe the magic header up-front so test
  // fixtures and corrupt downloads short-circuit straight to the placeholder
  // SVG without spawning Swift.
  const valid = await isLikelySfnt(font.file_path)
  if (!valid) {
    content = renderFontTextSvgFallback({ fontFamily: font.family_display_name, text, pointSize })
  } else {
    try {
      content = await renderFontTextSvgCurves({ fontPath: font.file_path, text, pointSize })
    } catch (error) {
      ctx.logger?.warn?.(`CoreText outline render failed for ${font.file_name}: ${error.message}`)
      content = renderFontTextSvgFallback({ fontFamily: font.family_display_name, text, pointSize })
    }
  }
  return {
    font,
    text,
    format: 'svg',
    mimeType: 'image/svg+xml; charset=utf-8',
    content,
  }
}

function discoverAppleFontFiles(dirs) {
  const files = []
  const seen = new Set()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    walkFiles(dir, (filePath) => {
      const ext = extname(filePath).toLowerCase()
      if (!FONT_EXTENSIONS.has(ext)) return
      const resolved = resolve(filePath)
      if (seen.has(resolved)) return
      seen.add(resolved)
      files.push({ fileName: basename(filePath), filePath: resolved })
    })
  }
  return files
}

function walkFiles(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__MACOSX') continue
      walkFiles(full, visit)
    } else if (entry.isFile()) {
      visit(full)
    }
  }
}

async function downloadFileIfNeeded(url, filePath) {
  if (existsSync(filePath) && statSync(filePath).size > 0) return false
  ensureDir(dirname(filePath))
  const tmpPath = `${filePath}.${process.pid}.tmp`
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${url}`)
  const sink = Bun.file(tmpPath).writer()
  const reader = res.body.getReader()
  let ended = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sink.write(value)
    }
    await sink.end()
    ended = true
    await rename(tmpPath, filePath)
  } finally {
    if (!ended) await sink.end().catch(() => {})
    await rm(tmpPath, { force: true }).catch(() => {})
  }
  return true
}

async function extractDmgFonts(dmgPath, destinationDir, logger) {
  ensureDir(destinationDir)
  const mountDir = await mkdtemp(join(tmpdir(), 'apple-docs-font-dmg-'))
  const expandedDir = await mkdtemp(join(tmpdir(), 'apple-docs-font-pkg-'))
  try {
    await run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mountDir, dmgPath])
    for (const pkg of findByExtension(mountDir, '.pkg')) {
      const out = join(expandedDir, sanitizeFileName(basename(pkg)))
      await run(['pkgutil', '--expand-full', pkg, out]).catch(error => {
        logger?.warn?.(`pkgutil failed for ${pkg}: ${error.message}`)
      })
    }
    const extracted = []
    for (const source of discoverAppleFontFiles([mountDir, expandedDir])) {
      const target = join(destinationDir, source.fileName)
      await copyFile(source.filePath, target)
      extracted.push(target)
    }
    return extracted
  } finally {
    await run(['hdiutil', 'detach', mountDir]).catch(() => {})
    await rm(mountDir, { recursive: true, force: true }).catch(() => {})
    await rm(expandedDir, { recursive: true, force: true }).catch(() => {})
  }
}

function findByExtension(dir, extension) {
  const out = []
  if (!existsSync(dir)) return out
  walkFiles(dir, (filePath) => {
    if (extname(filePath).toLowerCase() === extension) out.push(filePath)
  })
  return out
}


/**
 * Minimal XML-plist parser. Handles the dialect Apple ships under
 * CoreGlyphs.bundle and the fixtures in test/unit/symbols.test.js:
 *   <dict>, <array>, <key>, <string>, <integer>, <real>, <true/>, <false/>,
 *   <data>, <date>.
 *
 * Comments, CDATA, and DOCTYPE are tolerated and skipped. Binary plists
 * fall through with a plain throw — the caller already knows to escalate
 * to plutil in that case.
 */
async function readStringsMap(path) {
  const value = await readPlist(path).catch(() => null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const aliases = {}
  for (const [alias, canonical] of Object.entries(value)) {
    if (typeof canonical !== 'string') continue
    aliases[canonical] = [...(aliases[canonical] ?? []), alias]
  }
  return aliases
}

async function readBundleVersion(contentsDir) {
  const info = await readPlist(join(contentsDir, 'Info.plist')).catch(() => null)
  return info?.CFBundleVersion ?? null
}

async function renderSymbolPng({ name, scope, pointSize, weight = 'regular', scale = 'medium', color, background }) {
  // Stryker disable all
  const script = `
import AppKit
import Foundation
let name = CommandLine.arguments[1]
let scope = CommandLine.arguments[2]
let pointSize = CGFloat(Double(CommandLine.arguments[3]) ?? 64)
let color = NSColor(hex: CommandLine.arguments[4]) ?? .labelColor
let backgroundArg = CommandLine.arguments.count > 5 ? CommandLine.arguments[5] : ""
let background: NSColor? = backgroundArg.isEmpty ? nil : NSColor(hex: backgroundArg)
let weightArg = CommandLine.arguments.count > 6 ? CommandLine.arguments[6] : "regular"
let scaleArg = CommandLine.arguments.count > 7 ? CommandLine.arguments[7] : "medium"
func parseWeight(_ s: String) -> NSFont.Weight {
  switch s.lowercased() {
  case "ultralight": return .ultraLight
  case "thin": return .thin
  case "light": return .light
  case "medium": return .medium
  case "semibold": return .semibold
  case "bold": return .bold
  case "heavy": return .heavy
  case "black": return .black
  default: return .regular
  }
}
func parseScale(_ s: String) -> NSImage.SymbolScale {
  switch s.lowercased() {
  case "small": return .small
  case "large": return .large
  default: return .medium
  }
}
let image: NSImage?
if scope == "private" {
  let paths = [
    "/System/Library/CoreServices/CoreGlyphsPrivate.bundle",
    "/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/CoreGlyphsPrivate.bundle"
  ]
  image = paths.lazy.compactMap { Bundle(path: $0)?.image(forResource: name) }.first
} else {
  image = NSImage(systemSymbolName: name, accessibilityDescription: nil)
}
guard let base = image else { FileHandle.standardError.write(Data("symbol not found".utf8)); exit(2) }
// withSymbolConfiguration only honours weight/scale for system symbols.
// Private bundle images are plain NSImages — applying the configuration
// returns them unchanged.
let configured = scope == "public"
  ? (base.withSymbolConfiguration(.init(pointSize: pointSize, weight: parseWeight(weightArg), scale: parseScale(scaleArg))) ?? base)
  : base
let px = Int((pointSize * 2).rounded())
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { exit(3) }
rep.size = NSSize(width: pointSize, height: pointSize)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
if let bg = background {
  bg.setFill()
} else {
  NSColor.clear.setFill()
}
NSRect(x: 0, y: 0, width: pointSize, height: pointSize).fill()
color.set()
let fit = min(pointSize / configured.size.width, pointSize / configured.size.height)
let draw = NSRect(x: (pointSize - configured.size.width * fit) / 2, y: (pointSize - configured.size.height * fit) / 2, width: configured.size.width * fit, height: configured.size.height * fit)
configured.draw(in: draw, from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
guard let data = rep.representation(using: .png, properties: [:]) else { exit(4) }
FileHandle.standardOutput.write(data)
extension NSColor {
  convenience init?(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6 || s.count == 8, let v = UInt64(s, radix: 16) else { return nil }
    let r, g, b, a: CGFloat
    if s.count == 8 {
      r = CGFloat((v >> 24) & 0xff) / 255
      g = CGFloat((v >> 16) & 0xff) / 255
      b = CGFloat((v >> 8) & 0xff) / 255
      a = CGFloat(v & 0xff) / 255
    } else {
      r = CGFloat((v >> 16) & 0xff) / 255
      g = CGFloat((v >> 8) & 0xff) / 255
      b = CGFloat(v & 0xff) / 255
      a = 1
    }
    self.init(srgbRed: r, green: g, blue: b, alpha: a)
  }
}
`
  // Stryker restore all
  const scriptPath = join(tmpdir(), `apple-docs-render-symbol-${process.pid}-${tempSuffix()}.swift`)
  await Bun.write(scriptPath, script)
  try {
    const proc = Bun.spawn(
      ['swift', scriptPath, name, scope, String(pointSize), color, background ?? '', weight, scale],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || `swift exited ${code}`)
    return stdout
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {})
  }
}

function renderSymbolSvgFallback({ name, scope, pointSize, color, background }) {
  const escapedName = escapeXml(name)
  const escapedColor = escapeXml(color)
  const escapedScope = escapeXml(scope)
  const bgRect = background
    ? `<rect width="100%" height="100%" fill="${escapeXml(background)}"/>`
    : `<rect width="100%" height="100%" fill="none"/>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pointSize}" height="${pointSize}" viewBox="0 0 ${pointSize} ${pointSize}" role="img" aria-label="${escapedName}">
  <title>${escapedName}</title>
  <metadata>apple-docs ${escapedScope} SF Symbol placeholder; request PNG for AppKit-rendered symbol raster.</metadata>
  ${bgRect}
  <text x="50%" y="46%" text-anchor="middle" dominant-baseline="middle" font-family="SF Pro, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${Math.max(8, pointSize / 7)}" fill="${escapedColor}">${escapedName}</text>
</svg>`
}

async function renderSymbolSvgCurves({ name, scope, pointSize, weight = 'regular', scale = 'medium', color, background }) {
  const pdfBytes = await renderSymbolToPdfBytes({ name, scope, weight, scale })
  return finalizeSvgFromPdf(pdfBytes, { name, pointSize, color, background })
}

/**
 * Spawn Swift to render an SF Symbol via Apple's canonical
 * `vectorGlyph.drawInContext:` path into a 2048pt PDF page. The PDF preserves
 * Apple's full multi-layer rendering (per-layer fill rules, exclusion of
 * sparkles inside a badge cut-out, etc.) — what we miss when reading
 * `outlinePath` directly. PDF bytes flow back on stdout.
 *
 * @param {{ name: string, scope: string, weight?: string, scale?: string }} args
 * @returns {Promise<Uint8Array>}
 */
async function renderSymbolToPdfBytes({ name, scope, weight = 'regular', scale = 'medium' }) {
  const scriptPath = join(tmpdir(), `apple-docs-symbol-pdf-${process.pid}-${tempSuffix()}.swift`)
  await Bun.write(scriptPath, SYMBOL_PDF_SCRIPT)
  try {
    const proc = Bun.spawn(['swift', scriptPath, name, scope, weight, scale], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || `swift exited ${code}`)
    return new Uint8Array(stdout)
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {})
  }
}

/**
 * Convert a single-page SF Symbol PDF into a clean vector SVG. We parse the
 * content stream ourselves (see symbol-pdf-to-svg.js) instead of shelling
 * out to pdftocairo, because Apple encodes layer cut-outs (xmark.bin.circle.fill,
 * health.fill, circle.slash, …) as `/ca 0` ExtGState fills — which any
 * spec-compliant PDF renderer correctly skips, dropping the cut-out geometry
 * we need. Our parser preserves those alpha-0 fills and emits them as SVG
 * `<mask>` cut-outs against the preceding visible layer.
 */
async function finalizeSvgFromPdf(pdfBytes, { name, pointSize, color, background }) {
  return symbolPdfToSvg(pdfBytes, { name, pointSize, color, background })
}

async function renderSymbolSvgFromSnapshot({ name, scope, pointSize, weight, scale, color, background }, ctx) {
  const filePath = getPrerenderedSymbolPath(ctx, scope, name, { weight, scale })
  const file = Bun.file(filePath)
  if (!await file.exists()) return null
  try {
    const svg = await file.text()
    return customizePrerenderedSymbolSvg(svg, { pointSize, color, background })
  } catch (error) {
    ctx.logger?.warn?.(`SF Symbol snapshot SVG read failed for ${scope}/${name}: ${error.message}`)
    return null
  }
}

function customizePrerenderedSymbolSvg(svg, { pointSize, color, background }) {
  let output = setSvgDimensionAttributes(String(svg), pointSize)
  output = replaceVisibleBlackFill(output, color)
  if (background) output = insertSvgBackground(output, background)
  return output
}

function setSvgDimensionAttributes(svg, pointSize) {
  return svg.replace(/<svg\b([^>]*)>/i, (_match, attrs) => {
    let nextAttrs = upsertSvgAttribute(attrs, 'width', pointSize)
    nextAttrs = upsertSvgAttribute(nextAttrs, 'height', pointSize)
    return `<svg${nextAttrs}>`
  })
}

function upsertSvgAttribute(attrs, name, value) {
  const escapedValue = escapeXml(value)
  const attrRe = new RegExp(`\\s${name}=(["'])[^"']*\\1`, 'i')
  if (attrRe.test(attrs)) {
    return attrs.replace(attrRe, ` ${name}="${escapedValue}"`)
  }
  return `${attrs} ${name}="${escapedValue}"`
}

function replaceVisibleBlackFill(svg, color) {
  const escapedColor = escapeXml(color)
  const replaceFill = (chunk) => chunk.replace(/\bfill=(["'])#000000\1/gi, (_match, quote) => `fill=${quote}${escapedColor}${quote}`)
  const maskRe = /<mask\b[\s\S]*?<\/mask>/gi
  let output = ''
  let cursor = 0
  for (const match of svg.matchAll(maskRe)) {
    output += replaceFill(svg.slice(cursor, match.index))
    output += match[0]
    cursor = match.index + match[0].length
  }
  output += replaceFill(svg.slice(cursor))
  return output
}

function insertSvgBackground(svg, background) {
  const rect = svgBackgroundRect(svg, background)
  if (/<defs[\s>]/i.test(svg) && /<\/defs>/i.test(svg)) {
    return svg.replace(/<\/defs>/i, `</defs>\n  ${rect}`)
  }
  return svg.replace(/<svg\b[^>]*>/i, (match) => `${match}\n  ${rect}`)
}

function svgBackgroundRect(svg, background) {
  const box = parseSvgViewBox(svg) ?? { x: 0, y: 0, width: 100, height: 100 }
  return `<rect x="${formatSvgNumber(box.x)}" y="${formatSvgNumber(box.y)}" width="${formatSvgNumber(box.width)}" height="${formatSvgNumber(box.height)}" fill="${escapeXml(background)}"/>`
}

function parseSvgViewBox(svg) {
  const match = svg.match(/\bviewBox=(["'])([^"']+)\1/i)
  if (!match) return null
  const parts = match[2].trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some(value => !Number.isFinite(value))) return null
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
}

function formatSvgNumber(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/u, '')
}

async function renderPngFromSvg(svg, { pointSize }) {
  const dir = await mkdtemp(join(tmpdir(), 'apple-docs-symbol-snapshot-'))
  const svgPath = join(dir, 'symbol.svg')
  const pngPath = join(dir, 'symbol.png')
  const errors = []
  try {
    await Bun.write(svgPath, svg)
    const rsvg = await runRasterCommand(['rsvg-convert', '-w', String(pointSize), '-h', String(pointSize), svgPath, '-o', pngPath])
    if (rsvg.ok) return await readRasterizedPng(pngPath)
    errors.push(`rsvg-convert: ${rsvg.error}`)

    await rm(pngPath, { force: true }).catch(() => {})
    const sips = await runRasterCommand(['/usr/bin/sips', '-s', 'format', 'png', svgPath, '--out', pngPath])
    if (sips.ok) return await readRasterizedPng(pngPath)
    errors.push(`sips: ${sips.error}`)

    throw new Error(errors.join('; '))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function readRasterizedPng(path) {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error('rasterizer did not produce a PNG')
  }
  return await Bun.file(path).arrayBuffer()
}

async function runRasterCommand(args) {
  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) return { ok: false, error: stderr.trim() || stdout.trim() || `exited ${code}` }
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: error.message }
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



function renderFontTextSvgFallback({ fontFamily, text, pointSize }) {
  const height = Math.ceil(pointSize * 1.6)
  const width = Math.max(240, Math.ceil(text.length * pointSize * 0.62))
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(text)}">
  <text x="0" y="${Math.ceil(pointSize * 1.1)}" font-family="${escapeXml(fontFamily)}" font-size="${pointSize}" fill="black">${escapeXml(text)}</text>
</svg>`
}

async function renderFontTextSvgCurves({ fontPath, text, pointSize }) {
  // Stryker disable all
  const script = `
import CoreText
import Foundation
import CoreGraphics

let fontPath = CommandLine.arguments[1]
let text = CommandLine.arguments[2]
let pointSize = CGFloat(Double(CommandLine.arguments[3]) ?? 96)
let url = URL(fileURLWithPath: fontPath)
var error: Unmanaged<CFError>?
CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor],
      let descriptor = descriptors.first,
      let fontName = CTFontDescriptorCopyAttribute(descriptor, kCTFontNameAttribute) as? String
else {
  FileHandle.standardError.write(Data("unable to load font descriptors".utf8))
  exit(2)
}
let font = CTFontCreateWithName(fontName as CFString, pointSize, nil)
let attr = NSAttributedString(string: text, attributes: [kCTFontAttributeName as NSAttributedString.Key: font])
let line = CTLineCreateWithAttributedString(attr)
let runs = CTLineGetGlyphRuns(line) as! [CTRun]

struct Shape {
  let d: String
  let bounds: CGRect
}

var shapes: [Shape] = []
var overall = CGRect.null

func fmt(_ value: CGFloat) -> String {
  let raw = String(format: "%.3f", Double(value))
  var out = raw
  while out.contains(".") && out.hasSuffix("0") { out.removeLast() }
  if out.hasSuffix(".") { out.removeLast() }
  return out
}

func convert(_ p: CGPoint, bounds: CGRect) -> CGPoint {
  CGPoint(x: p.x - bounds.minX, y: bounds.maxY - p.y)
}

for run in runs {
  let runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
  let count = CTRunGetGlyphCount(run)
  var glyphs = Array(repeating: CGGlyph(), count: count)
  var positions = Array(repeating: CGPoint.zero, count: count)
  CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
  CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
  for index in 0..<count {
    guard let path = CTFontCreatePathForGlyph(runFont, glyphs[index], nil) else { continue }
    let offset = positions[index]
    var transform = CGAffineTransform(translationX: offset.x, y: offset.y)
    let translated = path.copy(using: &transform) ?? path
    let bounds = translated.boundingBoxOfPath
    if bounds.isNull || bounds.isEmpty { continue }
    overall = overall.union(bounds)
    var d = ""
    translated.applyWithBlock { elementPointer in
      let element = elementPointer.pointee
      switch element.type {
      case .moveToPoint:
        let p = element.points[0]
        d += "M\\(fmt(p.x)) \\(fmt(p.y)) "
      case .addLineToPoint:
        let p = element.points[0]
        d += "L\\(fmt(p.x)) \\(fmt(p.y)) "
      case .addQuadCurveToPoint:
        let c = element.points[0]
        let p = element.points[1]
        d += "Q\\(fmt(c.x)) \\(fmt(c.y)) \\(fmt(p.x)) \\(fmt(p.y)) "
      case .addCurveToPoint:
        let c1 = element.points[0]
        let c2 = element.points[1]
        let p = element.points[2]
        d += "C\\(fmt(c1.x)) \\(fmt(c1.y)) \\(fmt(c2.x)) \\(fmt(c2.y)) \\(fmt(p.x)) \\(fmt(p.y)) "
      case .closeSubpath:
        d += "Z "
      @unknown default:
        break
      }
    }
    shapes.append(Shape(d: d, bounds: bounds))
  }
}

guard !overall.isNull, !shapes.isEmpty else {
  FileHandle.standardError.write(Data("no glyph outlines".utf8))
  exit(3)
}

let padding = max(4, pointSize * 0.08)
let width = ceil(overall.width + padding * 2)
let height = ceil(overall.height + padding * 2)
var output = "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?>\\n"
output += "<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"\\(fmt(width))\\" height=\\"\\(fmt(height))\\" viewBox=\\"0 0 \\(fmt(width)) \\(fmt(height))\\">\\n"
output += "  <title>\\(text.xmlEscaped)</title>\\n"
output += "  <g fill=\\"black\\">\\n"
for shape in shapes {
  var normalized = ""
  let scanner = PathNormalizer(d: shape.d, bounds: overall, padding: padding, height: height)
  normalized = scanner.normalized()
  output += "    <path d=\\"\\(normalized)\\"/>\\n"
}
output += "  </g>\\n</svg>\\n"
FileHandle.standardOutput.write(Data(output.utf8))

final class PathNormalizer {
  let tokens: [String]
  let bounds: CGRect
  let padding: CGFloat
  let height: CGFloat
  init(d: String, bounds: CGRect, padding: CGFloat, height: CGFloat) {
    self.tokens = d.split(separator: " ").map(String.init)
    self.bounds = bounds
    self.padding = padding
    self.height = height
  }
  func normalized() -> String {
    var out: [String] = []
    var index = 0
    while index < tokens.count {
      let op = tokens[index]
      index += 1
      if op == "Z" {
        out.append("Z")
        continue
      }
      let command = String(op.prefix(1))
      let firstNumber = String(op.dropFirst())
      var nums: [CGFloat] = []
      if let n = Double(firstNumber) { nums.append(CGFloat(n)) }
      let needed: Int
      switch command {
      case "M", "L": needed = 2
      case "Q": needed = 4
      case "C": needed = 6
      default: needed = 0
      }
      while nums.count < needed && index < tokens.count {
        if let n = Double(tokens[index]) { nums.append(CGFloat(n)) }
        index += 1
      }
      var converted: [String] = []
      for i in stride(from: 0, to: nums.count, by: 2) {
        let x = nums[i] - bounds.minX + padding
        let y = height - (nums[i + 1] - bounds.minY + padding)
        converted.append(fmt(x))
        converted.append(fmt(y))
      }
      out.append("\\(command)\\(converted.joined(separator: " "))")
    }
    return out.joined(separator: " ")
  }
}

extension String {
  var xmlEscaped: String {
    self
      .replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\\"", with: "&quot;")
      .replacingOccurrences(of: "'", with: "&apos;")
  }
}
`
  // Stryker restore all
  const scriptPath = join(tmpdir(), `apple-docs-render-font-${process.pid}-${tempSuffix()}.swift`)
  await Bun.write(scriptPath, script)
  try {
    const proc = Bun.spawn(['swift', scriptPath, fontPath, text, String(pointSize)], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || `swift exited ${code}`)
    return stdout
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {})
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

async function hashFile(path) {
  const bytes = await Bun.file(path).arrayBuffer()
  return sha256(bytes)
}

/**
 * Return true if the file at `path` exists and starts with one of the
 * known SFNT (font-container) magic numbers. Used to gate Swift/CoreText
 * spawns: passing a non-font file to CTFontManager is undefined behaviour
 * and observed to wedge the parent process on CI runners.
 *
 * Magic numbers: 0x00010000 (TrueType), `OTTO` (OpenType+CFF), `ttcf`
 * (TrueType Collection), `wOFF` (WOFF), `wOF2` (WOFF2).
 */
async function isLikelySfnt(path) {
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(4)
      const read = readSync(fd, buf, 0, 4, 0)
      if (read < 4) return false
      const tag = buf.toString('ascii')
      if (tag === 'OTTO' || tag === 'ttcf' || tag === 'wOFF' || tag === 'wOF2') return true
      return buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') return [value]
  return []
}

// Apple's typography ships with a fixed vocabulary for both axes. Order
// matters for weight rendering (Ultralight → Black) — the UI uses these
// arrays directly to lay pills out in design order.
const FONT_VARIANTS = ['Display', 'Text', 'Rounded', 'ExtraLarge', 'Large', 'Medium', 'Small']
const FONT_WEIGHTS = ['Ultralight', 'Thin', 'Light', 'Regular', 'Medium', 'Semibold', 'Bold', 'Heavy', 'Black']

const VARIANT_LOOKUP = new Map(FONT_VARIANTS.map(v => [v.toLowerCase(), v]))
const WEIGHT_LOOKUP = new Map(FONT_WEIGHTS.map(w => [w.toLowerCase(), w]))

/**
 * Parse an Apple font file name into structured fields.
 * Examples:
 *   SF-Pro-Display-BoldItalic.otf  → { variant: 'Display', weight: 'Bold', italic: true }
 *   SF-Pro-Italic.ttf              → { variant: null, weight: null, italic: true }
 *   NewYorkSmall-RegularItalic.otf → { variant: 'Small', weight: 'Regular', italic: true }
 *   SF-Mono-Bold.otf               → { variant: null, weight: 'Bold', italic: false }
 *   SF-Pro.ttf                     → { variant: null, weight: null, italic: false }
 */
export function parseFontFilename(fileName) {
  const stem = basename(fileName, extname(fileName))
  // Tail token: weight or weightItalic (after the last dash, or no dash).
  const dashIndex = stem.lastIndexOf('-')
  const tail = dashIndex === -1 ? stem : stem.slice(dashIndex + 1)
  let italic = false
  let weight = null
  let trailingWeightToken = ''

  // Try to peel "Italic" off the right side of the trailing token first.
  if (/Italic$/i.test(tail)) {
    italic = true
    trailingWeightToken = tail.slice(0, -'Italic'.length)
  } else {
    trailingWeightToken = tail
  }
  if (trailingWeightToken) {
    weight = WEIGHT_LOOKUP.get(trailingWeightToken.toLowerCase()) ?? null
  }

  // Variant is the second-to-last token (or attached to the head: NewYorkSmall).
  let variant = null
  if (weight !== null && dashIndex !== -1) {
    const head = stem.slice(0, dashIndex)
    const headTail = head.slice(head.lastIndexOf('-') + 1)
    variant = VARIANT_LOOKUP.get(headTail.toLowerCase()) ?? null
    if (variant === null) {
      // Variant may be glued to the family prefix, e.g. NewYorkSmall.
      for (const candidate of FONT_VARIANTS) {
        if (head.toLowerCase().endsWith(candidate.toLowerCase())) {
          variant = candidate
          break
        }
      }
    }
  } else if (weight === null && italic === false) {
    // Bare files like NewYork.ttf, SF-Pro.ttf — no weight token, no variant.
    variant = null
  } else {
    // Italic-only files like SF-Pro-Italic.ttf — no variant.
    variant = null
  }

  return { variant, weight, italic }
}

/**
 * Read the OpenType/TrueType table directory of a font file and report
 * variability. Returns `{ isVariable, axes }` — `axes` is empty for static
 * fonts and an array of `{ tag, min, default, max }` entries for variable
 * fonts. Best-effort: any parse error returns the static defaults.
 */
export function inspectSfntFile(filePath) {
  try {
    const buffer = readSfntHeader(filePath)
    if (!buffer) return { isVariable: false, axes: [] }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const numTables = view.getUint16(4)
    if (numTables === 0 || numTables > 256) return { isVariable: false, axes: [] }
    let fvarOffset = -1
    let fvarLength = 0
    for (let i = 0; i < numTables; i++) {
      const entry = 12 + i * 16
      if (entry + 16 > view.byteLength) break
      const tag = String.fromCharCode(
        view.getUint8(entry),
        view.getUint8(entry + 1),
        view.getUint8(entry + 2),
        view.getUint8(entry + 3),
      )
      if (tag === 'fvar') {
        fvarOffset = view.getUint32(entry + 8)
        fvarLength = view.getUint32(entry + 12)
        break
      }
    }
    if (fvarOffset < 0) return { isVariable: false, axes: [] }
    const fvar = readBytes(filePath, fvarOffset, fvarLength)
    if (!fvar) return { isVariable: false, axes: [] }
    const fvarView = new DataView(fvar.buffer, fvar.byteOffset, fvar.byteLength)
    const offsetToAxes = fvarView.getUint16(4)
    const axisCount = fvarView.getUint16(8)
    const axisSize = fvarView.getUint16(10)
    if (axisCount === 0 || axisSize < 20) return { isVariable: true, axes: [] }
    const axes = []
    for (let i = 0; i < axisCount; i++) {
      const start = offsetToAxes + i * axisSize
      if (start + 20 > fvarView.byteLength) break
      const tag = String.fromCharCode(
        fvarView.getUint8(start),
        fvarView.getUint8(start + 1),
        fvarView.getUint8(start + 2),
        fvarView.getUint8(start + 3),
      )
      const min = fvarView.getInt32(start + 4) / 65536
      const def = fvarView.getInt32(start + 8) / 65536
      const max = fvarView.getInt32(start + 12) / 65536
      axes.push({ tag, min, default: def, max })
    }
    return { isVariable: true, axes }
  } catch {
    return { isVariable: false, axes: [] }
  }
}

function readSfntHeader(filePath) {
  // Need at least 12 bytes (offset table) + numTables × 16. 16 KB is plenty
  // for any real font's directory and avoids reading the whole file just to
  // peek at the header.
  const head = readBytes(filePath, 0, 12)
  if (!head) return null
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const scaler = headView.getUint32(0)
  // Reject TrueType collections (`ttcf` = 0x74746366) — they wrap multiple
  // sfnt fonts and need a different walk; the variable detection isn't
  // worth the complexity for our corpus (Apple ships static .ttc only).
  if (scaler === 0x74746366) return null
  const numTables = headView.getUint16(4)
  return readBytes(filePath, 0, 12 + numTables * 16)
}

function readBytes(filePath, offset, length) {
  if (length <= 0) return null
  const buffer = Buffer.alloc(length)
  const fd = openSync(filePath, 'r')
  try {
    readSync(fd, buffer, 0, length, offset)
    return buffer
  } finally {
    closeSync(fd)
  }
}

function sanitizeFileName(value) {
  return String(value).replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'asset'
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return min
  return Math.min(Math.max(parsed, min), max)
}

function normalizeColor(value) {
  const raw = String(value ?? '#000000').trim()
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(raw) ? raw : '#000000'
}

function normalizeBackground(value) {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw || raw === 'transparent' || raw === 'none') return null
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(raw) ? raw : null
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export const _test = {
  customizePrerenderedSymbolSvg,
  normalizeSymbolScale,
  normalizeSymbolWeight,
  symbolRendererVersion: SYMBOL_RENDERER_VERSION,
  symbolSnapshotNeedsReset,
  symbolVariantMatrix,
}
