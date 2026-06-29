import Testing

@testable import ADBase

// MARK: - SHA-1 (byte-parity with Bun.CryptoHasher('sha1'))

@Test func sha1KnownVectors() {
    #expect(Sha1.hexString("") == "da39a3ee5e6b4b0d3255bfef95601890afd80709")
    #expect(Sha1.hexString("abc") == "a9993e364706816aba3e25717850c26c9cd0d89d")
    #expect(
        Sha1.hexString("The quick brown fox jumps over the lazy dog")
            == "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12")
    // 56-byte input — exercises the second padding block (length 56 mod 64).
    #expect(
        Sha1.hexString("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
            == "84983e441c3bd26ebaae4aa1f95129e5e54670f1")
}

@Test func sha1ProducesFortyLowercaseHexChars() {
    let h = Sha1.hexString("é")  // multi-byte (UTF-8: C3 A9)
    #expect(h.count == 40)
    #expect(h.allSatisfy { ($0 >= "0" && $0 <= "9") || ($0 >= "a" && $0 <= "f") })
    #expect(Sha1.hexString("a") != Sha1.hexString("b"))
}

// MARK: - safeWebDocKey / safeWebSegment

@Test func shortKeysPassThroughUnchanged() {
    let key = "swiftui/view/body-8kl5o"
    #expect(SafePath.webKeyNeedsMapping(key) == false)
    #expect(SafePath.safeWebDocKey(key) == key)
    #expect(SafePath.safeWebSegment("view") == "view")
}

@Test func oversizedSegmentIsTruncatedAndHashed() {
    let longSeg = String(repeating: "a", count: 250)
    let key = "swiftui/\(longSeg)"
    #expect(SafePath.webKeyNeedsMapping(key) == true)

    let mapped = SafePath.safeWebDocKey(key)
    let segments = mapped.split(separator: "/", omittingEmptySubsequences: false)
    #expect(segments.count == 2)
    #expect(segments[0] == "swiftui")

    let safeSeg = String(segments[1])
    // 180 preserved + "~" + 12 hex = 193 bytes, comfortably ≤ 200.
    #expect(safeSeg.utf8.count <= SafePath.webSegmentMaxBytes)
    #expect(safeSeg.contains("~"))
    let parts = safeSeg.split(separator: "~")
    #expect(parts.count == 2)
    #expect(parts[1].count == 12)  // SHA-1 prefix
    #expect(parts[1].allSatisfy { ($0 >= "0" && $0 <= "9") || ($0 >= "a" && $0 <= "f") })
    // The hash is of the FULL original segment.
    #expect(String(parts[1]) == String(Sha1.hexString(longSeg).prefix(12)))
}

@Test func mappingIsIdempotent() {
    let key = "swiftui/\(String(repeating: "b", count: 300))/leaf"
    let once = SafePath.safeWebDocKey(key)
    let twice = SafePath.safeWebDocKey(once)
    #expect(once == twice)
    #expect(SafePath.webKeyNeedsMapping(once) == false)
}

@Test func emptySegmentsArePreservedByDocKeyMapping() {
    // safeWebDocKey does not validate — it mirrors JS `split('/').map().join('/')`.
    #expect(SafePath.safeWebDocKey("a//b") == "a//b")
}

// MARK: - validateStorageKey

@Test func validateStorageKeyAcceptsRelativeKeys() throws {
    #expect(try SafePath.validateStorageKey("swiftui/view") == "swiftui/view")
    #expect(try SafePath.validateStorageKey("apple-archive/Foo/Bar.html") == "apple-archive/Foo/Bar.html")
}

@Test func validateStorageKeyRejectsBadKeys() {
    #expect(throws: SafePathError.emptyKey) { try SafePath.validateStorageKey("") }
    #expect(throws: SafePathError.absoluteKey("/etc/passwd")) {
        try SafePath.validateStorageKey("/etc/passwd")
    }
    #expect(throws: SafePathError.absoluteKey("~/secret")) {
        try SafePath.validateStorageKey("~/secret")
    }
    #expect(throws: SafePathError.windowsRoot("C:\\Windows")) {
        try SafePath.validateStorageKey("C:\\Windows")
    }
    #expect(throws: SafePathError.invalidSegment("..", key: "a/../b")) {
        try SafePath.validateStorageKey("a/../b")
    }
    #expect(throws: SafePathError.invalidSegment("", key: "a//b")) {
        try SafePath.validateStorageKey("a//b")
    }
    #expect(throws: SafePathError.forbiddenCharacter("a\\b")) {
        try SafePath.validateStorageKey("a\\b")
    }
}
