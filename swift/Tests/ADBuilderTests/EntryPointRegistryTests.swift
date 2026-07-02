// EntryPointRegistry + SwiftOrgAdapter.applyArchiveCrossLinks vs the bun
// oracle (the REAL registry.js module-global, exercised through
// `new SwiftOrgAdapter().applyArchiveCrossLinks(...)` — contentJson /
// contentText / relationships pinned byte-for-byte).

import Testing

@testable import ADBuilder

/// `JSON.stringify(section.contentJson)` for `swift-org/documentation` under
/// the full JS registry (swift-docc's three archives register BEFORE
/// swift-book — module-eval order).
private let crossLinksContentJsonOracle =
    "[{\"title\":\"Related Documentation\",\"type\":null,\"items\":[{\"identifier\":\"swift-compiler/documentation/diagnostics\",\"key\":\"swift-compiler/documentation/diagnostics\",\"title\":\"Swift Compiler Diagnostics\",\"abstract\":[{\"type\":\"text\",\"text\":\"Reference for warnings and errors emitted by the Swift compiler, including diagnostic groups and upcoming language features.\"}]},{\"identifier\":\"swift-package-manager/documentation/packagemanagerdocs\",\"key\":\"swift-package-manager/documentation/packagemanagerdocs\",\"title\":\"Swift Package Manager\",\"abstract\":[{\"type\":\"text\",\"text\":\"Full reference for the Swift Package Manager: package manifests, dependencies, build settings, and plug-in APIs.\"}]},{\"identifier\":\"swift-migration-guide/documentation/migrationguide\",\"key\":\"swift-migration-guide/documentation/migrationguide\",\"title\":\"Swift 6 Concurrency Migration Guide\",\"abstract\":[{\"type\":\"text\",\"text\":\"How to migrate existing Swift code to the Swift 6 concurrency model, including data-race safety and incremental adoption.\"}]},{\"identifier\":\"swift-book/The-Swift-Programming-Language\",\"key\":\"swift-book/The-Swift-Programming-Language\",\"title\":\"The Swift Programming Language\",\"abstract\":[{\"type\":\"text\",\"text\":\"The canonical Swift language guide and reference manual.\"}]}]}]"

private let crossLinksContentTextOracle =
    "Swift Compiler Diagnostics: Reference for warnings and errors emitted by the Swift compiler, including diagnostic groups and upcoming language features.\nSwift Package Manager: Full reference for the Swift Package Manager: package manifests, dependencies, build settings, and plug-in APIs.\nSwift 6 Concurrency Migration Guide: How to migrate existing Swift code to the Swift 6 concurrency model, including data-race safety and incremental adoption.\nThe Swift Programming Language: The canonical Swift language guide and reference manual."

@Test func nativeRegistryMatchesJsForSwiftOrgDocumentation() {
    let links = EntryPointRegistry.native.entryPoints(forParent: "swift-org/documentation")
    #expect(links.map(\.key) == [
        "swift-compiler/documentation/diagnostics",
        "swift-package-manager/documentation/packagemanagerdocs",
        "swift-migration-guide/documentation/migrationguide",
        "swift-book/The-Swift-Programming-Language",
    ])
    // Parent filtering: getting-started sees only swiftpm.
    let gettingStarted = EntryPointRegistry.native.entryPoints(forParent: "swift-org/getting-started")
    #expect(gettingStarted.map(\.slug) == ["swift-package-manager"])
    #expect(EntryPointRegistry.native.entryPoints(forParent: "swift-org/install").isEmpty)
}

@Test func registryDedupeMatchesAddEntryPoints() {
    let a = EntryPoint(slug: "a", key: "a/k", title: "A", parents: ["p1", "p2"])
    let aSameSet = EntryPoint(slug: "a2", key: "a/k", title: "A again", parents: ["p2", "p1"])
    let aOtherParents = EntryPoint(slug: "a3", key: "a/k", title: "A other", parents: ["p3"])
    let empty = EntryPoint(slug: "e", key: "", title: "E", parents: ["p"])
    let noParents = EntryPoint(slug: "n", key: "n/k", title: "N", parents: [])
    let registry = EntryPointRegistry(entries: [a, aSameSet, aOtherParents, empty, noParents])
    // Set-equal parents dedupe (first wins); different parents kept; invalid skipped.
    #expect(registry.all.map(\.slug) == ["a", "a3"])
}

@Test func applyArchiveCrossLinksMatchesBunOracle() {
    var page = NormalizedPage(
        document: NormalizedDocument(key: "swift-org/documentation"),
        sections: [NormalizedSection(sectionKind: "content", sortOrder: 0)],
        relationships: [
            NormalizedRelationship(fromKey: "x", toKey: "y", relationType: "child", sortOrder: 0)
        ])
    SwiftOrgAdapter.applyArchiveCrossLinks(
        &page, key: "swift-org/documentation", registry: .native)

    let section = page.sections.last
    #expect(section?.sectionKind == "topics")
    #expect(section?.heading == "Related Documentation")
    #expect(section?.sortOrder == 1)  // max(existing)+1
    #expect(section?.contentText == crossLinksContentTextOracle)
    #expect(section?.contentJson == crossLinksContentJsonOracle)

    // see_also relationships continue the sortOrder after the existing one.
    let added = Array(page.relationships.dropFirst())
    #expect(added.map(\.toKey) == [
        "swift-compiler/documentation/diagnostics",
        "swift-package-manager/documentation/packagemanagerdocs",
        "swift-migration-guide/documentation/migrationguide",
        "swift-book/The-Swift-Programming-Language",
    ])
    #expect(added.allSatisfy { $0.relationType == "see_also" && $0.section == "Related Documentation" })
    #expect(added.map(\.sortOrder) == [1, 2, 3, 4])
    #expect(added.allSatisfy { $0.fromKey == "swift-org/documentation" })
}

@Test func applyArchiveCrossLinksNoopWithoutLinks() {
    var page = NormalizedPage(document: NormalizedDocument(key: "swift-org/install"))
    SwiftOrgAdapter.applyArchiveCrossLinks(&page, key: "swift-org/install", registry: .native)
    #expect(page.sections.isEmpty)
    #expect(page.relationships.isEmpty)
}
