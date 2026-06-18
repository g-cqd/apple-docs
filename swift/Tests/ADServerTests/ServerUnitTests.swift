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
        #expect(parseCascadeParams("/search?q=hi&limit=99999").limit == 200)
        #expect(parseCascadeParams("/search?q=hi").limit == 100)
        #expect(parseCascadeParams("/search?q=hi&limit=0").limit == 1)
        #expect(parseCascadeParams("/search?q=hi&offset=-9").offset == 0)
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
