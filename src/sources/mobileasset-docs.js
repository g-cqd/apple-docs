/**
 * Offline enrichment source: Xcode's Developer Documentation MobileAsset
 * (`com.apple.MobileAsset.AppleDeveloperDocumentation`).
 *
 * Xcode 27 downloads a vector-search corpus to
 * `/System/Library/AssetsV2/com_apple_MobileAsset_AppleDeveloperDocumentation/
 *  <sha1>.asset/AssetData/documentation-db/index.sql` — a SQLite DB with one
 * JSON blob per page (`documents`) and rendered-Markdown chunks
 * (`attributes`). The page JSON carries two things the crawled RenderJSON
 * never exposes: the symbol's USR (`external_id`) and structured per-platform
 * `introduced`/`deprecated` data. (Apple's own embeddings ride along too but
 * use a proprietary model incompatible with ours, so the vectors are unused.)
 *
 * Merge discipline (duplication-safe by construction):
 *   1. ENRICH the keyed intersection — `UPDATE … WHERE key = ?`, never insert:
 *      backfill `usr` (always when NULL) and `platforms_json` + min_* columns
 *      (only when NULL — the crawl stays authoritative when it has data).
 *   2. INSERT every page whose exact key is absent from the corpus. Exact-key
 *      matching already prevents page-level dups; measuring the corpus showed
 *      0% of "parent exists" pages are stored as a section of that parent, so
 *      no parent/child suppression is applied — those were real, missing pages.
 *   3. SKIP `#anchor` rows entirely: they are section groupings of pages the
 *      corpus already stores as `document_sections`.
 *
 * The asset DB is opened read-only + immutable; nothing under /System is ever
 * written. Re-running is idempotent (NULL-guarded updates, keyed upserts).
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { encodeVersion } from '../lib/version-encode.js'

export const DEFAULT_ASSET_ROOT =
  '/System/Library/AssetsV2/com_apple_MobileAsset_AppleDeveloperDocumentation'

// Apple platform display names → the project's platforms_json keys.
const PLATFORM_KEYS = {
  'iOS': 'ios',
  'iPadOS': 'ipados',
  'Mac Catalyst': 'maccatalyst',
  'macOS': 'macos',
  'tvOS': 'tvos',
  'visionOS': 'visionos',
  'watchOS': 'watchos',
}

/** List installed documentation assets, best (most documents) first. */
export function findDocumentationAssets(rootDir = DEFAULT_ASSET_ROOT) {
  if (!existsSync(rootDir)) return []
  const out = []
  for (const entry of readdirSync(rootDir)) {
    if (!entry.endsWith('.asset')) continue
    const dbPath = join(rootDir, entry, 'AssetData', 'documentation-db', 'index.sql')
    if (!existsSync(dbPath)) continue
    try {
      const db = openAssetDb(dbPath)
      const docs = db.query('SELECT COUNT(*) AS c FROM documents').get().c
      db.close()
      out.push({ assetPath: join(rootDir, entry), dbPath, docs })
    } catch { /* unreadable asset — skip */ }
  }
  return out.sort((a, b) => b.docs - a.docs)
}

/** Read-only, immutable open — never touches WAL/SHM under /System. */
export function openAssetDb(dbPath) {
  return new Database(`file:${dbPath}?immutable=1`, { readonly: true })
}

