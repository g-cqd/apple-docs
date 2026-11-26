import AppleDocsCore
import Testing

@Suite("Scalar-level replacement (escaping that ignores grapheme clustering)")
struct ScalarReplacementTests {
    @Test func `replaces a scalar even when a combining mark follows it`() {
        let fused = "a\"\u{07FD}b\"c"  // `"` + U+07FD is one grapheme cluster
        #expect(fused.replacing("\"", with: "\"\"") != "a\"\"\u{07FD}b\"\"c")  // the stdlib matches graphemes
        #expect(fused.replacingScalars("\"", with: "\"\"") == "a\"\"\u{07FD}b\"\"c")
        #expect("%\u{0301}_".replacingScalars(["%": "\\%", "_": "\\_"]) == "\\%\u{0301}\\_")
        #expect("plain".replacingScalars("\"", with: "x") == "plain")
        #expect("x\u{0301}".containsScalar("\u{0301}"))
    }
}
