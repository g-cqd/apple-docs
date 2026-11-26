import AppleDocsCore
import Testing

@Suite("PlatformVersion")
struct PlatformVersionTests {
    @Test func `parses standard versions and orders numerically rather than lexicographically`() throws {
        let v9 = try #require(PlatformVersion(parsing: "9.0"))
        let v10 = try #require(PlatformVersion(parsing: "10.0"))
        let v174 = try #require(PlatformVersion(parsing: "17.4"))
        let v10151 = try #require(PlatformVersion(parsing: "10.15.1"))
        let beta = try #require(PlatformVersion(parsing: "26.0 beta"))
        let plus = try #require(PlatformVersion(parsing: "18.2+"))

        #expect(v9 < v10)
        #expect(v9.encoded == 9_000_000)
        #expect(v10.encoded == 10_000_000)
        #expect(v174.encoded == 17_004_000)
        #expect(v10151.encoded == 10_015_001)
        #expect(beta.encoded == 26_000_000)
        #expect(plus.encoded == 18_002_000)
        #expect(PlatformVersion(encoded: v10151.encoded) == v10151)
    }

    @Test(arguments: ["", "   ", "abc", ".1.2", "1.2.", "1..2", "1000.0", "1.1000", "1.2.3.4.5"])
    func `returns nil for malformed or out-of-range version strings`(raw: String) {
        #expect(PlatformVersion(parsing: raw) == nil)
    }
}
