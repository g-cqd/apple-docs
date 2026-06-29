import ADJSONCore
import Testing

@testable import ADContent

/// `depth` open brackets then `depth` close brackets, as UTF-8 bytes. File-scope
/// so the depth-safety test body stays cheap to type-check (the
/// -warn-long-function-bodies budget is wall-clock and load-sensitive).
private func nestedBrackets(depth: Int) -> [UInt8] {
    let opens = String(repeating: "[", count: depth)
    let closes = String(repeating: "]", count: depth)
    return Array((opens + closes).utf8)
}

// Depth-safety for the recursive DocC content/inline renderer. The render walk
// (`renderContentNode` → lists / tables / inline) is recursive, but it only ever traverses a
// tree the parser accepted, and `renderRawJSON` parses with `maxDepth: 512`. Request input
// nested past that is rejected at parse rather than driving the render recursion to overflow —
// these tests pin that contract.
@Suite("Render depth safety")
struct RenderDepthSafetyTests {
    @Test func deeplyNestedRawJSONRejectedNotOverflow() {
        // ~10× the 512 parse cap: parse must reject it, so the recursive renderer never runs.
        let bytes: [UInt8] = nestedBrackets(depth: 5000)
        var writer = ByteWriter()
        let rendered: Bool = bytes.withUnsafeBytes { raw in
            PageMarkdown.renderRawJSON(raw, canonicalPath: "/documentation/x", into: &writer)
        }
        #expect(rendered == false)  // parse depth-capped: recursion never ran, no overflow
    }

    @Test func shallowDocumentRendersWithoutCrash() {
        let bytes = Array(#"{"metadata":{"title":"Hi"}}"#.utf8)
        var writer = ByteWriter()
        let rendered = bytes.withUnsafeBytes { raw in
            PageMarkdown.renderRawJSON(raw, canonicalPath: "/documentation/x", into: &writer)
        }
        #expect(rendered)  // parsed under the cap, rendered without crashing
    }
}
