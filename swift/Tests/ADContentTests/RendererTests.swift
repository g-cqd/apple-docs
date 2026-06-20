// Byte-pinned against the JS implementation (the expectations below were generated
// by running the JS renderers on these exact inputs). The committed fixture corpus
// + full-corpus A/B are the real parity gates; these pin the constructed edge cases.

import ADJSONCore
import ADTestKit
import Testing

@testable import ADContent

// MARK: - Span shims (tests speak Strings; the renderers speak spans)

private struct Arena {
    var bytes: [UInt8] = []
    var ranges: [Range<Int>?] = []

    mutating func add(_ value: String?) -> Int {
        guard let value else {
            ranges.append(nil)
            return ranges.count - 1
        }
        let start = bytes.count
        bytes.append(contentsOf: Array(value.utf8))
        ranges.append(start ..< bytes.count)
        return ranges.count - 1
    }

    func span(_ buffer: UnsafeRawBufferPointer, _ index: Int) -> ByteSpan? {
        guard let range = ranges[index] else { return nil }
        return ByteSpan(rebasing: buffer[range])
    }
}

private func renderDoc(
    key: String?, title: String?, framework: String?, frameworkDisplay: String?,
    role: String?, roleHeading: String?, platformsJson: String?,
    sections: [(kind: String?, heading: String?, text: String, json: String?, sort: Double)],
    includeFrontMatter: Bool = true, includeTitle: Bool = true
) -> String {
    var arena = Arena()
    let docIdx = [key, title, framework, frameworkDisplay, role, roleHeading, platformsJson]
        .map {
            arena.add($0)
        }
    let sectIdx = sections.map {
        (arena.add($0.kind), arena.add($0.heading), arena.add($0.text), arena.add($0.json), $0.sort)
    }
    let arenaBytes = arena.bytes
    return arenaBytes.withUnsafeBytes { raw in
        let buffer = ByteSpan(raw)
        let empty = ByteSpan(start: nil, count: 0)
        let document = DocFieldSpans(
            key: arena.span(buffer, docIdx[0]), title: arena.span(buffer, docIdx[1]),
            framework: arena.span(buffer, docIdx[2]), frameworkDisplay: arena.span(buffer, docIdx[3]),
            role: arena.span(buffer, docIdx[4]), roleHeading: arena.span(buffer, docIdx[5]),
            platformsJson: arena.span(buffer, docIdx[6]))
        let sects = sectIdx.map { idx in
            SectionSpans(
                kind: arena.span(buffer, idx.0), heading: arena.span(buffer, idx.1),
                text: arena.span(buffer, idx.2) ?? empty, json: arena.span(buffer, idx.3),
                sortOrder: idx.4)
        }
        var w = ByteWriter()
        var sectionW = ByteWriter()
        var out: [UInt8] = []
        DocMarkdown.render(
            document: document, sections: sects,
            options: .init(includeFrontMatter: includeFrontMatter, includeTitle: includeTitle),
            w: &w, sectionW: &sectionW, out: &out)
        return String(decoding: out, as: UTF8.self)
    }
}

private func renderPlain(
    title: String?, abstractText: String?, declarationText: String?, headings: String?,
    sections: [(heading: String?, text: String, sort: Double)]
) -> String {
    var arena = Arena()
    let docIdx = [title, abstractText, declarationText, headings].map { arena.add($0) }
    let sectIdx = sections.map { (arena.add($0.heading), arena.add($0.text), $0.sort) }
    let arenaBytes = arena.bytes
    return arenaBytes.withUnsafeBytes { raw in
        let buffer = ByteSpan(raw)
        let empty = ByteSpan(start: nil, count: 0)
        let document = PlainTextSpans(
            title: arena.span(buffer, docIdx[0]), abstractText: arena.span(buffer, docIdx[1]),
            declarationText: arena.span(buffer, docIdx[2]), headings: arena.span(buffer, docIdx[3]))
        let sects = sectIdx.map { idx in
            PlainSectionSpans(
                heading: arena.span(buffer, idx.0), text: arena.span(buffer, idx.1) ?? empty,
                sortOrder: idx.2)
        }
        var w = ByteWriter()
        var out: [UInt8] = []
        PlainText.render(document: document, sections: sects, w: &w, out: &out)
        return String(decoding: out, as: UTF8.self)
    }
}

