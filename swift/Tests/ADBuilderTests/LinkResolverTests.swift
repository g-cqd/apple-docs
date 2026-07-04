import Testing

@testable import ADBuilder

// MARK: - mapUrlToKey: one assertion per RULE

@Test func mapsAppleDocumentation() {
    #expect(LinkResolver.mapUrlToKey("https://developer.apple.com/documentation/swiftui/view") == "swiftui/view")
    // Lowercased.
    #expect(LinkResolver.mapUrlToKey("https://developer.apple.com/documentation/SwiftUI/View") == "swiftui/view")
    // Trailing slash stripped.
    #expect(LinkResolver.mapUrlToKey("https://developer.apple.com/documentation/swiftui/view/") == "swiftui/view")
    // Empty rest → nil.
    #expect(LinkResolver.mapUrlToKey("https://developer.apple.com/documentation/") == nil)
}

@Test func mapsAppleDesign() {
    #expect(
        LinkResolver.mapUrlToKey("https://developer.apple.com/design/human-interface-guidelines/buttons")
            == "design/human-interface-guidelines/buttons")
}

@Test func mapsAppleArchive() {
    // Non-index, non-parent terminal html → keep file (ext lowercased).
    #expect(
        LinkResolver.mapUrlToKey("https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Foo.HTML")
            == "apple-archive/documentation/Cocoa/Conceptual/Foo.html")
    // index.html collapses to the directory.
    #expect(
        LinkResolver.mapUrlToKey(
            "https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/index.html")
            == "apple-archive/documentation/Cocoa/Conceptual")
    // base == parent collapses to the directory.
    #expect(
        LinkResolver.mapUrlToKey(
            "https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Conceptual.html")
            == "apple-archive/documentation/Cocoa/Conceptual")
    // No html file → passthrough.
    #expect(
        LinkResolver.mapUrlToKey("https://developer.apple.com/library/archive/AppleApplications/Reference")
            == "apple-archive/AppleApplications/Reference")
}

@Test func mapsWwdcVideos() {
    #expect(
        LinkResolver.mapUrlToKey("https://developer.apple.com/videos/play/wwdc2023/10154/")
            == "wwdc/wwdc2023-10154")
    #expect(
        LinkResolver.mapUrlToKey("https://developer.apple.com/videos/play/wwdc2023/10154")
            == "wwdc/wwdc2023-10154")
    // Extra trailing segment → not the strict WWDC shape → nil.
    #expect(LinkResolver.mapUrlToKey("https://developer.apple.com/videos/play/wwdc2023/10154/extra") == nil)
}

@Test func mapsDocsSwiftOrg() {
    #expect(
        LinkResolver.mapUrlToKey(
            "https://docs.swift.org/swift-book/documentation/the-swift-programming-language/thebasics")
            == "swift-book/documentation/the-swift-programming-language/thebasics")
    #expect(LinkResolver.mapUrlToKey("https://docs.swift.org/swift-book/") == "swift-book")
    #expect(LinkResolver.mapUrlToKey("https://docs.swift.org/compiler/llvm") == "swift-compiler/llvm")
    #expect(LinkResolver.mapUrlToKey("https://docs.swift.org/swiftpm/manifest") == "swift-package-manager/manifest")
}

@Test func mapsSwiftOrgMigrationAndEvolution() {
    #expect(LinkResolver.mapUrlToKey("https://swift.org/migration/foo") == "swift-migration-guide/foo")
    #expect(
        LinkResolver.mapUrlToKey("https://swift.org/swift-evolution/proposals/0001-keywords-as-argument-labels.html")
            == "swift-evolution/0001-keywords-as-argument-labels")
    #expect(
        LinkResolver.mapUrlToKey(
            "https://github.com/apple/swift-evolution/blob/main/proposals/0001-keywords-as-argument-labels.md")
            == "swift-evolution/0001-keywords-as-argument-labels")
    #expect(
        LinkResolver.mapUrlToKey(
            "https://github.com/swiftlang/swift-evolution/tree/main/proposals/0400-init-accessors.md")
            == "swift-evolution/0400-init-accessors")
}

