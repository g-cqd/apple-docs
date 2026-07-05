// The WRITE side of the apple-font tables — the native F3 resource-sync foundation
// (the JS `db.upsertAppleFontFamily` / `db.upsertAppleFontFile` in
// src/resources/apple-assets.js). Populates apple_font_families / apple_font_files
// that Assets.swift reads. Requires a writable StorageConnection; nullable columns
// bind `.null` via named parameters.

import Foundation

/// An `apple_font_families` upsert row (the JS family object).
public struct AppleFontFamilyUpsert: Sendable {
    public var id: String
    public var displayName: String
    public var category: String?
    public var sourceUrl: String?
    public var sourceSha256: String?
    public var sourceSize: Int64?
    public var sourcePath: String?
    public var extractedPath: String?
    public var status: String

    public init(
        id: String, displayName: String, category: String? = nil, sourceUrl: String? = nil,
        sourceSha256: String? = nil, sourceSize: Int64? = nil, sourcePath: String? = nil,
        extractedPath: String? = nil, status: String = "available"
    ) {
        self.id = id
        self.displayName = displayName
        self.category = category
        self.sourceUrl = sourceUrl
        self.sourceSha256 = sourceSha256
        self.sourceSize = sourceSize
        self.sourcePath = sourcePath
        self.extractedPath = extractedPath
        self.status = status
    }
}

/// An `apple_font_files` upsert row (the JS file object; `axes` → `axes_json`).
public struct AppleFontFileUpsert: Sendable {
    public var id: String
    public var familyId: String
    public var fileName: String
    public var filePath: String
    public var postscriptName: String?
    public var styleName: String?
    public var weight: String?
    public var variant: String?
    public var italic: Bool
    public var format: String?
    public var source: String
    public var isVariable: Bool
    public var axesJson: String?
    public var sha256: String?
    public var size: Int64?

    public init(
        id: String, familyId: String, fileName: String, filePath: String, postscriptName: String? = nil,
        styleName: String? = nil, weight: String? = nil, variant: String? = nil, italic: Bool = false,
        format: String? = nil, source: String = "remote", isVariable: Bool = false, axesJson: String? = nil,
        sha256: String? = nil, size: Int64? = nil
    ) {
        self.id = id
        self.familyId = familyId
        self.fileName = fileName
        self.filePath = filePath
        self.postscriptName = postscriptName
        self.styleName = styleName
        self.weight = weight
        self.variant = variant
        self.italic = italic
        self.format = format
        self.source = source
        self.isVariable = isVariable
        self.axesJson = axesJson
        self.sha256 = sha256
        self.size = size
    }
}

/// An `sf_symbols` catalog-sync upsert row (the JS `upsertSfSymbol` argument). The JSON columns are
/// pre-serialized by the caller; `availabilityJson` is nil when the CoreGlyphs plist has no entry.
public struct SfSymbolUpsert: Sendable {
    public var name: String
    public var scope: String
    public var categoriesJson: String
    public var keywordsJson: String
    public var aliasesJson: String
    public var availabilityJson: String?
    public var orderIndex: Int64?
    public var bundlePath: String?
    public var bundleVersion: String?

    public init(
        name: String, scope: String, categoriesJson: String, keywordsJson: String, aliasesJson: String,
        availabilityJson: String? = nil, orderIndex: Int64? = nil, bundlePath: String? = nil,
        bundleVersion: String? = nil
    ) {
        self.name = name
        self.scope = scope
        self.categoriesJson = categoriesJson
        self.keywordsJson = keywordsJson
        self.aliasesJson = aliasesJson
        self.availabilityJson = availabilityJson
        self.orderIndex = orderIndex
        self.bundlePath = bundlePath
        self.bundleVersion = bundleVersion
    }
}

/// An `sf_symbol_renders` cache-row upsert (the JS `upsertRender` argument). The offline bulk bake
/// (`ad-cli resources prerender-symbols`) writes rows at fixed canonical params (svg,
/// `SYMBOL_DEFAULT_RENDER_SIZE`, black, no background) with `mode: "prerender"`; a future writer for
/// a live-request cache (were the in-process MCP server ever given a dataDir to root new files
/// under) would use `mode: "live"`, matching the JS shape.
public struct SfSymbolRenderUpsert: Sendable {
    public var cacheKey: String
    public var name: String
    public var scope: String
    public var format: String
    public var mode: String?
    public var weight: String?
    public var symbolScale: String?
    public var pointSize: Int?
    public var color: String?
    public var filePath: String
    public var mimeType: String
    public var sha256: String?
    public var size: Int64?