private func renderPageString(_ json: String, path: String) throws -> String {
    let bytes = Array(json.utf8)
    return try bytes.withUnsafeBytes { raw in
        let doc = try ADJSON.parse(raw, options: .init(maxDepth: 512))
        return PageMarkdown.render(doc.root, canonicalPath: path)
    }
}

// MARK: - Tests

struct DocMarkdownTests {
    static let sections: [(kind: String?, heading: String?, text: String, json: String?, sort: Double)] = [
        ("discussion", nil, "Line one\nline two\n\nPara two.", nil, 2),
        ("abstract", nil, "  A type that represents a view.  ", nil, 0),
        (
            "declaration", nil, "",
            #"[{"tokens":[{"text":"protocol "},{"text":"View"}],"languages":["swift"]}]"#, 1
        ),
        (
            "topics", nil, "",
            #"[{"title":"Creating","items":[{"key":"swiftui/text","title":"Text"},{"title":"No key"}]}]"#, 3
        ),
        ("custom_kind", nil, "custom body", nil, 4),
        (
            "parameters", nil, "",
            #"[{"name":"content","content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"The  content"}]}]},{}]"#,
            5
        )
    ]

    static func render(includeFrontMatter: Bool = true, includeTitle: Bool = true) -> String {
        renderDoc(
            key: "swiftui/view", title: "View", framework: "swiftui", frameworkDisplay: nil,
            role: "symbol", roleHeading: "Protocol",
            platformsJson: #"{"ios":"13.0","macos":"10.15","weird":null}"#,
            sections: sections, includeFrontMatter: includeFrontMatter, includeTitle: includeTitle)
    }

    @Test func fullDocumentMatchesJs() {
        let want = """
            ---
            title: View
            framework: swiftui
            role: symbol
            role_heading: Protocol
            platforms: [iOS 13.0+, macOS 10.15+, weird]
            path: swiftui/view
            ---

            # View

            A type that represents a view.

            ## Declaration

            ```swift
            protocol View
            ```

            ## Overview

            Line one line two

            Para two.

            ## Topics

            ### Creating

            - [Text](swiftui/text.md)
            - No key

            ## Custom Kind

            custom body

            ## Parameters

            - `content`: The content
            - `Value`:

            """
        #expect(Self.render() == want)
    }

    @Test func bareDocumentSkipsFrontMatterAndTitle() {
        let rendered = Self.render(includeFrontMatter: false, includeTitle: false)
        #expect(rendered.hasPrefix("A type that represents a view.\n"))
        #expect(!rendered.contains("---"))
        #expect(!rendered.contains("# View"))
    }

    @Test func plainTextMatchesJs() {
        let got = renderPlain(
            title: "View", abstractText: "Abstract here", declarationText: "protocol View",
            headings: "h1\nh2",
            sections: [("Over", "Body\n\n\n\ntext", 1), ("", "   ", 0)])
        #expect(got == "View\n\nAbstract here\n\nprotocol View\n\nh1\nh2\n\nOver\nBody\n\ntext")
    }
}

