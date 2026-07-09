// Pure-helper gates for the MobileAsset docs port (src/sources/mobileasset-docs.js):
// URI normalization, the IEEE-noise-tolerant version formatter, the USR language
// probe, encodeVersion, and root source-type derivation. The merge itself (SQL row
// outcomes over a synthesized asset) is gated in ADWriteTests/XcodeDocsEnrichTests.

import Foundation
import Testing

@testable import ADStorage

@Suite("MobileAssetDocs helpers")
struct MobileAssetDocsUnitTests {
    @Test(
        "normalizeAssetUri strips the leading slash + documentation/ prefix and lowercases",
        arguments: [
            ("/documentation/SwiftUI/View", "swiftui/view"),
            ("documentation/SwiftUI/View", "swiftui/view"),
            ("/design/Human-Interface-Guidelines/accessibility", "design/human-interface-guidelines/accessibility"),
            ("/Documentation/Foo", "foo"),  // the prefix probe is case-insensitive (JS toLowerCase check)
            ("/documentation/", ""),
            ("", "")
        ])
    func normalizeAssetUriCases(input: String, expected: String) {
        #expect(MobileAssetDocs.normalizeAssetUri(input) == expected)
    }

    @Test(
        "formatVersion rounds IEEE noise to 2 decimals and strips trailing zeros",
        arguments: [
            (13.0, "13.0"),
            (10.15, "10.15"),
            (17.199_999_999_999_999, "17.2"),
            (17.1, "17.1"),
            (26.0, "26.0"),
            (1.0, "1.0")
        ])
    func formatVersionCases(input: Double, expected: String) {
        #expect(MobileAssetDocs.formatVersion(input) == expected)
    }

    @Test("formatVersion rejects non-positive and non-finite input")
    func formatVersionRejects() {
        #expect(MobileAssetDocs.formatVersion(0) == nil)
        #expect(MobileAssetDocs.formatVersion(-1) == nil)
        #expect(MobileAssetDocs.formatVersion(.infinity) == nil)
        #expect(MobileAssetDocs.formatVersion(.nan) == nil)
    }

    @Test("languageFromUsr maps the USR prefix")
    func languageFromUsrCases() {
        #expect(MobileAssetDocs.languageFromUsr("s:7SwiftUI4ViewP") == "swift")
        #expect(MobileAssetDocs.languageFromUsr("c:objc(cs)UIView") == "occ")
        #expect(MobileAssetDocs.languageFromUsr("x:whatever") == nil)
        #expect(MobileAssetDocs.languageFromUsr(nil) == nil)
    }

    @Test(
        "encodeVersion matches lib/version-encode.js",
        arguments: [
            ("13.0", Int64(13_000_000)),
            ("17.2", Int64(17_002_000)),
            ("10.15", Int64(10_015_000)),
            ("10.15.1", Int64(10_015_001)),
            ("1.0", Int64(1_000_000))
        ])
    func encodeVersionCases(input: String, expected: Int64) {
        #expect(MobileAssetDocs.encodeVersion(input) == expected)
    }

    @Test("encodeVersion rejects missing / unparseable / out-of-range input")
    func encodeVersionRejects() {
        #expect(MobileAssetDocs.encodeVersion(nil) == nil)
        #expect(MobileAssetDocs.encodeVersion("") == nil)
        #expect(MobileAssetDocs.encodeVersion("beta") == nil)
        #expect(MobileAssetDocs.encodeVersion("1000.0") == nil)  // component >= 1000
    }

    @Test("deriveRootSourceType: slug map first, then kind, then apple-docc")
    func deriveRootSourceTypeCases() {
        #expect(MobileAssetDocs.deriveRootSourceType(slug: "design", kind: "framework") == "hig")
        #expect(MobileAssetDocs.deriveRootSourceType(slug: "wwdc", kind: "framework") == "wwdc")
        #expect(MobileAssetDocs.deriveRootSourceType(slug: "swiftui", kind: "framework") == "apple-docc")
        #expect(MobileAssetDocs.deriveRootSourceType(slug: "x", kind: "guidelines") == "guidelines")
    }

    @Test("findDocumentationAssets is empty for a missing or asset-less root")
    func findAssetsAbsence() throws {
        #expect(MobileAssetDocs.findDocumentationAssets(rootDir: "/nonexistent-root-xyz").isEmpty)
        let empty = FileManager.default.temporaryDirectory
            .appendingPathComponent("mad-empty-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: empty) }
        #expect(MobileAssetDocs.findDocumentationAssets(rootDir: empty.path).isEmpty)
    }
}
