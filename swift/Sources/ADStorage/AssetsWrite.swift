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
}
