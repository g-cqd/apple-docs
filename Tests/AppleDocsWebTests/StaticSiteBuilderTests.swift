import AppleDocsWeb
import Foundation
import Testing

@Suite("Static site export")
struct StaticSiteBuilderTests {
    private func read(_ root: String, _ relative: String) throws -> String {
        try String(contentsOfFile: "\(root)/\(relative)", encoding: .utf8)
    }

    private func options(limit: Int = 1_000, concurrency: Int = 4, fixture: WebCorpusFixture)
        -> StaticSiteBuilder.Options
    {
        StaticSiteBuilder.Options(
            limit: limit,
            site: WebSiteConfiguration(baseURL: "https://docs.example"),
            resourcesDirectory: fixture.resourcesDirectory,
            concurrency: concurrency
        )
    }

    @Test func `exports pages, assets, sitemaps, symbols, fonts and discovery files in parallel`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let out = fixture.root.appendingPathComponent("dist").path

        let report = try await StaticSiteBuilder.build(
            databasePath: fixture.databasePath,
            outputDirectory: out,
            options: options(fixture: fixture)
        )
        #expect(report.frameworksExported == 1)
        #expect(report.pagesExported == 4)  // 3 documents + the swiftui framework page
        #expect(report.failures == 0)

        #expect(try read(out, "index.html").contains(#"href="/doc/swiftui""#))
        #expect(try read(out, "404.html").contains("Page not found"))
        #expect(try read(out, "assets/style.css").contains("--accent"))
        #expect(try read(out, "assets/app.js").contains("localStorage"))
        #expect(try read(out, "doc/swiftui/index.html").contains("<h1>SwiftUI</h1>"))
        #expect(try read(out, "doc/swiftui/view/index.html").contains("&lt;b&gt;views&lt;/b&gt;"))
        #expect(try read(out, "doc/swiftui/view/body-8kl5o/index.html").contains("<h1>body</h1>"))
        #expect(try read(out, "sitemap.xml").contains("<loc>https://docs.example/sitemaps/swiftui.xml</loc>"))
        #expect(try read(out, "sitemaps/swiftui.xml").contains("<loc>https://docs.example/doc/swiftui/view</loc>"))
        #expect(try read(out, "sitemaps/_root.xml").contains("<loc>https://docs.example/</loc>"))
        #expect(try read(out, "robots.txt").contains("Sitemap: https://docs.example/sitemap.xml"))
        #expect(try read(out, "symbols/index.html").contains("star.fill"))
        #expect(try read(out, "symbols/public/star.fill.svg").contains("<svg"))
        #expect(try read(out, "fonts/index.html").contains("SF Pro"))
        #expect(try read(out, "search/index.html").contains(#"name="q""#))
        #expect(try read(out, "api/frameworks.json").contains("swiftui"))
        #expect(try read(out, ".well-known/security.txt").contains("Contact:"))
        #expect(FileManager.default.fileExists(atPath: "\(out)/\(StaticSiteBuilder.markerFileName)"))
    }

    @Test func `rebuild swaps the whole output atomically and leaves no staging directories`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let out = fixture.root.appendingPathComponent("dist").path
        _ = try await StaticSiteBuilder.build(
            databasePath: fixture.databasePath,
            outputDirectory: out,
            options: options(fixture: fixture)
        )
        try FileManager.default.createDirectory(atPath: "\(out)/doc/stale", withIntermediateDirectories: true)
        try Data("old".utf8).write(to: URL(fileURLWithPath: "\(out)/doc/stale/index.html"))

        let report = try await StaticSiteBuilder.build(
            databasePath: fixture.databasePath,
            outputDirectory: out,
            options: options(limit: 1, concurrency: 1, fixture: fixture)
        )
        #expect(report.pagesExported == 2)  // 1 document + the framework page
        #expect(!FileManager.default.fileExists(atPath: "\(out)/doc/stale/index.html"))
        let siblings = try FileManager.default.contentsOfDirectory(atPath: fixture.root.path)
        #expect(siblings.contains("dist") && !siblings.contains { $0.hasPrefix(".") })
    }

    @Test func `refuses to replace a non-empty directory that is not a previous export`() async throws {
        let fixture = try WebCorpusFixture()
        defer { fixture.remove() }
        let out = fixture.root.appendingPathComponent("precious").path
        try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        try Data("keep me".utf8).write(to: URL(fileURLWithPath: "\(out)/notes.txt"))

        await #expect(throws: StaticSiteBuilder.BuildError.self) {
            _ = try await StaticSiteBuilder.build(
                databasePath: fixture.databasePath,
                outputDirectory: out,
                options: options(fixture: fixture)
            )
        }
        #expect(try read(out, "notes.txt") == "keep me")
        let siblings = try FileManager.default.contentsOfDirectory(atPath: fixture.root.path)
        #expect(!siblings.contains { $0.hasPrefix(".") })
    }
}
