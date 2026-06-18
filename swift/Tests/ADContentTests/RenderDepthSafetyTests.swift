import Testing

import ADJSONCore
@testable import ADContent

// Depth-safety for the recursive DocC content/inline renderer. The render walk
// (`renderContentNode` → lists / tables / inline) is recursive, but it only ever traverses a
// tree the parser accepted, and `renderRawJSON` parses with `maxDepth: 512`. Request input
// nested past that is rejected at parse rather than driving the render recursion to overflow —
// these tests pin that contract.
@Suite("Render depth safety")
struct RenderDepthSafetyTests {
  @Test func deeplyNestedRawJSONRejectedNotOverflow() {
    // ~10× the 512 parse cap: parse must reject it, so the recursive renderer never runs.
    let depth = 5000
    let bytes = Array(
      (String(repeating: "[", count: depth) + String(repeating: "]", count: depth)).utf8)
    var writer = ByteWriter()
    let rendered = bytes.withUnsafeBytes { raw in
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
