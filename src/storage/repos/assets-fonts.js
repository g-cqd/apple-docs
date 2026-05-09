/**
 * Apple typography repository: families + files. Schema lives in
 * migrations v10 (initial) and v12 (classification + uniqueness).
 *
 * Both upsert methods now hit prepared statements (the pre-extraction
 * code rebuilt the query string on every call).
 */

import { parseJsonArray } from '../_helpers.js'

function normalizeAppleFontFile(row) {
  return {
    ...row,
    italic: row.italic === 1 || row.italic === true,
    is_variable: row.is_variable === 1 || row.is_variable === true,
    axes: parseJsonArray(row.axes_json),
  }
}

export function createAssetsFontsRepo(db) {
  const upsertFamilyStmt = db.query(`
    INSERT INTO apple_font_families (
      id, display_name, source_url, source_sha256, source_size,
      source_path, extracted_path, status, category, updated_at
    )
    VALUES (
      $id, $display_name, $source_url, $source_sha256, $source_size,
      $source_path, $extracted_path, $status, $category, $updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      source_url = COALESCE(excluded.source_url, apple_font_families.source_url),
      source_sha256 = COALESCE(excluded.source_sha256, apple_font_families.source_sha256),
      source_size = COALESCE(excluded.source_size, apple_font_families.source_size),
      source_path = COALESCE(excluded.source_path, apple_font_families.source_path),
      extracted_path = COALESCE(excluded.extracted_path, apple_font_families.extracted_path),
      status = excluded.status,
      category = COALESCE(excluded.category, apple_font_families.category),
      updated_at = excluded.updated_at
  `)
  const upsertFileStmt = db.query(`
    INSERT INTO apple_font_files (
      id, family_id, file_name, file_path, postscript_name,
      style_name, weight, variant, italic, format,
      source, is_variable, axes_json, sha256, size, updated_at
    )
    VALUES (
      $id, $family_id, $file_name, $file_path, $postscript_name,
      $style_name, $weight, $variant, $italic, $format,
      $source, $is_variable, $axes_json, $sha256, $size, $updated_at
    )
    ON CONFLICT(family_id, file_name) DO UPDATE SET
      file_path = excluded.file_path,
      postscript_name = COALESCE(excluded.postscript_name, apple_font_files.postscript_name),
      style_name = COALESCE(excluded.style_name, apple_font_files.style_name),
      weight = COALESCE(excluded.weight, apple_font_files.weight),
      variant = COALESCE(excluded.variant, apple_font_files.variant),
      italic = excluded.italic,
      format = COALESCE(excluded.format, apple_font_files.format),
      source = excluded.source,
      is_variable = excluded.is_variable,
      axes_json = COALESCE(excluded.axes_json, apple_font_files.axes_json),
      sha256 = COALESCE(excluded.sha256, apple_font_files.sha256),
      size = COALESCE(excluded.size, apple_font_files.size),
      updated_at = excluded.updated_at
  `)
  const listFamiliesStmt = db.query('SELECT * FROM apple_font_families ORDER BY display_name')
  const listFilesStmt = db.query('SELECT * FROM apple_font_files ORDER BY family_id, file_name')
  const getFileStmt = db.query(`
    SELECT f.*, fam.display_name as family_display_name, fam.category as family_category
    FROM apple_font_files f
    JOIN apple_font_families fam ON fam.id = f.family_id
    WHERE f.id = ?
  `)

  return {
    upsertFontFamily(params) {
      upsertFamilyStmt.run({
        $id: params.id,
        $display_name: params.displayName,
        $source_url: params.sourceUrl ?? null,
        $source_sha256: params.sourceSha256 ?? null,
        $source_size: params.sourceSize ?? null,
        $source_path: params.sourcePath ?? null,
        $extracted_path: params.extractedPath ?? null,
        $status: params.status ?? 'available',
        $category: params.category ?? null,
        $updated_at: new Date().toISOString(),
      })
    },
    upsertFontFile(params) {
      upsertFileStmt.run({
        $id: params.id,
        $family_id: params.familyId,
        $file_name: params.fileName,
        $file_path: params.filePath,
        $postscript_name: params.postscriptName ?? null,
        $style_name: params.styleName ?? null,
        $weight: params.weight ?? null,
        $variant: params.variant ?? null,
        $italic: params.italic ? 1 : 0,
        $format: params.format ?? null,
        $source: params.source ?? 'remote',
        $is_variable: params.isVariable ? 1 : 0,
        $axes_json: params.axes ? JSON.stringify(params.axes) : null,
        $sha256: params.sha256 ?? null,
        $size: params.size ?? null,
        $updated_at: new Date().toISOString(),
      })
    },
    listFonts() {
      const families = listFamiliesStmt.all()
      const files = listFilesStmt.all()
      const byFamily = new Map()
      for (const file of files) {
        const list = byFamily.get(file.family_id) ?? []
        list.push(normalizeAppleFontFile(file))
        byFamily.set(file.family_id, list)
      }
      return families.map(family => ({
        ...family,
        files: byFamily.get(family.id) ?? [],
      }))
    },
    getFontFile(id) {
      const row = getFileStmt.get(id)
      return row ? normalizeAppleFontFile(row) : null
    },
  }
}
