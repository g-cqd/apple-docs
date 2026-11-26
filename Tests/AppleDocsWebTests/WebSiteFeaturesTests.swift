import AemiHTTP
import AppleDocsCore
import AppleDocsStorage
import AppleDocsWeb
import Foundation
import Testing

@Suite("Web UI: base path, language toggle, static search")
struct WebSiteFeaturesTests {
    @Test func `base URL path prefixes every root-relative link and is stripped from requests`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let responder = fixture.responder(baseURL: "https://example.github.io/apple-docs/")
        defer { Task { await responder.close() } }

        let response = await responder.respond(to: HTTPRequest(method: .get, path: "/apple-docs/doc/swiftui/view"))
        let html = String(decoding: response.body, as: UTF8.self)
        #expect(response.head.status == .ok)
        #expect(html.contains(#"<link rel="stylesheet" href="/apple-docs/assets/style.css">"#))
        #expect(html.contains(#"<a href="/apple-docs/doc/swiftui/text">Text</a>"#))
        #expect(html.contains(#"action="/apple-docs/search""#))
        #expect(html.contains(#"data-base="/apple-docs""#))
        #expect(!html.contains(#"href="/doc/"#))

        let asset = await responder.respond(to: HTTPRequest(method: .get, path: "/apple-docs/assets/app.js"))
        #expect(asset.head.status == .ok)
        let sitemap = await responder.respond(to: HTTPRequest(method: .get, path: "/apple-docs/sitemaps/swiftui.xml"))
        #expect(
            String(decoding: sitemap.body, as: UTF8.self)
                .contains("https://example.github.io/apple-docs/doc/swiftui/view")
        )
        #expect(
            await responder.respond(to: HTTPRequest(method: .get, path: "/doc/swiftui/view")).head.status == .notFound
        )
    }

    @Test func `declarations in several languages render variants with a language toggle`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let store = try CorpusStore(path: fixture.databasePath, options: .readWrite)
        let id = try store.upsertDocument(
            DocumentRecord(key: try DocumentKey("foundation/nsstring"), title: "NSString", framework: "foundation")
        )
        try store.replaceSections(
            forDocumentID: id,
            sections: [
                DocumentSectionRecord(
                    sectionKind: "declaration",
                    heading: "Declaration",
                    contentText: "class NSString",
                    contentJSON: #"""
                        [{"languages":["swift"],"tokens":[{"kind":"keyword","text":"class"},{"kind":"text","text":" NSString"}]},
                         {"languages":["occ"],"tokens":[{"kind":"keyword","text":"@interface"},{"kind":"text","text":" NSString : NSObject"}]}]
                        """#,
                    sortOrder: 1
                )
            ]
        )
        store.close()
        let responder = fixture.responder()
        defer { Task { await responder.close() } }

        let response = await responder.respond(to: HTTPRequest(method: .get, path: "/doc/foundation/nsstring"))
        let html = String(decoding: response.body, as: UTF8.self)
        #expect(html.contains(#"data-languages="swift,occ""#))
        #expect(
            html.contains(#"<button type="button" class="lang-btn" data-lang="occ" aria-pressed="false">ObjC</button>"#)
        )
        #expect(
            html.contains(
                #"<div class="decl-variant" data-lang="swift"><pre><code class="language-swift">class NSString</code></pre></div>"#
            )
        )
        #expect(
            html.contains(
                #"<div class="decl-variant" data-lang="occ" hidden><pre><code class="language-occ">@interface NSString : NSObject</code></pre></div>"#
            )
        )
    }

    @Test func `static export ships a columnar title index and a client-side search page`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let out = fixture.root.appendingPathComponent("dist").path
        _ = try await StaticSiteBuilder.build(
            databasePath: fixture.databasePath,
            outputDirectory: out,
            options: StaticSiteBuilder.Options(site: WebSiteConfiguration(baseURL: "https://docs.example"))
        )
        let index = try String(contentsOfFile: "\(out)/search/title-index.json", encoding: .utf8)
        #expect(
            index.hasPrefix(
                #"{"v":2,"frameworks":["swiftui"],"keys":["swiftui/text","swiftui/view","swiftui/view/body-8kl5o"]"#
            )
        )
        #expect(index.contains(#""titles":["Text","View","body"]"#))
        let page = try String(contentsOfFile: "\(out)/search/index.html", encoding: .utf8)
        #expect(page.contains(#"data-static-search="/search/title-index.json""#))
        let js = try String(contentsOfFile: "\(out)/assets/app.js", encoding: .utf8)
        #expect(js.contains("data-static-search"))
    }
}