    public init(
        cacheKey: String, name: String, scope: String, format: String, mode: String? = nil,
        weight: String? = nil, symbolScale: String? = nil, pointSize: Int? = nil, color: String? = nil,
        filePath: String, mimeType: String, sha256: String? = nil, size: Int64? = nil
    ) {
        self.cacheKey = cacheKey
        self.name = name
        self.scope = scope
        self.format = format
        self.mode = mode
        self.weight = weight
        self.symbolScale = symbolScale
        self.pointSize = pointSize
        self.color = color
        self.filePath = filePath
        self.mimeType = mimeType
        self.sha256 = sha256
        self.size = size
    }
}

extension StorageConnection {
    /// `INSERT OR REPLACE INTO apple_font_families` (the JS `upsertAppleFontFamily`).
    /// Needs a writable connection; `updatedAt` is the caller's ISO timestamp.
    @discardableResult
    public func upsertAppleFontFamily(_ family: AppleFontFamilyUpsert, updatedAt: String) -> Bool {
        let sql = """
            INSERT OR REPLACE INTO apple_font_families
              (id, display_name, source_url, source_sha256, source_size, source_path, extracted_path,
               status, category, updated_at)
            VALUES ($id, $displayName, $sourceUrl, $sourceSha256, $sourceSize, $sourcePath, $extractedPath,
               $status, $category, $updatedAt)
            """
        guard let stmt = conn.prepareUncached(sql) else { return false }
        stmt.bind("id", .text(family.id))
        stmt.bind("displayName", .text(family.displayName))
        stmt.bind("sourceUrl", family.sourceUrl.map(BindValue.text) ?? .null)
        stmt.bind("sourceSha256", family.sourceSha256.map(BindValue.text) ?? .null)
        stmt.bind("sourceSize", family.sourceSize.map(BindValue.int) ?? .null)
        stmt.bind("sourcePath", family.sourcePath.map(BindValue.text) ?? .null)
        stmt.bind("extractedPath", family.extractedPath.map(BindValue.text) ?? .null)
        stmt.bind("status", .text(family.status))
        stmt.bind("category", family.category.map(BindValue.text) ?? .null)
        stmt.bind("updatedAt", .text(updatedAt))
        return stmt.step() == SQLite.done
    }

    /// `INSERT OR REPLACE INTO apple_font_files` (the JS `upsertAppleFontFile`).
    @discardableResult
    public func upsertAppleFontFile(_ file: AppleFontFileUpsert, updatedAt: String) -> Bool {
        let sql = """
            INSERT OR REPLACE INTO apple_font_files
              (id, family_id, file_name, file_path, postscript_name, style_name, weight, variant, italic,
               format, source, is_variable, axes_json, sha256, size, updated_at)
            VALUES ($id, $familyId, $fileName, $filePath, $postscriptName, $styleName, $weight, $variant, $italic,
               $format, $source, $isVariable, $axesJson, $sha256, $size, $updatedAt)
            """
        guard let stmt = conn.prepareUncached(sql) else { return false }
        stmt.bind("id", .text(file.id))
        stmt.bind("familyId", .text(file.familyId))
        stmt.bind("fileName", .text(file.fileName))
        stmt.bind("filePath", .text(file.filePath))
        stmt.bind("postscriptName", file.postscriptName.map(BindValue.text) ?? .null)
        stmt.bind("styleName", file.styleName.map(BindValue.text) ?? .null)
        stmt.bind("weight", file.weight.map(BindValue.text) ?? .null)
        stmt.bind("variant", file.variant.map(BindValue.text) ?? .null)
        stmt.bind("italic", .int(file.italic ? 1 : 0))
        stmt.bind("format", file.format.map(BindValue.text) ?? .null)
        stmt.bind("source", .text(file.source))
        stmt.bind("isVariable", .int(file.isVariable ? 1 : 0))
        stmt.bind("axesJson", file.axesJson.map(BindValue.text) ?? .null)
        stmt.bind("sha256", file.sha256.map(BindValue.text) ?? .null)
        stmt.bind("size", file.size.map(BindValue.int) ?? .null)
        stmt.bind("updatedAt", .text(updatedAt))
        return stmt.step() == SQLite.done
    }

    /// Upsert an sf_symbols catalog row (the JS `upsertSfSymbol`). ADDB rejects a COMPOSITE ON CONFLICT
    /// target, so this runs `INSERT OR IGNORE` (a fresh row leaves codepoint / render columns at their
    /// DEFAULT) then `UPDATE`s the CoreGlyphs catalog fields — so the codepoint-stamp + mark-unrenderable
    /// columns survive a re-sync. Keyed on the (scope, name) primary key.
    @discardableResult
    public func upsertSfSymbol(_ symbol: SfSymbolUpsert, updatedAt: String) -> Bool {
        let insert = """
            INSERT OR IGNORE INTO sf_symbols
              (name, scope, categories_json, keywords_json, aliases_json, availability_json,
               order_index, bundle_path, bundle_version, updated_at)
            VALUES ($name, $scope, $categories, $keywords, $aliases, $availability,
               $orderIndex, $bundlePath, $bundleVersion, $updatedAt)
            """
        guard let ins = conn.prepareUncached(insert) else { return false }
        bindSfSymbol(ins, symbol, updatedAt: updatedAt)
        guard ins.step() == SQLite.done else { return false }

        let update = """
            UPDATE sf_symbols SET
              categories_json = $categories, keywords_json = $keywords, aliases_json = $aliases,
              availability_json = $availability, order_index = $orderIndex, bundle_path = $bundlePath,
              bundle_version = $bundleVersion, updated_at = $updatedAt
            WHERE scope = $scope AND name = $name
            """
        guard let upd = conn.prepareUncached(update) else { return false }
        bindSfSymbol(upd, symbol, updatedAt: updatedAt)
        return upd.step() == SQLite.done
    }

