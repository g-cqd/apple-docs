import Testing

@testable import ADOps

// SHA-256 known-answer vectors (FIPS 180-4) — the digest must equal what the JS
// `Bun.CryptoHasher('sha256').digest('hex')` produced for snapshot verification.

@Test func sha256EmptyString() {
    #expect(
        SHA256Hex.hex([])
            == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
}

@Test func sha256Abc() {
    #expect(
        SHA256Hex.hex(Array("abc".utf8))
            == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
}

@Test func sha256QuickBrownFox() {
    #expect(
        SHA256Hex.hex(Array("The quick brown fox jumps over the lazy dog".utf8))
            == "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592")
}

@Test func sha256TwoBlockMessage() {
    // 56 bytes forces a second padded block (message + 0x80 + length spills over).
    let message = String(repeating: "a", count: 56)
    #expect(
        SHA256Hex.hex(Array(message.utf8))
            == "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a")
}
