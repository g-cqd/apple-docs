import AemiHTTP
import AppleDocsCore
import AppleDocsStorage
import AppleDocsWeb
import Foundation
import Testing

@Suite("Web doc paths for overlong key segments (Bun safeWebDocKey)")
struct WebDocPathTests {
    private static let longSegment =
        "init(alertbody:alertlocalizationkey:alertlocalizationargs:title:titlelocalizationkey:titlelocalizationargs:"
        + "subtitle:subtitlelocalizationkey:subtitlelocalizationargs:alertactionlocalizationkey:alertlaunchimage:"
        + "soundname:desiredkeys:shouldbadge:shouldsendcontentavailable:shouldsendmutablecontent:category:collapseidkey:)"

    @Test func `segments over 200 bytes are truncated to 180 bytes plus a SHA-1 tag, exactly like Bun`() {
        #expect(WebDocPath.safeKey("swiftui/view") == "swiftui/view")
        let mapped = WebDocPath.safeKey("cloudkit/cksubscription/\(Self.longSegment)")
        // Expected value computed by Bun's `safeWebDocKey` (src/lib/safe-path.js).
        #expect(
            mapped
                == "cloudkit/cksubscription/init(alertbody:alertlocalizationkey:alertlocalizationargs:title:titlelocalizationkey:titlelocalizationargs:subtitle:subtitlelocalizationkey:subtitlelocalizationargs:alertactionloca~28178dfad3d6"
        )
    }

    @Test func `pages with overlong segments are linked, served, and exported under the hashed path`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let key = "swiftui/view/\(Self.longSegment)"
        let store = try CorpusStore(path: fixture.databasePath, options: .readWrite)
        _ = try store.upsertDocument(DocumentRecord(key: try DocumentKey(key), title: "init", framework: "swiftui"))
        store.close()
        let mapped = WebDocPath.safeKey(key)
        let responder = fixture.responder()
        defer { Task { await responder.close() } }

        let parent = String(
            decoding: await responder.respond(to: HTTPRequest(method: .get, path: "/doc/swiftui/view")).body,
            as: UTF8.self
        )
        #expect(parent.contains("href=\"/doc/\(mapped)\""))
        let page = await responder.respond(to: HTTPRequest(method: .get, path: "/doc/\(mapped)"))
        #expect(page.head.status == .ok)

        let out = fixture.root.appendingPathComponent("dist").path
        let report = try await StaticSiteBuilder.build(databasePath: fixture.databasePath, outputDirectory: out)
        #expect(report.failures == 0)
        #expect(FileManager.default.fileExists(atPath: "\(out)/doc/\(mapped)/index.html"))
    }
}
