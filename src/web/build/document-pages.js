// Per-document HTML render loop — the hottest path of the build. Sync
// shiki render, chunked sections fetch, render-index incremental skip,
// sidecar failure log. Each framework runs through here; the
// orchestrator dispatches in single-process or worker-fanout mode
// upstream.

import { existsSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sha256 } from '../../lib/hash.js'
import { pool } from '../../lib/pool.js'
import { safeWebDocKey } from '../../lib/safe-path.js'
import { ensureDir } from '../../storage/files.js'
import { renderDocumentPage } from '../templates.js'
import { batchFetchSections, computeSectionsDigest } from './checkpoint.js'
import { maybePrecompress } from './io.js'
import { renderSkiplistPlaceholder, renderWithTimeout } from './render-helpers.js'

/**
 * Build every document page in `roots` into `buildDir/docs/<key>/index.html`.
 * Mutates `counters` in place (pagesBuilt / pagesSkipped / pagesFailed) so
 * the orchestrator can fold this into other render passes.
 *
 * @param {object} args
 * @param {Array<{slug: string}>} args.roots
 * @param {object} args.db
 * @param {string} args.buildDir
 * @param {object} args.siteConfig
 * @param {object} args.renderCache
 * @param {Set<string>} args.knownKeys
 * @param {Set<string>} args.skipList
 * @param {number} args.renderTimeoutMs
 * @param {number} args.concurrency
 * @param {boolean} args.incremental
 * @param {string} args.templateVersion
 * @param {{ pagesBuilt: number, pagesSkipped: number, pagesFailed: number }} args.counters
 * @param {() => void} args.tickProgress
 * @param {object} [args.logger]
 * @param {string} args.failuresPath
 */
export async function buildDocumentPages({
  roots,
  db,
  buildDir,
  siteConfig,
  renderCache,
  knownKeys,
  skipList,
  renderTimeoutMs,
  concurrency,
  incremental,
  templateVersion,
  counters,
  tickProgress,
  logger,
  failuresPath,
}) {
  for (const root of roots) {
    const docs = db.db
      .query(
        `SELECT d.id, d.key, d.title, d.kind, d.role, d.role_heading, d.framework,
              d.abstract_text, d.source_type, d.language, d.url,
              d.platforms_json, d.is_deprecated, d.is_beta,
              COALESCE(r.display_name, d.framework) as framework_display
       FROM documents d LEFT JOIN roots r ON r.slug = d.framework
       WHERE d.framework = ?
       ORDER BY d.id`,
      )
      .all(root.slug)

    if (docs.length === 0) continue

    // Batched sections fetch: one query per chunk of doc IDs (mirrors the
    // index-body pipeline at src/pipeline/index-body.js:44). Drops 346 K
    // queries to ~700 in the production corpus.
    const sectionsByDoc = db.hasTable('document_sections')
      ? batchFetchSections(
          db,
          docs.map((d) => d.id),
          500,
        )
      : new Map()

    await pool(docs, concurrency, async (doc) => {
      const sections = sectionsByDoc.get(doc.id) ?? []
      const sectionsDigest = computeSectionsDigest(sections)
      // safeWebDocKey keeps overlong Swift init segments under the 255-byte
      // filesystem component limit; the live route resolves the same hashed
      // path, so canonical URLs stay identical between live and static.
      const filePath = join(buildDir, 'docs', ...safeWebDocKey(doc.key).split('/'), 'index.html')

      // Incremental skip. Two-tier:
      //   1. The render-index says nothing changed since the last
      //      successful render *and* the on-disk file is there → skip.
      //   2. The render-index is stale or missing but the on-disk file is
      //      still there and the sections haven't changed → also skip.
      //      Template-version churn alone (e.g. tweaking a copy line in
      //      templates.js between deploys) doesn't justify re-rendering
      //      346 K pages each time. `--full` is the explicit lever for
      //      that case.
      //
      // Either path persists the matching render-index entry under the
      // current template version so subsequent incremental runs hit the
      // fast path 1.
      if (incremental && existsSync(filePath)) {
        const cached = db.getRenderIndexEntry(doc.id)
        if (cached?.sections_digest === sectionsDigest) {
          if (cached.template_version !== templateVersion) {
            db.upsertRenderIndexEntry({
              docId: doc.id,
              sectionsDigest,
              templateVersion,
              htmlHash: cached.html_hash,
            })
          }
          counters.pagesSkipped++
          tickProgress()
          return
        }
      }

      try {
        // Skiplist entries get a tombstone page so the rest of the build
        // can proceed without wedging on a single bad input.
        const rendered = skipList.has(doc.key)
          ? renderSkiplistPlaceholder(doc, siteConfig)
          : await renderWithTimeout(
              () =>
                renderDocumentPage(doc, sections, siteConfig, {
                  knownKeys,
                  ancestorTitles: renderCache.getAncestorTitles(doc.key),
                  resolveRoleHeadings: (keys) => renderCache.getRoleHeadings(keys),
                }),
              renderTimeoutMs,
            )

        // renderDocumentPage returns HtmlString; renderSkiplistPlaceholder
        // returns a plain string. Coerce to Uint8Array bytes once and
        // hand the same buffer to write + precompress + hash so we only
        // pay one UTF-8 encode per page instead of three.
        const html = typeof rendered === 'string' ? Buffer.from(rendered) : rendered.bytes()

        ensureDir(dirname(filePath))
        await Bun.write(filePath, html)
        await maybePrecompress(filePath, html)

        db.upsertRenderIndexEntry({
          docId: doc.id,
          sectionsDigest,
          templateVersion,
          htmlHash: sha256(html).slice(0, 16),
        })
        counters.pagesBuilt++
      } catch (err) {
        counters.pagesFailed++
        logger?.warn?.(`Failed to build page ${doc.key}: ${err.message}`)
        // Persist failures to a sidecar log; the build run should not abort
        // because of a single bad doc.
        try {
          await appendFile(
            failuresPath,
            `${JSON.stringify({
              t: new Date().toISOString(),
              doc_id: doc.id,
              key: doc.key,
              error: err.message,
            })}\n`,
          )
        } catch {
          // best-effort; never let logging fail a build
        }
      } finally {
        tickProgress()
      }
    })
  }
}
