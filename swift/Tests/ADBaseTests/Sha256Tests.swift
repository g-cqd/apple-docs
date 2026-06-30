import Testing

@testable import ADBase

// SHA-256 byte-parity with the JS build's `sha256()` (Bun CryptoHasher) — the
// content-hashed tree-data filename must match live vs. static. Standard
// FIPS 180-4 vectors.

@Test func sha256KnownVectors() {
    #expect(Sha256.hexString("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    #expect(Sha256.hexString("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    #expect(
        Sha256.hexString("The quick brown fox jumps over the lazy dog")
            == "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592")
    // 56-byte input — exercises the second padding block (length 56 mod 64).
    #expect(
        Sha256.hexString("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
            == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
    // The combine tree.json the framework-page sidecar hashes (matches src/lib/hash.js).
    #expect(
        Sha256.hexString(
            #"{"edges":[{"from_key":"combine","to_key":"combine/publisher"}],"docs":{"combine/publisher":{"title":"Publisher","role_heading":"Protocol","href":"https://x.test/docs/combine/publisher/"},"combine/just":{"title":"Just","role_heading":"Structure","href":"https://x.test/docs/combine/just/"},"combine/using-combine":{"title":"Using Combine","role_heading":"Article","href":"https://x.test/docs/combine/using-combine/"}}}"#
        ) == "3e57e4c6ac1c97452cabe8a8a4d1dbad4c96cd3750157fd8685d9ac4d53ea10e")
}
