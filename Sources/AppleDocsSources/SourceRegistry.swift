public import AppleDocsCore
import Foundation

/// Authoritative registry of all 11 upstream documentation source adapters loaded from the
/// bundled `sources.json` catalog.
public enum SourceRegistry: Sendable {
    private static let catalogByKind: [SourceKind: WebSourceAdapter] = loadCatalog()

    /// Returns the configured ``SourceAdapter`` for `kind`.
    public static func adapter(for kind: SourceKind) -> any SourceAdapter {
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

    /// Returns all 11 registered adapters in canonical ``SourceKind`` order.
    public static var allAdapters: [any SourceAdapter] {
        SourceKind.allCases.map(adapter(for:))
    }

    private static func loadCatalog() -> [SourceKind: WebSourceAdapter] {
        guard let url = Bundle.module.url(forResource: "sources", withExtension: "json"),
            let data = try? Data(contentsOf: url),
            let specs = try? JSONDecoder().decode([WebSourceAdapter.Spec].self, from: data)
        else {
            return [:]
        }
        return Dictionary(uniqueKeysWithValues: specs.map { ($0.kind, WebSourceAdapter(spec: $0)) })
    }
}