    /// Upsert an `sf_symbol_renders` cache row (the JS `upsertRender`). Unlike `sf_symbols`,
    /// `cache_key` is a SINGLE-column PRIMARY KEY, so a plain `INSERT OR REPLACE` is correct here —
    /// the composite-key `INSERT OR IGNORE` + `UPDATE` workaround above exists only because ADDB
    /// rejects a MULTI-column `ON CONFLICT` target; a one-column PK upserts exactly like
    /// `apple_font_families`/`apple_font_files` above, and every write here supplies the full row
    /// (no partial-update columns to protect from a REPLACE), so there's nothing to lose.
    @discardableResult
    public func upsertSfSymbolRender(_ render: SfSymbolRenderUpsert, updatedAt: String) -> Bool {
        let sql = """
            INSERT OR REPLACE INTO sf_symbol_renders
              (cache_key, name, scope, format, mode, weight, symbol_scale, point_size, color,
               file_path, mime_type, sha256, size, updated_at)
            VALUES ($cacheKey, $name, $scope, $format, $mode, $weight, $symbolScale, $pointSize, $color,
               $filePath, $mimeType, $sha256, $size, $updatedAt)
            """
        guard let stmt = conn.prepareUncached(sql) else { return false }
        stmt.bind("cacheKey", .text(render.cacheKey))
        stmt.bind("name", .text(render.name))
        stmt.bind("scope", .text(render.scope))
        stmt.bind("format", .text(render.format))
        stmt.bind("mode", render.mode.map(BindValue.text) ?? .null)
        stmt.bind("weight", render.weight.map(BindValue.text) ?? .null)
        stmt.bind("symbolScale", render.symbolScale.map(BindValue.text) ?? .null)
        stmt.bind("pointSize", render.pointSize.map { BindValue.int(Int64($0)) } ?? .null)
        stmt.bind("color", render.color.map(BindValue.text) ?? .null)
        stmt.bind("filePath", .text(render.filePath))
        stmt.bind("mimeType", .text(render.mimeType))
        stmt.bind("sha256", render.sha256.map(BindValue.text) ?? .null)
        stmt.bind("size", render.size.map(BindValue.int) ?? .null)
        stmt.bind("updatedAt", .text(updatedAt))
        return stmt.step() == SQLite.done
    }

    /// Flag an `sf_symbols` row as unrenderable on this build host (the JS `markRenderUnsupported`,
    /// v27 `render_unsupported`) — set when EVERY variant the bulk prerender attempted for
    /// `(scope, name)` failed to produce a PDF (the SF Symbols.app catalog can list names newer than
    /// the running macOS's CoreGlyphs bundle). A plain `UPDATE`, so no upsert/`ON CONFLICT` concern
    /// applies at all.
    @discardableResult
    public func markSfSymbolRenderUnsupported(scope: String, name: String) -> Bool {
        guard
            let stmt = conn.prepareUncached(
                "UPDATE sf_symbols SET render_unsupported = 1 WHERE scope = $scope AND name = $name")
        else { return false }
        stmt.bind("scope", .text(scope))
        stmt.bind("name", .text(name))
        return stmt.step() == SQLite.done
    }

    private func bindSfSymbol(_ stmt: any StorageStatement, _ symbol: SfSymbolUpsert, updatedAt: String) {
        stmt.bind("name", .text(symbol.name))
        stmt.bind("scope", .text(symbol.scope))
        stmt.bind("categories", .text(symbol.categoriesJson))
        stmt.bind("keywords", .text(symbol.keywordsJson))
        stmt.bind("aliases", .text(symbol.aliasesJson))
        stmt.bind("availability", symbol.availabilityJson.map(BindValue.text) ?? .null)
        stmt.bind("orderIndex", symbol.orderIndex.map(BindValue.int) ?? .null)
        stmt.bind("bundlePath", symbol.bundlePath.map(BindValue.text) ?? .null)
        stmt.bind("bundleVersion", symbol.bundleVersion.map(BindValue.text) ?? .null)
        stmt.bind("updatedAt", .text(updatedAt))
    }
}
