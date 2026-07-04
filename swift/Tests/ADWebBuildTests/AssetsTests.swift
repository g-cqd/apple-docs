import ADJSONCore
import Testing

@testable import ADWebBuild

// S6 asset pipeline: MinifyCss + FontFaces byte-exact vs the bun oracle
// (`bun -e` over src/web/build/minify-css.js and src/web/lib/font-faces.js),
// and the planAssets artifact plan over a mock source. Fixtures are hoisted to
// file scope for the 100ms type-check budget.

// MARK: - fixtures (oracle outputs pinned from bun)

private let minifyFixtureInput =
    "/* c1 */\nbody {\n  color: red ;\n  margin : 0 auto;\n}\n\n/* multi\nline */\na > b , c ~ d + e { x:y }\n.s { padding:0; }\n@media (a:b){.t{q:r;}}\n  spaced   out  \n"
private let minifyFixtureExpected =
    "body{color:red;margin:0 auto}a>b,c~d+e{x:y}.s{padding:0}@media (a:b){.t{q:r}}spaced out"

/// (input, expected) minify pairs, each pinned from the JS `minifyCSS`.
private let minifyEdgeCases: [(String, String)] = [
    ("a{b:c}/* unterminated", "a{b:c}/* unterminated"),  // no closing */ ⇒ no match
    ("x\ty", "x\ty"),  // a SINGLE whitespace char survives as-is
    ("x\t\ty", "x y"),  // 2+ whitespace ⇒ one space
    ("a /* c */ b", "a b"),
    ("p { q : r ; }\r\ns { t:u }", "p{q:r}s{t:u}"),
    ("@media screen and (min-width: 100px) { .a { b: c; } }", "@media screen and (min-width:100px){.a{b:c}}"),
    ("sel::before{content:\"a b\"}", "sel::before{content:\"a b\"}")
]

private let fontFamiliesJSON: JSON? =
    try? ADJSON.parse(
        #"[{"id":"sf-pro","files":[{"id":"sfpro-1","format":"ttf"},{"id":"sfpro 2","format":"otf"}]},{"id":"ny","files":[{"id":"ny&1","format":"ttc"},{"id":"ny2","format":"woff"},{"id":"ny3"}]},{"id":"empty"},{"id":"nofiles","files":[]}]"#,
        options: .init(maxDepth: 512)
    )
    .root

/// `buildFontFaceCss(families)` (default /api/fonts/file/<id> URLs) from bun.
private let fontFacesExpectedDefault =
    "@font-face { font-family: \"apple-docs-sf-pro-sfpro-1\"; src: url(\"/api/fonts/file/sfpro-1\") format(\"truetype\"); font-display: swap; }\n@font-face { font-family: \"apple-docs-sf-pro-sfpro 2\"; src: url(\"/api/fonts/file/sfpro%202\") format(\"opentype\"); font-display: swap; }\n@font-face { font-family: \"apple-docs-ny-ny&1\"; src: url(\"/api/fonts/file/ny%261\") format(\"collection\"); font-display: swap; }\n@font-face { font-family: \"apple-docs-ny-ny2\"; src: url(\"/api/fonts/file/ny2\"); font-display: swap; }\n@font-face { font-family: \"apple-docs-ny-ny3\"; src: url(\"/api/fonts/file/ny3\"); font-display: swap; }"

/// Same families with the static build's baseUrl-prefixed fileUrl, from bun.
private let fontFacesExpectedBaseUrl =
    "@font-face { font-family: \"apple-docs-sf-pro-sfpro-1\"; src: url(\"https://x.test/api/fonts/file/sfpro-1\") format(\"truetype\"); font-display: swap; }\n@font-face { font-family: \"apple-docs-sf-pro-sfpro 2\"; src: url(\"https://x.test/api/fonts/file/sfpro%202\") format(\"opentype\"); font-display: swap; }\n@font-face { font-family: \"apple-docs-ny-ny&1\"; src: url(\"https://x.test/api/fonts/file/ny%261\") format(\"collection\"); font-display: swap; }\n@font-face { font-family: \"apple-docs-ny-ny2\"; src: url(\"https://x.test/api/fonts/file/ny2\"); font-display: swap; }\n@font-face { font-family: \"apple-docs-ny-ny3\"; src: url(\"https://x.test/api/fonts/file/ny3\"); font-display: swap; }"