struct PageMarkdownTests {
    @Test func pageMatchesJs() throws {
        let pageJson = #"""
            {"metadata":{"title":"View","roleHeading":"Protocol","role":"symbol","modules":[{"name":"SwiftUI"}],"platforms":[{"name":"iOS","introducedAt":"13.0"},{"name":"macOS"},{"introducedAt":"1.0"}]},"abstract":[{"type":"text","text":"A view "},{"type":"codeVoice","code":"V"}],"references":{"doc://x/documentation/swiftui/text":{"title":"Text","url":"/documentation/swiftui/text"}},"primaryContentSections":[{"kind":"declarations","declarations":[{"tokens":[{"text":"protocol View"}],"languages":["swift"]}]},{"kind":"content","content":[{"type":"heading","level":2,"text":"Overview"},{"type":"paragraph","inlineContent":[{"type":"text","text":"See "},{"type":"reference","identifier":"doc://x/documentation/swiftui/text"},{"type":"text","text":" and "},{"type":"reference","identifier":"doc://x/documentation/swiftui/missing","isActive":false}]},{"type":"codeListing","syntax":"swift","code":["let a = 1","print(a)"]},{"type":"aside","style":"Important","content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"Note this."}]}]},{"type":"unorderedList","items":[{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"Item one"}]}]},{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"Item two"}]}]}]},{"type":"table","rows":[{"cells":[{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"H1"}]}]},{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"H2"}]}]}]},{"cells":[{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"a\nb"}]}]},{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"c"}]}]}]}]}]}],"topicSections":[{"title":"Creating","identifiers":["doc://x/documentation/swiftui/text","doc://x/not-a-doc"]}]}
            """#
        let want = """
            ---
            title: View
            framework: SwiftUI
            role: symbol
            role_heading: Protocol
            platforms: [iOS 13.0+, macOS, undefined 1.0+]
            path: swiftui/view
            ---

            # View

            A view `V`

            ## Declaration

            ```swift
            protocol View
            ```

            ## Overview

            See [Text](text.md) and `doc://x/documentation/swiftui/missing`

            ```swift
            let a = 1
            print(a)
            ```

            > **Important:** Note this.

            - Item one
            - Item two

            | H1 | H2 |
            | --- | --- |
            | a b | c |

            ## Topics

            ### Creating

            - [Text](text.md)
            - doc://x/not-a-doc

            """
        // Bind the rendered string and the expected fixture to typed `let`s, then compare with the
        // typed `expectEqual`, so the solver never faces the whole `render == bigLiteral` expression as
        // one constraint system (the type-check-timing flake this suite triggered).
        let rendered: String = try renderPageString(pageJson, path: "swiftui/view")
        expectEqual(rendered, want)
    }

    @Test func relativePathMatchesJs() {
        #expect(PageMarkdown.relativePath(from: "swiftui/view", to: "swiftui/text") == "text")
        #expect(PageMarkdown.relativePath(from: "swiftui/view", to: "swiftui/view") == "view")
        #expect(PageMarkdown.relativePath(from: "swiftui/view/body", to: "uikit/uiview") == "../../uikit/uiview")
        #expect(PageMarkdown.relativePath(from: "a", to: "b/c/d") == "b/c/d")
        #expect(PageMarkdown.relativePath(from: "", to: "x/y") == "x/y")
    }
}

struct IdentifierTests {
    @Test func normalizeMatchesJs() {
        #expect(Identifier.normalize("doc://com.apple.SwiftUI/documentation/SwiftUI/View") == "swiftui/view")
        #expect(
            Identifier.normalize("doc://com.apple.design/design/human-interface-guidelines/color")
                == "design/human-interface-guidelines/color")
        #expect(Identifier.normalize("/documentation/SwiftUI/View") == "swiftui/view")
        #expect(Identifier.normalize("documentation/UIKit/UIView/") == "uikit/uiview")
        #expect(Identifier.normalize("/design/foo") == "design/foo")
        #expect(Identifier.normalize("/app-store-review/3.1.1") == "app-store-review/3.1.1")
        #expect(Identifier.normalize("page#section") == "page")
        #expect(Identifier.normalize("https://example.com/x") == nil)
        #expect(Identifier.normalize("swift/int/.../init") == nil)
        #expect(Identifier.normalize("a//b") == nil)
        #expect(Identifier.normalize("") == nil)
        #expect(Identifier.normalize("#frag") == nil)
        #expect(Identifier.normalize("ΣWIFT/View") == "σwift/view")
    }

    @Test func humanizeAndHelpers() {
        #expect(JsString.humanize("custom_kind") == "Custom Kind")
        #expect(JsString.humanize("already Big") == "Already Big")
        #expect(JsString.humanize("x9 9x _a") == "X9 9x  A")
        #expect(JsString.trim("\u{FEFF} x \u{00A0}") == "x")
        #expect(JsString.normalizeParagraphs("a\nb\n\n\nc") == "a b\n\nc")
        #expect(JsString.collapseWhitespaceRuns("a \t\n b") == "a b")
    }
}
