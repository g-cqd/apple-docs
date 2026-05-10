/**
 * Worker fan-out for src/web/build.js. Partitions the framework list
 * across N child Bun subprocesses, each rendering its own slice.
 */

import { join } from 'node:path'
import { dirname } from 'node:path'

function partitionFrameworksByDocCount(roots, db, n) {
  const counts = roots.map(root => ({
    root,
    count: db.db.query('SELECT COUNT(*) as c FROM documents WHERE framework = ?').get(root.slug).c,
  }))
  counts.sort((a, b) => b.count - a.count)
  const bins = Array.from({ length: n }, () => ({ slugs: [], total: 0 }))
  for (const { root, count } of counts) {
    if (count === 0) continue
    const smallest = bins.reduce((acc, b) => (b.total < acc.total ? b : acc), bins[0])
    smallest.slugs.push(root.slug)
    smallest.total += count
  }
  return bins.filter(b => b.slugs.length > 0)
}

/**
 * Spawn N child Bun processes, each running `apple-docs web build` on its
 * partition of the framework list. Returns aggregated counts after every
 * child exits.
 *
 * Children inherit stdio so progress / failure log lines surface
 * immediately. The orchestrator does NOT render anything itself in this
 * mode; framework-listing pages (step 6) and the global steps (search
 * artifacts, sitemap, manifest) still run in the orchestrator after the
 * children finish.
 *
 * @param {object} args
 * @param {Array}  args.roots          Filtered framework list to fan out across.
 * @param {object} args.opts           Original `buildStaticSite` opts (forwarded selectively).
 * @param {object} args.siteConfig
 * @param {number} args.workers        Number of subprocesses to spawn.
 * @param {number} args.concurrency    Per-process pool concurrency.
 * @param {string} args.outDir
 * @param {import('../../storage/database.js').DocsDatabase} args.db  For doc-count partitioning.
 * @param {object} [args.logger]
 */
export async function runWorkerBuilds({ roots, opts, siteConfig, workers, concurrency, outDir, db, logger }) {
  const bins = partitionFrameworksByDocCount(roots, db, workers)
  if (bins.length === 0) {
    return { pagesBuilt: 0, pagesSkipped: 0, pagesFailed: 0 }
  }
  const totalDocs = bins.reduce((s, b) => s + b.total, 0)
  logger?.info?.(
    `Fan-out: ${bins.length} workers × ${concurrency} concurrency · ${totalDocs.toLocaleString('en-US')} docs partitioned across ${bins.map(b => b.total.toLocaleString('en-US')).join(', ')}`
  )

  // Resolve the CLI entrypoint relative to this module so worker processes
  // run the same checkout (no PATH lookup, no system-wide CLI surprises).
  const here = dirname(new URL(import.meta.url).pathname)
  const cliJs = join(here, '..', '..', 'cli.js')
  const bunBin = process.execPath || Bun.argv?.[0] || 'bun'

  const procs = bins.map((bin, i) => {
    const args = [
      'run', cliJs, 'web', 'build',
      '--out', outDir,
      '--frameworks', bin.slugs.join(','),
      '--concurrency', String(concurrency),
      '--workers', '1',
      '--incremental',
    ]
    if (siteConfig.baseUrl) { args.push('--base-url', siteConfig.baseUrl) }
    if (siteConfig.siteName) { args.push('--site-name', siteConfig.siteName) }
    // Don't pass `--full` to workers. The orchestrator already cleared the
    // render index. Workers must run in incremental mode so they write
    // directly to the shared `outDir` (= the orchestrator's staging dir)
    // instead of each spinning up its own staging dir + atomic swap, which
    // would race-replace the orchestrator's output.
    logger?.info?.(`worker[${i + 1}/${bins.length}] starting (${bin.slugs.length} frameworks, ${bin.total.toLocaleString('en-US')} docs): ${bin.slugs.slice(0, 4).join(', ')}${bin.slugs.length > 4 ? '…' : ''}`)
    return Bun.spawn([bunBin, ...args], {
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env, APPLE_DOCS_BUILD_WORKER: '1' },
    })
  })

  const exits = await Promise.all(procs.map(p => p.exited))
  const failedCount = exits.filter(c => c !== 0).length
  if (failedCount > 0) {
    throw new Error(`${failedCount}/${exits.length} build worker(s) exited non-zero`)
  }

  // Re-read counts from the render-index for an honest aggregate. We don't
  // attempt to recover a per-worker breakdown — the children already
  // streamed their summaries to stdout.
  const counts = db.db.query(
    `SELECT COUNT(*) AS built FROM document_render_index ri
     JOIN documents d ON d.id = ri.doc_id
     WHERE d.framework IN (${bins.flatMap(b => b.slugs).map(() => '?').join(',')})`
  ).get(...bins.flatMap(b => b.slugs))
  return {
    pagesBuilt: counts?.built ?? 0,
    pagesSkipped: 0,
    pagesFailed: 0,
  }
}

/**
 * Brotli-precompress an output file when it crosses the size threshold, so
 * Caddy's `precompressed br` mode can ship the sidecar directly without
 * repeating brotli at request time.
 *
 * Quality 11 is the maximum and gives 3–10 % smaller outputs than runtime
 * `encode` (which defaults to ~quality 4). The build cost is acceptable
 * because every page either misses the threshold (skipped) or is rendered
 * at most once per deploy thanks to the incremental render index.
 */