// MARK: - MinifyCss

@Test func minifyCssFixtureByteExact() {
    #expect(MinifyCss.minify(minifyFixtureInput) == minifyFixtureExpected)
}

@Test func minifyCssEdgeCasesByteExact() {
    for (input, expected) in minifyEdgeCases {
        #expect(MinifyCss.minify(input) == expected)
    }
}

// MARK: - FontFaces

@Test func fontFaceCssByteExact() {
    let defaultUrl = FontFaces.buildFontFaceCss(fontFamiliesJSON) {
        "/api/fonts/file/\(WebHtml.encodeURIComponent($0))"
    }
    #expect(defaultUrl == fontFacesExpectedDefault)

    let withBase = FontFaces.buildFontFaceCss(
        fontFamiliesJSON, fileUrl: FontFaces.buildFileUrl(baseUrl: "https://x.test"))
    #expect(withBase == fontFacesExpectedBaseUrl)
}

@Test func fontFaceCssEmpty() {
    #expect(FontFaces.buildFontFaceCss(nil, fileUrl: FontFaces.buildFileUrl(baseUrl: "")) == "")
}

// MARK: - planAssets

private struct MockAssetSource: AssetSource {
    var assets: [String: String] = [:]
    var workers: [String: String] = [:]
    var publics: [(path: String, bytes: [UInt8])] = []

    func readAsset(_ relative: String) -> [UInt8]? { assets[relative].map { Array($0.utf8) } }
    func readWorker(_ relative: String) -> [UInt8]? { workers[relative].map { Array($0.utf8) } }
    func bundle(assetEntry relative: String) throws -> [UInt8] { Array("BUNDLE(\(relative))".utf8) }
    func publicFiles() throws -> [(path: String, bytes: [UInt8])] { publics }
}

private let mockSource = MockAssetSource(
    assets: [
        "style.css": "a { b : c ; }",
        "search-page.js": "s", "fonts-page.js": "f", "symbols-page.js": "y", "lang-toggle.js": "l"
    ],
    workers: ["search-worker.js": "worker-bytes"],
    publics: [
        (path: ".well-known/security.txt", bytes: Array("sec".utf8)),
        (path: "llms.txt", bytes: Array("llms".utf8))
    ])

@Test func planAssetsOrderAndContent() throws {
    let artifacts = try BuildSite.planAssets(source: mockSource)
    let paths: [String] = artifacts.map(\.path)
    // runAssetPipeline order: CSS, entry bundles, standalone assets, worker
    // files, then the public/ tree at the build root.
    let expected: [String] = [
        "assets/style.css", "assets/core.js", "assets/listing.js",
        "assets/search-page.js", "assets/fonts-page.js", "assets/symbols-page.js", "assets/lang-toggle.js",
        "worker/search-worker.js", ".well-known/security.txt", "llms.txt"
    ]
    #expect(paths == expected)

    let byPath: [String: String] = Dictionary(
        uniqueKeysWithValues: artifacts.map { ($0.path, String(decoding: $0.bytes, as: UTF8.self)) })
    #expect(byPath["assets/style.css"] == "a{b:c}")  // minified
    #expect(byPath["assets/core.js"] == "BUNDLE(core.bundle.js)")  // ENTRY_BUNDLES mapping
    #expect(byPath["assets/lang-toggle.js"] == "BUNDLE(lang-toggle.js)")  // standalone bundles itself
    #expect(byPath["worker/search-worker.js"] == "worker-bytes")  // verbatim, no bundling
    #expect(byPath["llms.txt"] == "llms")
}

@Test func planAssetsSkipsAbsentStandaloneAndRequiresCss() throws {
    // A missing standalone asset is skipped (the JS existsSync guard) …
    var source = mockSource
    source.assets["fonts-page.js"] = nil
    let paths: [String] = try BuildSite.planAssets(source: source).map(\.path)
    #expect(!paths.contains("assets/fonts-page.js"))
    #expect(paths.contains("assets/search-page.js"))

    // … but style.css is required (readFileSync throws in JS).
    source.assets["style.css"] = nil
    #expect(throws: AssetPipelineError.self) {
        try BuildSite.planAssets(source: source)
    }
}
