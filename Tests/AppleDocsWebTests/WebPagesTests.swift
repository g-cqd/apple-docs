import AemiHTTP
import AppleDocsWeb
import Foundation
import Testing

@Suite("Web UI pages")
struct WebPagesTests {
    private func get(_ responder: WebHTTPResponder, _ path: String) async -> (HTTPStatus, String, HTTPFields) {
        let response = await responder.respond(to: HTTPRequest(method: .get, path: path))
        return (response.head.status, String(decoding: response.body, as: UTF8.self), response.head.headerFields)
    }

    @Test func `shared layout links bundled assets that are served with their media types`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let responder = fixture.responder()
        defer { Task { await responder.close() } }

        let (status, html, _) = await get(responder, "/")
        #expect(status == .ok)
        #expect(html.contains(#"<link rel="stylesheet" href="/assets/style.css">"#))
        #expect(html.contains(#"<script src="/assets/app.js"></script>"#))
        #expect(
            html.contains(#"href="/search""#) && html.contains(#"href="/symbols""#) && html.contains(#"href="/fonts""#)
        )
        #expect(html.contains("data-theme-toggle"))
        #expect(html.contains(#"href="/doc/swiftui""#))

        let (cssStatus, css, cssHeaders) = await get(responder, "/assets/style.css")
        #expect(cssStatus == .ok && cssHeaders[.contentType] == "text/css; charset=utf-8" && css.contains("--accent"))
        let (jsStatus, js, jsHeaders) = await get(responder, "/assets/app.js")
        #expect(jsStatus == .ok && jsHeaders[.contentType] == "text/javascript; charset=utf-8")
        #expect(js.contains("localStorage"))
        #expect(await get(responder, "/assets/../Package.swift").0 == .notFound)
    }

    @Test func `search page lists linked results and escapes the echoed query`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let responder = fixture.responder()
        defer { Task { await responder.close() } }

        let (status, html, _) = await get(responder, "/search?q=View")
        #expect(status == .ok)
        #expect(html.contains(#"<a href="/doc/swiftui/view">View</a>"#))
        #expect(html.contains(#"value="View""#))

        let (_, hostile, _) = await get(responder, "/search?q=%3Cscript%3Ex%3C%2Fscript%3E")
        #expect(hostile.contains("&lt;script&gt;x&lt;/script&gt;"))
        #expect(!hostile.contains("<script>x</script>"))

        let (emptyStatus, empty, _) = await get(responder, "/search")
        #expect(emptyStatus == .ok && empty.contains(#"name="q""#))
    }

    @Test func `document page renders breadcrumbs, safe Markdown blocks, linked related documents and children`()
        async throws
    {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let responder = fixture.responder()
        defer { Task { await responder.close() } }

        let (status, html, _) = await get(responder, "/doc/swiftui/view")
        #expect(status == .ok)
        #expect(html.contains(#"<nav class="breadcrumbs""#))
        #expect(html.contains(#"<a href="/doc/swiftui">SwiftUI</a>"#))
        #expect(html.contains("<code>body</code>"))
        #expect(html.contains("&lt;b&gt;views&lt;/b&gt;"))
        #expect(html.contains("<li>First item</li>"))
        #expect(html.contains(#"<pre><code class="language-swift">struct A: View {}</code></pre>"#))
        #expect(html.contains("<h3>Related Views</h3>"))
        #expect(html.contains(#"<a href="/doc/swiftui/text">Text</a>"#))
        #expect(!html.contains("/doc/swiftui/missing"))
        #expect(html.contains(#"<a href="/doc/swiftui/view/body-8kl5o">body</a>"#))
        #expect(await get(responder, "/doc/swiftui/view/").0 == .ok)
    }

    @Test func `framework without a root document renders its tree; unknown pages get a styled 404`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let responder = fixture.responder()
        defer { Task { await responder.close() } }

        let (status, html, _) = await get(responder, "/doc/swiftui")
        #expect(status == .ok)
        #expect(html.contains("<h1>SwiftUI</h1>"))
        #expect(html.contains(#"<a href="/doc/swiftui/view">View</a>"#))
        #expect(!html.contains(#"<a href="/doc/swiftui/view/body-8kl5o">"#))

        let (missing, page, headers) = await get(responder, "/doc/nothing/here")
        #expect(missing == .notFound)
        #expect(headers[.contentType] == "text/html; charset=utf-8")
        #expect(page.contains("Page not found") && page.contains("/assets/style.css"))
        #expect(await get(responder, "/nope").0 == .notFound)
    }

    @Test func `sitemap index and per-framework url sets use the configured base URL`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let responder = fixture.responder(baseURL: "https://docs.example/")
        defer { Task { await responder.close() } }

        let (status, index, headers) = await get(responder, "/sitemap.xml")
        #expect(status == .ok && headers[.contentType] == "application/xml; charset=utf-8")
        #expect(index.contains("<sitemapindex"))
        #expect(index.contains("<loc>https://docs.example/sitemaps/swiftui.xml</loc>"))

        let (setStatus, urlset, _) = await get(responder, "/sitemaps/swiftui.xml")
        #expect(setStatus == .ok)
        #expect(urlset.contains("<loc>https://docs.example/doc/swiftui</loc>"))
        #expect(urlset.contains("<loc>https://docs.example/doc/swiftui/view</loc>"))
        #expect(await get(responder, "/sitemaps/..%2Fetc.xml").0 == .notFound)
        #expect(await get(responder, "/sitemaps/unknown.xml").0 == .notFound)
    }

    @Test func `symbols and fonts pages list assets and symbol SVGs are served sandboxed`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let responder = fixture.responder()
        defer { Task { await responder.close() } }

        let (status, html, _) = await get(responder, "/symbols?q=star")
        #expect(status == .ok)
        #expect(html.contains(#"src="/symbols/public/star.fill.svg""#))
        #expect(html.contains("star.fill"))

        let (svgStatus, svg, headers) = await get(responder, "/symbols/public/star.fill.svg")
        #expect(svgStatus == .ok && svg.contains("<svg"))
        #expect(headers[.contentType] == "image/svg+xml")
        #expect(headers[.contentSecurityPolicy]?.contains("default-src 'none'") == true)
        #expect(await get(responder, "/symbols/public/..%2F..%2Fcorpus.svg").0 == .notFound)
        #expect(await get(responder, "/symbols/public/missing.svg").0 == .notFound)

        let (fontsStatus, fonts, _) = await get(responder, "/fonts")
        #expect(fontsStatus == .ok && fonts.contains("SF Pro") && fonts.contains("SF-Pro.ttf"))
    }

    @Test func `imported sections render from content_json and topics link through child relationships`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let responder = fixture.responder()
        defer { Task { await responder.close() } }

        let (status, html, _) = await get(responder, "/doc/swiftui/text")
        #expect(status == .ok)
        #expect(
            html.contains(#"<p>Displays <code>String</code> values in a <a href="/doc/swiftui/view">View</a>.</p>"#)
        )
        #expect(!html.contains("flattened"))
        #expect(
            html.contains(
                #"<h2>Mentioned in</h2><ul class="link-list"><li><a href="/doc/swiftui/view">Laying out views</a>"#
            )
        )
        #expect(
            html.contains(
                #"<h2>Topics</h2><h3>Creating Text</h3><ul class="link-list"><li><a href="/doc/swiftui/view">View</a>"#
            )
        )
        #expect(!html.contains("Creating Text View"))
    }
}
