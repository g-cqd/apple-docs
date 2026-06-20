import ADSearchCascade
import Testing

@testable import ad_server

@Suite struct LimitClampTests {
    @Test func searchLimitBounds() {
        #expect(clampSearchLimit(50) == 50)
        #expect(clampSearchLimit(99999) == 200)
        #expect(clampSearchLimit(99999, upperBound: 100) == 100)
        #expect(clampSearchLimit(0) == 1)
        #expect(clampSearchLimit(-5) == 1)
    }

    @Test func symbolLimitMatchesJs() {
        #expect(clampSymbolLimit("50") == 50)
        #expect(clampSymbolLimit("99999") == 500)
        #expect(clampSymbolLimit(nil) == 100)
        #expect(clampSymbolLimit("0") == 100)
        #expect(clampSymbolLimit("-3") == 1)
    }

    @Test func cascadeParamsClampLimitAndOffset() {
        // Valid queries parse to `.some` (the optional return is for malformed input — see
        // `QueryDecodeTests`); the clamp behavior is unchanged.
        #expect(parseCascadeParams("/search?q=hi&limit=99999")?.limit == 200)
        #expect(parseCascadeParams("/search?q=hi")?.limit == 100)
        #expect(parseCascadeParams("/search?q=hi&limit=0")?.limit == 1)
        #expect(parseCascadeParams("/search?q=hi&offset=-9")?.offset == 0)
    }
}

@Suite struct QueryDecodeTests {
    @Test func decodesValidFormComponents() {
        // Preserved behavior: %XX triples decode, "+" → space, unreserved bytes pass through,
        // valid multi-byte UTF-8 round-trips.
        #expect(percentDecode("hello%20world") == "hello world")
        #expect(percentDecode("a+b") == "a b")
        #expect(percentDecode("UIView") == "UIView")
        #expect(percentDecode("%E2%9C%93") == "\u{2713}")  // ✓ (3-byte UTF-8)
    }

    @Test func rejectsMalformedEscapes() {
        // Truncated / non-hex escapes now reject (nil) instead of being copied literally.
        #expect(percentDecode("%2") == nil)
        #expect(percentDecode("%") == nil)
        #expect(percentDecode("%G0") == nil)
    }

    @Test func rejectsInvalidUTF8() {
        // The security fix: a well-formed escape that decodes to invalid UTF-8 is rejected, not
        // silently turned into U+FFFD by `String(decoding:as:)`.
        #expect(percentDecode("%FF") == nil)
        #expect(percentDecode("%C3%28") == nil)  // 0xC3 lead + non-continuation byte
    }

    @Test func parseQueryRejectsMalformedComponentButKeepsValid() {
        #expect(parseQuery("/search?q=%FF") == nil)
        #expect(parseQuery("/search?q=%E2%28") == nil)
        #expect(parseCascadeParams("/search?q=%FF") == nil)
        // A valid query still parses, with the decoded value intact.
        let q = parseQuery("/search?q=hello%20world&limit=5")
        #expect(q?["q"] == "hello world")
        #expect(q?["limit"] == "5")
    }
}

@Suite struct OriginPolicyTests {
    @Test func absentOriginAllowed() {
        #expect(originAllowed(nil))
    }

    @Test func exactLoopbackHostsAllowed() {
        #expect(originAllowed("http://localhost"))
        #expect(originAllowed("http://localhost:3000"))
        #expect(originAllowed("https://127.0.0.1"))
        #expect(originAllowed("http://[::1]:8080"))
    }

    @Test func lookalikeAndForeignHostsRejected() {
        #expect(!originAllowed("http://localhost.evil.com"))
        #expect(!originAllowed("http://127.0.0.1.evil.com"))
        #expect(!originAllowed("https://example.com"))
        #expect(!originAllowed("ftp://localhost"))
        #expect(!originAllowed("not a url"))
    }

    @Test func hostExtraction() {
        #expect(loopbackOriginHost("http://localhost:3000") == "localhost")
        #expect(loopbackOriginHost("http://[::1]:80") == "[::1]")
        #expect(loopbackOriginHost("http://user@localhost") == "localhost")
        #expect(loopbackOriginHost("ws://localhost") == nil)
    }
}
