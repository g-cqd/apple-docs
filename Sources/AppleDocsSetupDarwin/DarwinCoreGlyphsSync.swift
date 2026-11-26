import AppleDocsSetup
public import AppleDocsStorage
import Foundation

/// Synchronizes the native macOS `CoreGlyphs.bundle` SF Symbols catalog (`name_availability.plist`,
/// `symbol_categories.plist`, `symbol_search.plist`, `name_aliases.strings`, `symbol_order.plist`)
/// directly into a Swift v1 ``CorpusStore`` (`sf_symbols` + `sf_symbols_fts`).
///
/// Compiles cleanly on Linux and fails with ``SetupError/unsupportedOnPlatform(feature:)`` when invoked
/// on non-macOS hosts.
public enum DarwinCoreGlyphsSync: Sendable {
    /// Summary of SF Symbols imported from `CoreGlyphs.bundle`.
    public struct SyncReport: Hashable, Sendable {
        public let bundlePath: String
        public let symbolsSynced: Int
    }

    /// Reads CoreGlyphs metadata plists from `bundlePath` (or auto-discovered system CoreGlyphs)
    /// and atomically upserts them into `store` under `scope` (`public` by default).
    public static func sync(
        into store: CorpusStore,
        bundlePath: String? = nil,
        scope: String = "public"
    ) throws -> SyncReport {
        #if os(macOS)
            let resolvedBundle = try bundlePath ?? DarwinAssetLocator.requireCoreGlyphsBundle()
            let catalog = try loadCatalog(fromBundle: resolvedBundle)
            let validScope = (scope == "private") ? "private" : "public"
            try writeCatalog(catalog, scope: validScope, into: store)
            return SyncReport(bundlePath: resolvedBundle, symbolsSynced: catalog.sortedNames.count)
        #else
            _ = (store, bundlePath, scope)
            throw SetupError.unsupportedOnPlatform(feature: "CoreGlyphs SF Symbols catalog sync")
        #endif
    }

    #if os(macOS)
        private struct CatalogData {
            let sortedNames: [String]
            let availability: [String: String]
            let categories: [String: [String]]
            let keywords: [String: [String]]
            let aliases: [String: [String]]
            let orderByName: [String: Int]
        }

        private static func loadCatalog(fromBundle bundlePath: String) throws -> CatalogData {
            let resourcesURL = URL(fileURLWithPath: bundlePath, isDirectory: true)
                .appendingPathComponent("Contents/Resources", isDirectory: true)
            let availabilityRoot = readPlistDictionary(
                at: resourcesURL.appendingPathComponent("name_availability.plist")
            )
            let symbolsAvailability = availabilityRoot["symbols"] as? [String: String] ?? [:]
            guard !symbolsAvailability.isEmpty else {
                throw SetupError.ioFailure("No symbols found in \(resourcesURL.path)/name_availability.plist")
            }

            let categories =
                readPlistDictionary(at: resourcesURL.appendingPathComponent("symbol_categories.plist"))
                as? [String: [String]] ?? [:]
            let keywords =
                readPlistDictionary(at: resourcesURL.appendingPathComponent("symbol_search.plist"))
                as? [String: [String]] ?? [:]
            let orderList =
                readPlistArray(at: resourcesURL.appendingPathComponent("symbol_order.plist"))
                as? [String] ?? []
            let aliasesRaw =
                readPlistDictionary(at: resourcesURL.appendingPathComponent("name_aliases.strings"))
                as? [String: String] ?? [:]

            var orderByName: [String: Int] = [:]
            orderByName.reserveCapacity(orderList.count)
            for (idx, name) in orderList.enumerated() { orderByName[name] = idx }

            var aliasesByCanonical: [String: [String]] = [:]
            for (alias, canonical) in aliasesRaw {
                aliasesByCanonical[canonical, default: []].append(alias)
            }
            return CatalogData(
                sortedNames: symbolsAvailability.keys.sorted(),
                availability: symbolsAvailability,
                categories: categories,
                keywords: keywords,
                aliases: aliasesByCanonical,
                orderByName: orderByName
            )
        }

        private static func writeCatalog(_ catalog: CatalogData, scope: String, into store: CorpusStore) throws {
            try store.connection.transaction {
                for name in catalog.sortedNames {
                    let categories = catalog.categories[name] ?? []
                    let keywords = catalog.keywords[name] ?? []
                    let aliases = (catalog.aliases[name] ?? []).sorted()
                    let avail = catalog.availability[name].map { ["release": $0] } ?? [:]

                    try store.connection.execute(
                        """
                        INSERT INTO sf_symbols (
                            name, scope, categories_json, keywords_json, aliases_json,
                            availability_json, order_index, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
                        ON CONFLICT(scope, name) DO UPDATE SET
                            categories_json = excluded.categories_json,
                            keywords_json = excluded.keywords_json,
                            aliases_json = excluded.aliases_json,
                            availability_json = excluded.availability_json,
                            order_index = excluded.order_index,
                            updated_at = datetime('now')
                        """,
                        bindings: [
                            .text(name),
                            .text(scope),
                            .text(encodeJSON(categories, fallback: "[]")),
                            .text(encodeJSON(keywords, fallback: "[]")),
                            .text(encodeJSON(aliases, fallback: "[]")),
                            .text(encodeJSON(avail, fallback: "{}")),
                            catalog.orderByName[name].map { .integer(Int64($0)) } ?? .null
                        ]
                    )
                    // The FTS row shares the symbol's rowid: searches join `sf_symbols_fts` back by rowid.
                    try store.connection.execute(
                        "DELETE FROM sf_symbols_fts WHERE rowid = (SELECT rowid FROM sf_symbols WHERE scope = ? AND name = ?)",
                        bindings: [.text(scope), .text(name)]
                    )
                    try store.connection.execute(
                        """
                        INSERT INTO sf_symbols_fts (rowid, name, keywords, categories, aliases)
                        VALUES ((SELECT rowid FROM sf_symbols WHERE scope = ? AND name = ?), ?, ?, ?, ?)
                        """,
                        bindings: [
                            .text(scope),
                            .text(name),
                            .text(name),
                            .text(keywords.joined(separator: " ")),
                            .text(categories.joined(separator: " ")),
                            .text(aliases.joined(separator: " "))
                        ]
                    )
                }
            }
        }

        private static func readPlistDictionary(at url: URL) -> [String: Any] {
            guard let data = try? Data(contentsOf: url),
                let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
                let dict = plist as? [String: Any]
            else {
                return [:]
            }
            return dict
        }

        private static func readPlistArray(at url: URL) -> [Any] {
            guard let data = try? Data(contentsOf: url),
                let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
                let array = plist as? [Any]
            else {
                return []
            }
            return array
        }

        private static func encodeJSON<T: Encodable>(_ value: T, fallback: String) -> String {
            guard let data = try? JSONEncoder().encode(value) else { return fallback }
            return String(decoding: data, as: UTF8.self)
        }
    #endif
}