@Test func mapsSwiftOrgRedirectsBeforeGenericRules() {
    #expect(
        LinkResolver.mapUrlToKey("https://swift.org/documentation/tspl") == "swift-book/The-Swift-Programming-Language")
    #expect(
        LinkResolver.mapUrlToKey("https://www.swift.org/documentation/concurrency")
            == "swift-migration-guide/documentation/migrationguide")
}

@Test func mapsUnknownToNil() {
    #expect(LinkResolver.mapUrlToKey("https://example.com/whatever") == nil)
    #expect(LinkResolver.mapUrlToKey("not a url") == nil)
    #expect(LinkResolver.mapUrlToKey("") == nil)
}

// MARK: - resolve (the createLinkResolver callback)

@Test func resolveBailsOnNonRewritableSchemes() {
    let r = LinkResolver()
    #expect(r.resolve("mailto:a@b.com") == "mailto:a@b.com")
    #expect(r.resolve("tel:+1234") == "tel:+1234")
    #expect(r.resolve("#section") == "#section")
    #expect(r.resolve("") == "")
}

@Test func resolveInternalizesKnownPatterns() {
    // knownKeys = nil → trust the pattern.
    let trust = LinkResolver()
    #expect(trust.resolve("https://developer.apple.com/documentation/swiftui/view") == "/docs/swiftui/view/")
    // Fragment carried through.
    #expect(
        trust.resolve("https://developer.apple.com/documentation/swiftui/view#init")
            == "/docs/swiftui/view/#init")
}

@Test func resolveVerifiesAgainstKnownKeys() {
    let known = LinkResolver(knownKeys: ["swiftui/view"])
    #expect(known.resolve("https://developer.apple.com/documentation/swiftui/view") == "/docs/swiftui/view/")
    // Candidate not in knownKeys → external passthrough.
    #expect(
        known.resolve("https://developer.apple.com/documentation/swiftui/missing")
            == "https://developer.apple.com/documentation/swiftui/missing")
}

@Test func resolveLeavesInternalDocsAlone() {
    let r = LinkResolver(sourceURL: "https://host.example/page")
    #expect(r.resolve("/docs/foo/bar/") == "/docs/foo/bar/")
}

@Test func resolveSwiftOrgCuratedPaths() {
    let r = LinkResolver(swiftOrgPaths: ["getting-started"])
    #expect(r.resolve("https://swift.org/getting-started/") == "/docs/swift-org/getting-started/")
    // Not curated → external.
    #expect(r.resolve("https://swift.org/blog/") == "https://swift.org/blog/")
}

@Test func resolveRelativeAgainstBase() {
    let r = LinkResolver(sourceURL: "https://developer.apple.com/documentation/swiftui/")
    #expect(r.resolve("view") == "/docs/swiftui/view/")
}

// MARK: - classify (link audit)

@Test func classifyCategories() {
    let known: Set<String> = ["swiftui/view"]
    #expect(LinkResolver.classify("#frag", knownKeys: known) == .fragment)
    #expect(LinkResolver.classify("", knownKeys: known) == .relativeBroken(normalized: nil))
    #expect(LinkResolver.classify("mailto:a@b.com", knownKeys: known) == .external(normalized: "mailto:a@b.com"))
    #expect(LinkResolver.classify("/docs/swiftui/view", knownKeys: known) == .internalOk(key: "swiftui/view"))
    #expect(
        LinkResolver.classify("/docs/swiftui/missing/", knownKeys: known)
            == .internalBroken(key: "swiftui/missing"))
    #expect(LinkResolver.classify("/elsewhere", knownKeys: known) == .relativeBroken(normalized: "/elsewhere"))
    #expect(
        LinkResolver.classify("https://developer.apple.com/documentation/swiftui/view", knownKeys: known)
            == .externalResolvable(
                key: "swiftui/view", normalized: "https://developer.apple.com/documentation/swiftui/view"))
    #expect(
        LinkResolver.classify("https://example.com/x", knownKeys: known)
            == .external(normalized: "https://example.com/x"))
}
