/**
 * SF Symbols repository: catalog rows, the FTS5 search index, and the
 * persistent render cache. Schema lives in migrations v10 (initial) and
 * v11 (rebuild fts table). The render cache is keyed by sha-256 of the
 * full parameter set so a renderer-version bump produces a fresh row.
 */

import { buildResourceFtsQuery, parseJsonArray, parseJsonValue } from '../_helpers.js'

function normalizeSfSymbolRow(row) {
  return {
    ...row,
    categories: parseJsonArray(row.categories_json),
    keywords: parseJsonArray(row.keywords_json),
    aliases: parseJsonArray(row.aliases_json),
    availability: parseJsonValue(row.availability_json),
  }
}

export function createAssetsSymbolsRepo(db) {
  const upsertSymbolStmt = db.query(`
    INSERT INTO sf_symbols (
      name, scope, categories_json, keywords_json, aliases_json,
      availability_json, order_index, bundle_path, bundle_version, updated_at
    )
    VALUES (
      $name, $scope, $categories_json, $keywords_json, $aliases_json,
      $availability_json, $order_index, $bundle_path, $bundle_version, $updated_at
    )
    ON CONFLICT(scope, name) DO UPDATE SET
      categories_json = excluded.categories_json,
      keywords_json = excluded.keywords_json,
      aliases_json = excluded.aliases_json,
      availability_json = excluded.availability_json,
      order_index = excluded.order_index,
      bundle_path = excluded.bundle_path,
      bundle_version = excluded.bundle_version,
      updated_at = excluded.updated_at
  `)
  const deleteFtsStmt = db.query(
    'DELETE FROM sf_symbols_fts WHERE rowid = (SELECT rowid FROM sf_symbols WHERE scope = ? AND name = ?)',
  )
  const getRowidStmt = db.query('SELECT rowid FROM sf_symbols WHERE scope = ? AND name = ?')
  const insertFtsStmt = db.query(
    'INSERT INTO sf_symbols_fts(rowid, name, keywords, categories, aliases) VALUES (?, ?, ?, ?, ?)',
  )
  const getSymbolStmt = db.query('SELECT * FROM sf_symbols WHERE scope = ? AND name = ?')
  const listCatalogStmt = db.query(`
    SELECT name, scope, categories_json, keywords_json
    FROM sf_symbols
    ORDER BY scope, COALESCE(order_index, 999999), name
  `)
  // Search variants — empty query, FTS hit, fallback LIKE.
  const searchEmptyStmt = db.query(`
    SELECT * FROM sf_symbols
    WHERE ($scope IS NULL OR scope = $scope)
    ORDER BY scope, COALESCE(order_index, 999999), name
    LIMIT $limit
  `)
  const searchFtsStmt = db.query(`
    SELECT s.*
    FROM sf_symbols_fts f
    JOIN sf_symbols s ON s.rowid = f.rowid
    WHERE sf_symbols_fts MATCH $query
      AND ($scope IS NULL OR s.scope = $scope)
    ORDER BY bm25(sf_symbols_fts), COALESCE(s.order_index, 999999), s.name
    LIMIT $limit
  `)
  const searchLikeStmt = db.query(`
    SELECT * FROM sf_symbols
    WHERE ($scope IS NULL OR scope = $scope)
      AND (
        LOWER(name) LIKE $like OR LOWER(COALESCE(keywords_json, '')) LIKE $like
        OR LOWER(COALESCE(categories_json, '')) LIKE $like
        OR LOWER(COALESCE(aliases_json, '')) LIKE $like
      )
    ORDER BY scope, COALESCE(order_index, 999999), name
    LIMIT $limit
  `)
  const upsertRenderStmt = db.query(`
    INSERT OR REPLACE INTO sf_symbol_renders (
      cache_key, name, scope, format, mode, weight, symbol_scale,
      point_size, color, file_path, mime_type, sha256, size, updated_at
    )
    VALUES (
      $cache_key, $name, $scope, $format, $mode, $weight, $symbol_scale,
      $point_size, $color, $file_path, $mime_type, $sha256, $size, $updated_at
    )
  `)
  const getRenderStmt = db.query('SELECT * FROM sf_symbol_renders WHERE cache_key = ?')

  return {
    upsertSymbol(params) {
      upsertSymbolStmt.run({
        $name: params.name,
        $scope: params.scope,
        $categories_json: JSON.stringify(params.categories ?? []),
        $keywords_json: JSON.stringify(params.keywords ?? []),
        $aliases_json: JSON.stringify(params.aliases ?? []),
        $availability_json: JSON.stringify(params.availability ?? null),
        $order_index: params.orderIndex ?? null,
        $bundle_path: params.bundlePath ?? null,
        $bundle_version: params.bundleVersion ?? null,
        $updated_at: new Date().toISOString(),
      })
      // Refresh the contentless FTS5 row so a renamed symbol's old keyword
      // list doesn't keep showing up in search.
      deleteFtsStmt.run(params.scope, params.name)
      const rowid = getRowidStmt.get(params.scope, params.name)?.rowid
      if (rowid != null) {
        insertFtsStmt.run(
          rowid,
          params.name,
          (params.keywords ?? []).join(' '),
          (params.categories ?? []).join(' '),
          (params.aliases ?? []).join(' '),
        )
      }
    },
    getSymbol(scope, name) {
      const row = getSymbolStmt.get(scope, name)
      return row ? normalizeSfSymbolRow(row) : null
    },
    /** Lightweight catalog used by the /api/symbols/index.json endpoint —
     *  excludes large JSON sidecars so the gzipped payload stays small. */
    listCatalog() {
      return listCatalogStmt.all().map(row => ({
        name: row.name,
        scope: row.scope,
        categories: parseJsonArray(row.categories_json),
        keywords: parseJsonArray(row.keywords_json),
      }))
    },
    /** Hybrid search: FTS5 first, falls back to LIKE on parser failure
     *  (FTS5 trips on `?`, `:`, etc — the catalog has thousands of dotted
     *  symbol names so the fallback path is hit in practice). */
    searchSymbols(query = '', opts = {}) {
      const limit = Math.min(Math.max(Number.parseInt(opts.limit ?? 100, 10) || 100, 1), 500)
      const scope = opts.scope ?? null
      const q = String(query ?? '').trim()
      const parseRows = rows => rows.map(normalizeSfSymbolRow)
      if (!q) return parseRows(searchEmptyStmt.all({ $scope: scope, $limit: limit }))
      try {
        return parseRows(searchFtsStmt.all({
          $query: buildResourceFtsQuery(q),
          $scope: scope,
          $limit: limit,
        }))
      } catch {
        return parseRows(searchLikeStmt.all({
          $scope: scope,
          $like: `%${q.toLowerCase()}%`,
          $limit: limit,
        }))
      }
    },
    upsertRender(params) {
      upsertRenderStmt.run({
        $cache_key: params.cacheKey,
        $name: params.name,
        $scope: params.scope,
        $format: params.format,
        $mode: params.mode ?? null,
        $weight: params.weight ?? null,
        $symbol_scale: params.symbolScale ?? null,
        $point_size: params.pointSize ?? null,
        $color: params.color ?? null,
        $file_path: params.filePath,
        $mime_type: params.mimeType,
        $sha256: params.sha256 ?? null,
        $size: params.size ?? null,
        $updated_at: new Date().toISOString(),
      })
    },
    getRender(cacheKey) {
      return getRenderStmt.get(cacheKey) ?? null
    },
  }
}
