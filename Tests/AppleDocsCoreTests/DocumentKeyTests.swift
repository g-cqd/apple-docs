import AppleDocsCore
import AppleDocsOutput
import AppleDocsSetup
import AppleDocsSetupDarwin
import AppleDocsStorage
import Testing

@Suite("DocumentKey & Core Contracts")
struct DocumentKeyTests {
    @Test func `normalizes valid document keys to lowercase and extracts root slug`() throws {
        let key = try DocumentKey("SwiftUI/View")
        #expect(key.rawValue == "swiftui/view")
        #expect(key.rootSlug == "swiftui")

        let single = try DocumentKey("  Foundation  ")
        #expect(single.rawValue == "foundation")
        #expect(single.rootSlug == "foundation")
    }

    @Test(arguments: [
        ("", DocumentKeyError.empty),
        ("   ", DocumentKeyError.empty),
        ("/etc/passwd", DocumentKeyError.absolutePath),
        ("~/secret", DocumentKeyError.absolutePath),
        ("swiftui\\view", DocumentKeyError.backslash),
        ("swiftui/view\u{0000}tail", DocumentKeyError.controlCharacter),
        ("swiftui/view\n", DocumentKeyError.controlCharacter),
        ("swiftui//view", DocumentKeyError.emptySegment),
        ("swiftui/view/", DocumentKeyError.emptySegment),
        ("../outside", DocumentKeyError.pathTraversal),
        ("swiftui/./view", DocumentKeyError.pathTraversal),
        ("swiftui/../uikit/uiview", DocumentKeyError.pathTraversal)
    ])
    func `rejects hostile or malformed keys with typed errors`(
        input: String,
        expected: DocumentKeyError
    ) {
        #expect(throws: expected) {
            _ = try DocumentKey(input)
        }
    }

    @Test func `rejects keys exceeding maximum UTF-8 byte length`() {
        let oversized = String(repeating: "a", count: DocumentKey.maximumByteCount + 1)
        #expect(throws: DocumentKeyError.exceedsMaxLength(limit: DocumentKey.maximumByteCount)) {
            _ = try DocumentKey(oversized)
        }
    }

    @Test func `public document summary omits false boolean flags`() throws {
        let key = try DocumentKey("swiftui/navigationstack")
        let summary = PublicDocumentSummary(key: key, title: "NavigationStack", sourceType: .appleDocC)
        #expect(summary.path == "swiftui/navigationstack")
        #expect(summary.rootSlug == "swiftui")
        #expect(summary.isDeprecated == nil)
        #expect(summary.isBeta == nil)
    }

    @Test func `darwin setup host reflects current OS capabilities`() {
        let caps = DarwinSetupHost.capabilities
        #expect(caps.supportsSnapshotInstall)
        #expect(caps.supportsUpstreamCrawl)
        #if os(macOS)
            #expect(caps.supportsCoreGlyphsPrerender)
            #expect(caps.supportsAppleDMGExtract)
            #expect(caps.supportsLocalXcodeMobileAsset)
        #else
            #expect(!caps.supportsCoreGlyphsPrerender)
            #expect(!caps.supportsAppleDMGExtract)
            #expect(!caps.supportsLocalXcodeMobileAsset)
        #endif
        #expect(CorpusSchemaVersion.swiftV1 < CorpusSchemaVersion.legacyBunV31)
    }
}