/** `/documentation/SwiftUI/View` → `swiftui/view` (the project's key shape). */
export function normalizeAssetUri(uri) {
  let s = String(uri).replace(/^\//, '')
  if (s.toLowerCase().startsWith('documentation/')) s = s.slice('documentation/'.length)
  return s.toLowerCase()
}

/** Apple `platforms[]` → { platformsJson, minIos, … } in project shape. */
export function platformsToProject(platforms) {
  if (!Array.isArray(platforms) || platforms.length === 0) return null
  const map = {}
  const mins = {}
  for (const p of platforms) {
    const key = PLATFORM_KEYS[p?.platform]
    if (!key || p.introduced == null) continue
    const text = formatVersion(p.introduced)
    if (!text) continue
    map[key] = text
    mins[key] = text
  }
  if (Object.keys(map).length === 0) return null
  return {
    platformsJson: JSON.stringify(map),
    minIos: mins.ios ?? null,
    minMacos: mins.macos ?? null,
    minWatchos: mins.watchos ?? null,
    minTvos: mins.tvos ?? null,
    minVisionos: mins.visionos ?? null,
  }
}

/** 13 → "13.0", 10.15 → "10.15" (matches the crawl's version strings). */
function formatVersion(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Number.isInteger(n) ? `${n}.0` : String(n)
}

function languageFromUsr(usr) {
  if (typeof usr !== 'string') return null
  if (usr.startsWith('s:')) return 'swift'
  if (usr.startsWith('c:')) return 'occ'
  return null
}

/**
 * Run the merge against an open project DocsDatabase.
 *
 * @param {object} projectDb DocsDatabase (schema ≥ v26)
 * @param {string} assetDbPath the asset's index.sql
 * @param {{ apply?: boolean, logger?: object, sourceTag?: string }} [opts]
 *   `apply: false` (default) computes counts without writing.
 * @returns {{ pages: number, anchorsSkipped: number, usrBackfilled: number,
 *   platformsBackfilled: number, novelInserted: number }}
 */
export function enrichFromAsset(projectDb, assetDbPath, { apply = false, logger, sourceTag = 'xcode-mobileasset' } = {}) {
  const asset = openAssetDb(assetDbPath)
  const raw = projectDb.db

  const existing = new Map() // key → { id, hasPlatforms, hasUsr }
  for (const r of raw.query('SELECT id, key, platforms_json IS NOT NULL AS hp, usr IS NOT NULL AS hu FROM documents').all()) {
    existing.set(r.key, { id: r.id, hasPlatforms: !!r.hp, hasUsr: !!r.hu })
  }

  const setUsr = raw.query('UPDATE documents SET usr = $usr WHERE id = $id AND usr IS NULL')
  const setUsrById = raw.query('UPDATE documents SET usr = $usr WHERE id = $id')
  const setPlatforms = raw.query(`UPDATE documents SET
      platforms_json = $pj,
      min_ios = $ios, min_macos = $macos, min_watchos = $watchos, min_tvos = $tvos, min_visionos = $visionos,
      min_ios_num = $iosn, min_macos_num = $macosn, min_watchos_num = $watchosn, min_tvos_num = $tvosn, min_visionos_num = $visionosn
    WHERE id = $id AND platforms_json IS NULL`)
  const chunksFor = asset.query(
    'SELECT title, content FROM attributes WHERE asset_id = ? ORDER BY chunk_index',
  )

  const stats = { pages: 0, anchorsSkipped: 0, usrBackfilled: 0, platformsBackfilled: 0, novelInserted: 0 }
  const novel = []
  const BATCH = 5000
  let inTxn = false
  const begin = () => { if (apply && !inTxn) { raw.run('BEGIN'); inTxn = true } }
  const commit = () => { if (apply && inTxn) { raw.run('COMMIT'); inTxn = false } }

  try {
    let sinceCommit = 0
    for (const row of asset.query('SELECT asset_id, CAST(document AS TEXT) AS document FROM documents').all()) {
      if (row.asset_id.includes('#')) { stats.anchorsSkipped++; continue }
      stats.pages++
      const key = normalizeAssetUri(row.asset_id)
      let doc
      try { doc = JSON.parse(row.document) } catch { continue }
      const usr = doc.external_id ?? doc.symbol?.preciseIdentifier ?? null
      const hit = existing.get(key)

      if (hit) {
        begin()
        if (usr && !hit.hasUsr) {
          if (apply) setUsr.run({ $usr: usr, $id: hit.id })
          stats.usrBackfilled++
        }
        if (!hit.hasPlatforms) {
          const plat = platformsToProject(doc.platforms)
          if (plat) {
            if (apply) {
              setPlatforms.run({
                $pj: plat.platformsJson,
                $ios: plat.minIos, $macos: plat.minMacos, $watchos: plat.minWatchos,
                $tvos: plat.minTvos, $visionos: plat.minVisionos,
                $iosn: encodeVersion(plat.minIos), $macosn: encodeVersion(plat.minMacos),
                $watchosn: encodeVersion(plat.minWatchos), $tvosn: encodeVersion(plat.minTvos),
                $visionosn: encodeVersion(plat.minVisionos),
                $id: hit.id,
              })
            }
            stats.platformsBackfilled++
          }
        }
        if (++sinceCommit >= BATCH) { commit(); sinceCommit = 0 }
        continue
      }

      novel.push({ key, uri: row.asset_id, doc, usr })
    }
    commit()

    // Pass 2 — truly-novel inserts, routed through the normal upsert so FTS
    // triggers, sections, and key uniqueness behave exactly like a crawl.
    begin()
    for (const n of novel) {
      // Slug from the URI's first segment — always consistent with the doc
      // key/browse tree. `modules[0]` is a display name and may contain
      // spaces ("Apple News Format"), so it is never used as a slug.
      const framework = n.key.split('/')[0] || null
      const plat = platformsToProject(n.doc.platforms) ?? {}
      const sections = []
      let title = n.doc.fileName ?? n.key.split('/').pop()
      for (const [i, c] of chunksFor.all(n.uri).entries()) {
        if (i === 0 && c.title) title = c.title
        sections.push({ sectionKind: 'discussion', heading: c.title ?? null, contentText: c.content ?? '', sortOrder: i })
      }
      stats.novelInserted++
      if (!apply) continue
      if (framework) {
        try { projectDb.upsertRoot(framework, n.doc.modules?.[0] ?? framework, 'framework', sourceTag) } catch { /* exists */ }
      }
      const documentId = projectDb.upsertNormalizedDocument({
        document: {
          sourceType: 'apple-docc',
          key: n.key,
          title,
          kind: n.doc.kind ?? null,
          role: n.doc.role ?? null,
          roleHeading: n.doc.roleHeading ?? null,
          framework,
          url: `https://developer.apple.com${n.uri}`,
          language: languageFromUsr(n.usr),
          platformsJson: plat.platformsJson ?? null,
          minIos: plat.minIos ?? null,
          minMacos: plat.minMacos ?? null,
          minWatchos: plat.minWatchos ?? null,
          minTvos: plat.minTvos ?? null,
          minVisionos: plat.minVisionos ?? null,
          sourceMetadata: { enrichedFrom: sourceTag },
        },
        sections,
        relationships: [],
      })
      if (n.usr) setUsrById.run({ $usr: n.usr, $id: documentId })
    }
    commit()
  } finally {
    if (inTxn) { try { raw.run('ROLLBACK') } catch { /* already closed */ } }
    asset.close()
  }

  logger?.info?.(
    `xcode-docs merge${apply ? '' : ' (dry-run)'}: ${stats.usrBackfilled} USRs, ` +
    `${stats.platformsBackfilled} platform backfills, ${stats.novelInserted} novel pages ` +
    `(${stats.anchorsSkipped} section anchors skipped)`,
  )
  return stats
}
