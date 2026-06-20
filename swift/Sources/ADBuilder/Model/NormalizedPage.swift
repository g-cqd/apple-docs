// NormalizedPage — the canonical output of a source adapter's `normalize` (the JS
// `{ document, sections, relationships }`). This is a PURE, dependency-free boundary
// type (an anti-corruption DTO): adapters produce it without touching ADWrite/ADDB, so
// the whole adapter + parser layer stays testable in isolation while the storage
// siblings churn. The pipeline maps a `NormalizedPage` to `ADWrite.NormalizedDoc` at
// the persist boundary (a 1:1 field copy — the field names match deliberately).
//
// Fields mirror `ADWrite.NormalizedDocument` field-for-field; every JS-optional field
// (`x ?? null`) is a Swift `Optional`. `key`/`sourceType` are the load-bearing ones.

/// The normalized document model: the `document` object, its `sections`, and its
/// `relationships`.
public struct NormalizedPage: Sendable, Codable, Equatable {
    public var document: NormalizedDocument
    public var sections: [NormalizedSection]
    public var relationships: [NormalizedRelationship]

    public init(
        document: NormalizedDocument,
        sections: [NormalizedSection] = [],
        relationships: [NormalizedRelationship] = []
    ) {
        self.document = document
        self.sections = sections
        self.relationships = relationships
    }
}

/// The `document` object from `normalize()` (mirrors `ADWrite.NormalizedDocument`).
public struct NormalizedDocument: Sendable, Codable, Equatable {
    public var sourceType: String?
    public var key: String
    public var title: String?
    public var kind: String?
    public var role: String?
    public var roleHeading: String?
    public var framework: String?
    public var url: String?
    public var language: String?
    public var abstractText: String?
    public var declarationText: String?
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
    public var headings: String?
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

/// One section from `normalize().sections` (mirrors `ADWrite.NormalizedSection`).
public struct NormalizedSection: Sendable, Codable, Equatable {
    public var sectionKind: String
    public var heading: String?
    public var contentText: String?
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

/// One relationship from `normalize().relationships` (mirrors
/// `ADWrite.NormalizedRelationship`).
public struct NormalizedRelationship: Sendable, Codable, Equatable {
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
