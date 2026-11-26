public import AppleDocsCore
import Foundation

/// Authoritative registry of all 12 upstream documentation source adapters.
public enum SourceRegistry: Sendable {
    private static let catalogByKind: [SourceKind: WebSourceAdapter] = loadCatalog()

    /// Returns a fresh ``SourceAdapter`` instance for `kind` (stateful adapters like `SwiftBookAdapter`,
    /// `ExternalDocCAdapter`, `GuidelinesAdapter`, `WWDCAdapter`, and `AppleArchiveAdapter` carry per-run
    /// discovery caches).
    public static func adapter(for kind: SourceKind) -> any SourceAdapter {
        switch kind {
            case .swiftDocC: return SwiftDocCAdapter()
            case .externalDocC: return ExternalDocCAdapter()
            case .swiftEvolution: return SwiftEvolutionAdapter()
            case .swiftBook: return SwiftBookAdapter()
            case .guidelines: return GuidelinesAdapter()
            case .wwdc: return WWDCAdapter()
            case .sampleCode: return SampleCodeAdapter()
            case .swiftOrg: return SwiftOrgAdapter()
            case .appleArchive: return AppleArchiveAdapter()
            case .packages: return PackagesAdapter()
            case .appleDocC, .hig:
                if let configured = catalogByKind[kind] {
                    return configured
                }
                return WebSourceAdapter(
                    spec: WebSourceAdapter.Spec(
                        kind: kind,
                        displayName: kind.rawValue,
                        rootSlug: kind.rawValue,
                        rootKind: "collection",
                        seedPath: kind.rawValue,
                        host: "developer.apple.com",
                        basePathSegments: ["tutorials", "data", "documentation"],
                        dropsRootSegment: false,
                        fileExtension: "json",
                        encoding: .doccJSON
                    )
                )
        }
    }

    /// Returns all 12 registered adapters in canonical ``SourceKind`` order.
    public static var allAdapters: [any SourceAdapter] {
        SourceKind.allCases.map(adapter(for:))
    }

    private static func loadCatalog() -> [SourceKind: WebSourceAdapter] {
        guard
            let specs = try? JSONDecoder()
                .decode([WebSourceAdapter.Spec].self, from: Data(EmbeddedSourceRegistry.text.utf8))
        else {
            return [:]
        }
        return Dictionary(uniqueKeysWithValues: specs.map { ($0.kind, WebSourceAdapter(spec: $0)) })
    }
}
