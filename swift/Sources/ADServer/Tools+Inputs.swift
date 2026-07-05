import ADJSON
import Foundation

// MCP tool INPUT schemas (ADJSON @Schemable / @SchemaInfo, draft-07) + their enum fields. Split from
// Tools.swift to keep the file within the size gate; @Schemable derives the JSON Schema (byte-equal
// to the SDK zod schemas) and Decodable here.
// MARK: - Enum fields (→ string `enum`, declaration order)

enum SymbolScope: String, Codable, CaseIterable { case `public`, `private` }
enum SymbolFormat: String, Codable, CaseIterable { case svg, png }
enum SymbolWeight: String, Codable, CaseIterable {
    case ultralight, thin, light, regular, medium, semibold, bold, heavy, black
}
enum SymbolScale: String, Codable, CaseIterable { case small, medium, large }
enum TaxonomyField: String, Codable, CaseIterable { case kind, role, docKind, roleHeading, sourceType }
enum SearchLanguage: String, Codable, CaseIterable { case swift, objc }
enum SearchPlatform: String, Codable, CaseIterable { case ios, macos, watchos, tvos, visionos }
enum DeprecatedFilter: String, Codable, CaseIterable { case include, exclude, only }

// MARK: - Input schemas (ADJSON @Schemable, draft-07 to match the MCP SDK)

@Schemable(dialect: .draft7)
struct SearchDocsInput: Decodable {
    @SchemaInfo(description: #"Search terms, e.g. "NavigationStack"."#) var query: String
    /// Framework slug, e.g. swiftui, app-store-review.
    var framework: String?
    /// Source slug(s), comma-separated: apple-docc, hig, wwdc, sample-code, swift-evolution, ...
    var source: String?
    /// Page kind (values via list_taxonomy).
    var kind: String?
    var language: SearchLanguage?
    var platform: SearchPlatform?
    @SchemaInfo(description: #"Min version per platform, e.g. {"ios":"17.0"}."#) var minVersion: MinVersion?
    /// Max results (default 25).
    @SchemaNumber(1 ... 100) var limit: Int?
    /// Inline the top result's full content.
    var read: Bool?
    /// WWDC session year.
    @SchemaNumber(type: .number) var year: Int?
    /// WWDC track.
    var track: String?
    /// Default include; use exclude when writing code.
    var deprecated: DeprecatedFilter?
    /// Page size in chars (min 512).
    @SchemaNumber(512...) var maxChars: Int?
    /// 1-based page; needs maxChars.
    @SchemaNumber(1...) var page: Int?
    @SchemaInfo(description: "Return only excerpt windows around matches instead of full content.")
    var match: MatchExcerpt?
}

@Schemable
struct MinVersion: Decodable {
    var ios: String?
    var macos: String?
    var watchos: String?
    var tvos: String?
    var visionos: String?
}

@Schemable(dialect: .draft7)
struct ListTaxonomyInput: Decodable {
    /// Single field instead of all five.
    var field: TaxonomyField?
    /// Full distribution, not top 20.
    var all: Bool?
}

@Schemable(dialect: .draft7)
struct ListFrameworksInput: Decodable {
    /// Filter: framework, technology, tooling, collection, release-notes, tutorial, guidelines, design.
    var kind: String?
    /// Page size in chars (min 512).
    @SchemaNumber(512...) var maxChars: Int?
    /// 1-based page; needs maxChars.
    @SchemaNumber(1...) var page: Int?
}

@Schemable(dialect: .draft7)
struct ReadDocInput: Decodable {
    /// Page path, e.g. swiftui/view, app-store-review/3.1.
    var path: String?
    /// Symbol name, e.g. NavigationStack.
    var symbol: String?
    /// Disambiguates symbol.
    var framework: String?
    /// Single section by heading.
    var section: String?
    /// Page size in chars (min 512).
    @SchemaNumber(512...) var maxChars: Int?
    /// 1-based page; needs maxChars.
    @SchemaNumber(1...) var page: Int?
    @SchemaInfo(description: "Return only excerpt windows around matches instead of full content.")
    var match: MatchExcerpt?
}

@Schemable
struct MatchExcerpt: Decodable {
    @SchemaInfo(description: "Substring to locate.") var query: String
    /// Chars around each match (default 140).
    @SchemaNumber(20 ... 2000) var context: Int?
    /// Max excerpts (default 5).
    @SchemaNumber(1 ... 50) var max: Int?
    var caseSensitive: Bool?
}

@Schemable(dialect: .draft7)
struct SearchSfSymbolsInput: Decodable {
    /// Name or keyword; empty lists all.
    var query: String?
    var scope: SymbolScope?
    /// Max results (default 100).
    @SchemaNumber(1 ... 500) var limit: Int?
}

@Schemable(dialect: .draft7)
struct ListAppleFontsInput: Decodable {}

@Schemable(dialect: .draft7)
struct RenderSfSymbolInput: Decodable {
    /// Symbol name, e.g. pencil.and.sparkles.
    var name: String
    /// Default public.
    var scope: SymbolScope?
    /// Default png.
    var format: SymbolFormat?
    /// Square size in px.
    @SchemaNumber(8 ... 1024) var size: Int?
    @SchemaInfo(description: #"Foreground hex or "currentColor" (svg)."#) var color: String?
    @SchemaInfo(description: #"Background hex or "transparent"."#) var background: String?
    /// Public symbols only.
    var weight: SymbolWeight?
    /// Public symbols only.
    var scale: SymbolScale?
}

@Schemable(dialect: .draft7)
struct RenderFontTextInput: Decodable {
    /// Id from list_apple_fonts.
    var fontId: String
    /// Text to render.
    var text: String?
    /// Point size.
    @SchemaNumber(8 ... 512) var size: Int?
}

@Schemable(dialect: .draft7)
struct BrowseInput: Decodable {
    /// Root slug, e.g. swiftui, design, wwdc.
    var framework: String
    /// Drill into a page, e.g. swiftui/view.
    var path: String?
    /// WWDC sessions of one year.
    var year: Int?
    /// Max pages (default 100, cap 200).
    @SchemaNumber(1 ... 200) var limit: Int?
    /// Page size in chars (min 512).
    @SchemaNumber(512...) var maxChars: Int?
    /// 1-based page; needs maxChars.
    @SchemaNumber(1...) var page: Int?
}
