// NormalizedDoc — the native input contract for the apple-docs crawl persist.
//
// This is a Codable mirror of the JS `normalize()` output shape
// (apple-docs/src/content/normalize.js → normalize/docc.js | guidelines.js):
//
//     { document: {...}, sections: [...], relationships: [...] }
//
// The persist (`CrawlPersist.persistNormalized`) decodes this from the SAME JSON
// the JS writer feeds its `upsertNormalizedDocument`, then writes the documents
// row + document_sections + document_relationships exactly as the JS repos do.
//
// Field names use the JS camelCase keys verbatim (sourceType, abstractText,
// platformsJson, minIos, …) so the decoded JSON is the literal JS object — no
// rename layer. Every JS-optional field (`x ?? null`) is a Swift `Optional`.
//
// `Codable` is a stdlib protocol — no Foundation import here (ADWrite stays a
// Foundation-free leaf). The actual JSON decoding (`JSONDecoder`) happens in the
// caller/test, which imports Foundation; this model only declares conformance.

/// The canonical normalized document: the `document` object, its `sections`, and
/// its `relationships`. Mirrors `{ document, sections, relationships }`.
public struct NormalizedDoc: Sendable, Codable {
    public var document: NormalizedDocument
    public var sections: [NormalizedSection]
    public var relationships: [NormalizedRelationship]

    public init(
        document: NormalizedDocument,
        sections: [NormalizedSection],
        relationships: [NormalizedRelationship]
    ) {
        self.document = document
        self.sections = sections
        self.relationships = relationships
    }
}

/// The `document` object from `normalize()`. Field-for-field the DocC/guidelines
/// normalizer output (normalize/docc.js lines 69–93). All optionals match the JS
/// `?? null` semantics; `key`/`sourceType` are always present.
public struct NormalizedDocument: Sendable, Codable {
    /// Canonical source-type tag ('apple-docc' | 'hig' | 'swift-docc' | …). The
    /// document repo coerces an unknown value to 'apple-docc' (see CrawlPersist).
    public var sourceType: String?
    /// Canonical path key, e.g. 'swiftui/view' — the `documents.key` UNIQUE column
    /// and the `from_key` for relationships.
    public var key: String
    public var title: String?
    public var kind: String?
    public var role: String?
    public var roleHeading: String?
    /// Framework slug; normalize sets `key.split('/')[0]`, so always present, but
    /// modeled optional to honor the JS `?? deriveFrameworkFromPath(key)` fallback.
    public var framework: String?
    public var url: String?
    public var language: String?
    public var abstractText: String?
    public var declarationText: String?
    /// Serialized platforms object (JSON string) or nil. Stored verbatim in
    /// documents.platforms_json (and pages.platforms).
    public var platformsJson: String?
    public var minIos: String?
    public var minMacos: String?
    public var minWatchos: String?
    public var minTvos: String?
    public var minVisionos: String?
    public var isDeprecated: Bool?
    public var isBeta: Bool?
    public var isReleaseNotes: Bool?
    public var urlDepth: Int?
    /// Joined heading text for FTS (documents.headings). nil when no headings.
    public var headings: String?
    /// Adapter-specific metadata; normalize sets it to null for DocC/guidelines.
    /// A string is stored verbatim; a non-string would be JSON-encoded by the JS
    /// repo, but normalize only ever emits null here.
    public var sourceMetadata: String?

    public init(
        sourceType: String? = nil, key: String, title: String? = nil, kind: String? = nil,
        role: String? = nil, roleHeading: String? = nil, framework: String? = nil,
        url: String? = nil, language: String? = nil, abstractText: String? = nil,
        declarationText: String? = nil, platformsJson: String? = nil, minIos: String? = nil,
        minMacos: String? = nil, minWatchos: String? = nil, minTvos: String? = nil,
        minVisionos: String? = nil, isDeprecated: Bool? = nil, isBeta: Bool? = nil,
        isReleaseNotes: Bool? = nil, urlDepth: Int? = nil, headings: String? = nil,
        sourceMetadata: String? = nil
    ) {
        self.sourceType = sourceType
        self.key = key
        self.title = title
        self.kind = kind
        self.role = role
        self.roleHeading = roleHeading
        self.framework = framework
        self.url = url
        self.language = language
        self.abstractText = abstractText
        self.declarationText = declarationText
        self.platformsJson = platformsJson
        self.minIos = minIos
        self.minMacos = minMacos
        self.minWatchos = minWatchos
        self.minTvos = minTvos
        self.minVisionos = minVisionos
        self.isDeprecated = isDeprecated
        self.isBeta = isBeta
        self.isReleaseNotes = isReleaseNotes
        self.urlDepth = urlDepth
        self.headings = headings
        self.sourceMetadata = sourceMetadata
    }
}

/// One section from `normalize().sections` (normalize/docc.js sections array).
/// Maps to a `document_sections` row.
public struct NormalizedSection: Sendable, Codable {
    /// section_kind ('abstract' | 'declaration' | 'parameters' | 'discussion' | …).
    public var sectionKind: String
    public var heading: String?
    /// Rendered plain text. May be JSON `null` (e.g. an empty declaration); the
    /// persist writes '' for null since content_text is NOT NULL (mirrors the JS
    /// `section.contentText ?? ''`).
    public var contentText: String?
    /// JSON blob of the structured section content, or nil.
    public var contentJson: String?
    public var sortOrder: Int

    public init(
        sectionKind: String, heading: String? = nil, contentText: String? = nil,
        contentJson: String? = nil, sortOrder: Int
    ) {
        self.sectionKind = sectionKind
        self.heading = heading
        self.contentText = contentText
        self.contentJson = contentJson
        self.sortOrder = sortOrder
    }
}

/// One relationship from `normalize().relationships`
/// (normalize/relationships.js). Maps to a `document_relationships` row.
public struct NormalizedRelationship: Sendable, Codable {
    /// Source doc key. normalize sets it to the owning document's key; the persist
    /// falls back to that key when absent (mirrors the JS `?? fromKey`).
    public var fromKey: String?
    public var toKey: String
    public var relationType: String
    public var section: String?
    public var sortOrder: Int?

    public init(
        fromKey: String? = nil, toKey: String, relationType: String, section: String? = nil,
        sortOrder: Int? = nil
    ) {
        self.fromKey = fromKey
        self.toKey = toKey
        self.relationType = relationType
        self.section = section
        self.sortOrder = sortOrder
    }
}
