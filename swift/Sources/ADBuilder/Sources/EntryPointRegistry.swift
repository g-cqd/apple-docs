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

    /// The registry the native crawl uses — the swift-docc archives' entry points then swift-book's.
    /// swift-org pages emit the same "Related Documentation" cross-links. ORDER pinned against the JS
    /// oracle: swift-docc's module evaluates BEFORE swift-book's (an import chain reaches it first),
    /// so its three entries register first — verified against the real registry.js. Sourced from the
    /// now-native `SwiftDoccAdapter.entryPoints` (was a data-only stub before the adapter was ported).
    public static let native = EntryPointRegistry(
        entries: SwiftDoccAdapter.entryPoints + SwiftBookAdapter.entryPoints)
}
