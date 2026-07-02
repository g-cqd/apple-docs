// EntryPointRegistry — the cross-source entry-point registry (port of
// src/sources/entry-points.js). The JS registry is a push-based module global
// (each adapter module calls `addEntryPoints` at import time, in registry.js's
// import order); adapters here declare `static entryPoints`, so the native
// registry is PULL-based: collected once from an ordered adapter-type list.
// Same dedupe rule (skip when an existing entry has the same key AND a
// set-equal `parents`), same "skip empty key / empty parents" filter.

public struct EntryPointRegistry: Sendable {
    private let entries: [EntryPoint]

    /// Collect from adapter types IN ORDER (the JS module-eval order — the
    /// emitted "Related Documentation" item order depends on it).
    public init(_ adapterTypes: [any SourceAdapter.Type]) {
        self.init(entries: adapterTypes.flatMap { $0.entryPoints })
    }

    /// `addEntryPoints` semantics over a flat list.
    public init(entries: [EntryPoint]) {
        var kept: [EntryPoint] = []
        for entry in entries {
            guard !entry.key.isEmpty, !entry.parents.isEmpty else { continue }
            let duplicate = kept.contains { existing in
                existing.key == entry.key
                    && existing.parents.allSatisfy { entry.parents.contains($0) }
                    && entry.parents.allSatisfy { existing.parents.contains($0) }
            }
            if duplicate { continue }
            kept.append(entry)
        }
        self.entries = kept
    }

    /// `getEntryPointsForParent(parentKey)`.
    public func entryPoints(forParent parentKey: String) -> [EntryPoint] {
        entries.filter { $0.parents.contains(parentKey) }
    }

    /// `getAllEntryPoints()` (read-only view).
    public var all: [EntryPoint] { entries }

    /// The registry the native crawl uses — every natively-ported adapter's
    /// entry points PLUS the swift-docc archives' entry points as a DATA-ONLY
    /// contribution (`SwiftDoccEntryPoints`): that adapter itself still crawls
    /// via Bun, but swift-org pages must emit the same "Related Documentation"
    /// cross-links either way. ORDER pinned against the JS oracle: swift-docc's
    /// module evaluates BEFORE swift-book's (an import chain reaches it first),
    /// so its three entries register first — verified by running
    /// `applyArchiveCrossLinks` under the real registry.js. Replace the data
    /// stub when the swift-docc adapter is ported.
    public static let native = EntryPointRegistry(
        entries: SwiftDoccEntryPoints.entries + SwiftBookAdapter.entryPoints)
}

/// The `ARCHIVES` table's entry points from src/sources/swift-docc.js, verbatim
/// (slug order = the JS object literal order). Data only — the swift-docc
/// ADAPTER is not yet ported.
public enum SwiftDoccEntryPoints {
    public static let entries: [EntryPoint] = [
        EntryPoint(
            slug: "swift-compiler",
            key: "swift-compiler/documentation/diagnostics",
            title: "Swift Compiler Diagnostics",
            summary:
                "Reference for warnings and errors emitted by the Swift compiler, including diagnostic groups and upcoming language features.",
            parents: ["swift-org/documentation", "swift-org/documentation/swift-compiler"]),
        EntryPoint(
            slug: "swift-package-manager",
            key: "swift-package-manager/documentation/packagemanagerdocs",
            title: "Swift Package Manager",
            summary:
                "Full reference for the Swift Package Manager: package manifests, dependencies, build settings, and plug-in APIs.",
            parents: ["swift-org/documentation", "swift-org/getting-started"]),
        EntryPoint(
            slug: "swift-migration-guide",
            key: "swift-migration-guide/documentation/migrationguide",
            title: "Swift 6 Concurrency Migration Guide",
            summary:
                "How to migrate existing Swift code to the Swift 6 concurrency model, including data-race safety and incremental adoption.",
            parents: ["swift-org/documentation"]),
    ]
}
