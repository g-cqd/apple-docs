/**
 * SF Symbol prerender execution engine — the two render paths a scope
 * bucket can take, split out of sync.js to keep that file under the
 * 400-line ceiling.
 *
 *   - renderScopeBucketNative : RFC 0003 phase 2 — one in-dylib batch
 *       render per chunk (concurrentPerform across cores); the pool
 *       classifies the rare nulls.
 *   - renderScopeBucket       : the long-lived `swift` worker pool
 *       (one process per scope), the fallback and non-darwin path.
 *
 * Both funnel every rendered PDF through the same writeSymbolSvg, so the
 * on-disk output and the rendered/skipped/failed accounting are identical
 * regardless of where the PDF came from.
 */

import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ValidationError } from '../../lib/errors.js'
import { ensureDir } from '../../storage/files.js'
import { nativeSymbolPdfBatch } from '../render-native.js'
import { SYMBOL_WORKER_SCRIPT } from '../swift-templates.js'
import { symbolPdfToSvg } from '../symbol-pdf-to-svg.js'
import { getPrerenderedSymbolPath } from './cache-key.js'

export const SYMBOL_DEFAULT_RENDER_SIZE = 128

// Symbols per batched FFI render call (RFC 0003 phase 2). Bounds the result
// buffer + peak RSS while staying well above the dylib's concurrentPerform
// threshold so each chunk fans out across all cores.
const NATIVE_CHUNK = 256

export async function renderScopeBucket({ scope, symbols, variants, ctx, concurrency, logger, onProgress, result }) {
  const queue = []
  for (const symbol of symbols) {
    for (const variant of variants) queue.push({ symbol, ...variant })
  }
  await drainQueueWithPool({ scope, queue, ctx, concurrency, logger, onProgress, result })
}

// RFC 0003 phase 2: render the bucket through the in-dylib batch export
// (one process, concurrentPerform across cores) instead of 4–16 spawned
// workers. Symbols the native path can't draw come back null (bitmap-only /
// failures) and are funnelled to the pool, which classifies them exactly as
// before; a whole-chunk null (native unavailable mid-run) degrades likewise.
export async function renderScopeBucketNative({ scope, symbols, variants, ctx, concurrency, logger, onProgress, result }) {
  const queue = []
  for (const symbol of symbols) {
    for (const variant of variants) {
      const filePath = getPrerenderedSymbolPath({ dataDir: ctx.dataDir }, scope, symbol.name, variant)
      if (existsSync(filePath) && statSync(filePath).size > 0) {
        result.skipped++
        onProgress?.(result)
        continue
      }
      queue.push({ symbol, ...variant })
    }
  }
  const fallback = []
  for (let i = 0; i < queue.length; i += NATIVE_CHUNK) {
    const chunk = queue.slice(i, i + NATIVE_CHUNK)
    const pdfs = nativeSymbolPdfBatch(chunk.map((item) => ({ name: item.symbol.name, scope, weight: item.weight, scale: item.scale })))
    if (pdfs === null) {
      for (const item of chunk) fallback.push(item)
      continue
    }
    const writes = []
    for (let j = 0; j < chunk.length; j++) {
      if (pdfs[j]) writes.push(writeSymbolSvg({ ctx, scope, item: chunk[j], pdfBytes: pdfs[j], logger, result, onProgress }))
      else fallback.push(chunk[j])
    }
    await Promise.all(writes)
  }
  if (fallback.length) {
    await drainQueueWithPool({ scope, queue: fallback, ctx, concurrency, logger, onProgress, result })
  }
}

async function drainQueueWithPool({ scope, queue, ctx, concurrency, logger, onProgress, result }) {
  const workers = []
  const startWorker = () => spawnSymbolWorker({ scope, logger })
  for (let i = 0; i < concurrency; i++) {
    const worker = await startWorker()
    workers.push(processSymbolQueue({ worker, queue, ctx, scope, result, onProgress, logger, restart: startWorker }))
  }
  await Promise.all(workers)
}

// PDF → theme-neutral SVG → disk + the rendered/failed accounting, shared by
// the native batch path and the pooled worker path (the PDF source differs;
// everything downstream is identical).
async function writeSymbolSvg({ ctx, scope, item, pdfBytes, logger, result, onProgress }) {
  const { symbol, weight, scale } = item
  const filePath = getPrerenderedSymbolPath({ dataDir: ctx.dataDir }, scope, symbol.name, { weight, scale })
  try {
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
    // Parser failure — the SVG conversion choked; the PDF source is fine.
    const msg = error.message ?? String(error)
    logger?.warn?.(`Pre-render failed for ${scope}/${symbol.name} (${weight}/${scale}): ${msg}`)
    result.failed++
    result.failures.push({ scope, name: symbol.name, weight, scale, error: msg })
  }
  onProgress?.(result)
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
        try {
          ctx.db.markSfSymbolBitmapOnly(scope, symbol.name)
        } catch {}
      } else {
        logger?.warn?.(`Pre-render failed for ${scope}/${symbol.name} (${weight}/${scale}): ${msg}`)
        result.failed++
        result.failures.push({ scope, name: symbol.name, weight, scale, error: msg })
        // Worker actually died (broken pipe, crash, etc.) — restart.
        try {
          activeWorker.close()
        } catch {}
        activeWorker = await restart()
      }
      onProgress?.(result)
      continue
    }

    // Pre-rendered SVGs serve both as <img src> targets and as CSS
    // `mask-image` sources for the grid tiles (where the browser reads only
    // the alpha channel, so `currentColor` would yield zero coverage). Bake
    // an opaque color in so the mask is solid; the API route swaps it when
    // the caller asks for an explicit foreground. A parser failure here is
    // the SVG conversion, not the worker — no restart (writeSymbolSvg
    // records the failure).
    await writeSymbolSvg({ ctx, scope, item: { symbol, weight, scale }, pdfBytes, logger, result, onProgress })
  }
  try {
    activeWorker.close()
  } catch {}
}

async function spawnSymbolWorker({ scope, logger }) {
  // Per-worker mkdtemp staging dir so the Swift script lives at an
  // unguessable, mode-0700 path. The dir is torn down in close().
  const stagingDir = await mkdtemp(join(tmpdir(), 'apple-docs-symbol-worker-'))
  const scriptPath = join(stagingDir, 'symbol-worker.swift')
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
      if (done) throw new ValidationError('worker exited')
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
            throw new ValidationError(new TextDecoder().decode(payload) || 'worker error')
          }
          return payload
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`symbol worker frame timeout after 30s for ${scope}/${name}`)), 30_000)),
      ])
    },
    close() {
      try {
        proc.stdin.end?.()
      } catch {}
      try {
        proc.kill()
      } catch {}
      void rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}
