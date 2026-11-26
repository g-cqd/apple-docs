import AemiHTTP
import AppleDocsCore
import AppleDocsStorage
import AppleDocsWeb
import Foundation
import Testing

@Suite("Web links for keys with URL-significant characters (fuzz regression)")
struct WebMarkdownFuzzRegressionTests {
    @Test func `doc hrefs percent-encode characters that are not path-safe`() {
        #expect(WebDocPath.href("swiftui/view") == "/doc/swiftui/view")
        #expect(WebDocPath.href("swift/optional/==(_:_:)-1j2c8") == "/doc/swift/optional/==(_:_:)-1j2c8")
        #expect(WebDocPath.href("apple-archive/x/alu%20notes") == "/doc/apple-archive/x/alu%2520notes")
        #expect(WebDocPath.href("a/b c?d#e") == "/doc/a/b%20c%3Fd%23e")
    }

    /// libFuzzer crash-a8a34627: `[](swibtui/view oneiew)` — the target lands percent-encoded in a quoted href.
    @Test func `markdown links keep targets inside the href attribute`() {
        let html = WebHTMLRenderer.renderMarkdownFragment("2.  [](swibtui/view oneiew)")
        #expect(html.contains(#"<a href="/doc/swibtui/view%20oneiew">"#))
    }

    @Test func `a key containing a percent sign is reachable through its encoded link`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let store = try CorpusStore(path: fixture.databasePath, options: .readWrite)
        _ = try store.upsertDocument(
            DocumentRecord(key: try DocumentKey("swiftui/alu%20notes"), title: "ALU Notes", framework: "swiftui")
        )
        store.close()
        let responder = fixture.responder()
        defer { Task { await responder.close() } }

        let index = String(
            decoding: await responder.respond(to: HTTPRequest(method: .get, path: "/doc/swiftui")).body,
            as: UTF8.self
        )
        #expect(index.contains(#"href="/doc/swiftui/alu%2520notes""#))
        let page = await responder.respond(to: HTTPRequest(method: .get, path: "/doc/swiftui/alu%2520notes"))
        #expect(page.head.status == .ok)
        #expect(String(decoding: page.body, as: UTF8.self).contains("<h1>ALU Notes</h1>"))
    }

    /// libFuzzer crash-90545674 (`FuzzWebMarkdown`): content starting with a combining mark right after `<p>`.
    /// Scanned per code point (as HTML tokenizers do), every tag is renderer-authored with quoted attributes.
    @Test func `tags stay well-formed at the code point level`() {
        let html = WebHTMLRenderer.renderMarkdownFragment(String(decoding: Self.crash90545674, as: UTF8.self))
        for tag in html.utf8.split(separator: UInt8(ascii: "<")).dropFirst() {
            let body = String(decoding: tag.prefix { $0 != UInt8(ascii: ">") }, as: UTF8.self)
            #expect(body.utf8.allSatisfy { $0 < 0x80 }, "non-ASCII inside a tag: \(body)")
            #expect(body.filter { $0 == "\"" }.count % 2 == 0, "\(body)")
            #expect(!body.contains("=") || body.contains("=\""), "\(body)")
        }
    }

    private static let crash90545674: [UInt8] = [
        0x23, 0x20, 0x48, 0x0A, 0x0A, 0xAD, 0x20, 0x65, 0x60, 0x0A, 0x30, 0x2E, 0x20, 0x6F, 0x6E, 0x65, 0x5C, 0x0A,
        0x3E, 0x20, 0x0A, 0x60, 0x0A, 0x31, 0x2D, 0x2D, 0x7C, 0x2D, 0x2D, 0x2D, 0x7C, 0x0A, 0x7C, 0x20, 0x3C, 0x62,
        0x3E, 0x20, 0x7C, 0x20, 0x2A, 0x65, 0x2A, 0x20, 0x7C, 0x0A, 0x0A, 0x60, 0x60, 0x0A, 0x60, 0x3C, 0x6A, 0x73,
        0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3E, 0x0A, 0x60, 0x60, 0x60, 0x2A, 0x20, 0x0A, 0x7C, 0x0A, 0x60, 0x60,
        0x0A, 0x60, 0x3C, 0x6A, 0x73, 0x73, 0x2A, 0x20, 0x7C, 0x0A, 0x0A, 0x60, 0x60, 0x0A, 0x60, 0x3C, 0x6A, 0x73,
        0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3E, 0x0A, 0x60, 0x60, 0x60, 0x73, 0x0A, 0xCC, 0x8C, 0x9C, 0x8D, 0x69,
        0x60, 0x60, 0x60
    ]
}
