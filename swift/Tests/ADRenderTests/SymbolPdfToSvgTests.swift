// The first test coverage for the SF-Symbol PDF→SVG converter — a regression
// gate for the CGPDFContext missing-`endobj` shape (RFC 0007 §11 finding on the
// prerender path): macOS 27's CGPDFContext omits the content-stream object's
// `endobj` terminator, so an object walk that resumes AFTER the next `endobj`
// (the pre-fix behavior) steals the following object's terminator and silently
// skips it — here the `/Type /Page` object, killing every SVG conversion on
// this host. The JS oracle (`pdf-objects.js` `matchAll`) resumes at each
// header's end and is immune; the fixture pins the Swift walk to the same
// semantics.
//
// `Fixtures/cgpdf-missing-endobj.pdf` is a minimal, non-proprietary CGPDFContext
// PDF captured on the affected host (one filled bezier path — the same
// moveto/curveto/lineto/fill operator set a symbol PDF uses): 8 object headers,
// 7 `endobj` terminators, with the content stream (`4 0 obj`, /FlateDecode,
// indirect /Length) missing its own and the `/Type /Page` object (`1 0 obj`)
// sitting between it and the stolen terminator.

import Foundation
import Testing

@testable import ADRender

@Suite("SymbolPdfToSvg — CGPDFContext object scanning")
struct SymbolPdfToSvgTests {
    private func fixtureBytes() throws -> [UInt8] {
        let url = try #require(
            Bundle.module.url(
                forResource: "cgpdf-missing-endobj", withExtension: "pdf",
                subdirectory: "Fixtures"))
        return [UInt8](try Data(contentsOf: url))
    }

    @Test("a missing content-stream endobj does not swallow the following object")
    func collectObjectsSurvivesMissingEndobj() throws {
        let objects = PdfObjects.collectObjects(try fixtureBytes())
        // The page object (`1 0`) sits directly after the unterminated content
        // stream — the pre-fix walk skipped it entirely (findPage → nil).
        let page = try #require(PdfObjects.findPage(objects))
        #expect(page.id == "1 0")
        // The content stream still resolves through its indirect /Length.
        let contents = try #require(PdfObjects.resolveStreamObject(page.dict["Contents"], objects))
        let decoded = try PdfObjects.decodeStream(contents)
        #expect(!decoded.isEmpty)
    }

    @Test("the full PDF→SVG conversion produces real path geometry")
    func convertProducesRealSvg() throws {
        let svg = try SymbolPdfToSvg.convert(
            try fixtureBytes(),
            options: .init(name: "fixture", pointSize: 64, color: "#000000", background: nil))
        #expect(svg.contains("<svg"))
        #expect(svg.contains("<path"))
    }
}
