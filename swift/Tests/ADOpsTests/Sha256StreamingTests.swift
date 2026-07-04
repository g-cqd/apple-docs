import Testing

@testable import ADOps

// SHA256Streaming (the chunked hasher behind the multi-GB snapshot-download file
// verification) must produce the IDENTICAL digest as the one-shot SHA256Hex.hex
// over the concatenated chunks — regardless of how the input is split across
// `update` calls. A drift here is a silent checksum-verification hole, so the
// parity is exercised across every 64-byte block boundary and known vectors.
@Suite("SHA256Streaming parity with the one-shot hash")
struct Sha256StreamingTests {
    /// Feed `bytes` to a fresh streamer in fixed-size chunks, then finalize.
    private func streamed(_ bytes: [UInt8], chunk: Int) -> String {
        var hasher = SHA256Streaming()
        var index = 0
        while index < bytes.count {
            let end = min(index + chunk, bytes.count)
            hasher.update(Array(bytes[index ..< end]))
            index = end
        }
        return hasher.finalize()
    }

    @Test("matches the FIPS 180-2 \"abc\" vector")
    func abcVector() {
        var hasher = SHA256Streaming()
        hasher.update(Array("abc".utf8))
        #expect(hasher.finalize() == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @Test("empty input hashes to the SHA-256 of the empty string")
    func emptyInput() {
        var hasher = SHA256Streaming()
        #expect(hasher.finalize() == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    @Test("streamed digest equals the one-shot digest across sizes and chunk splits")
    func parityAcrossChunks() {
        // Sizes straddling the 64-byte block + the 56-byte padding boundary.
        let sizes = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4096, 100_000]
        for size in sizes {
            // Deterministic pseudo-data (no RNG): a repeating byte ramp.
            let bytes = (0 ..< size).map { UInt8($0 & 0xFF) }
            let oneShot = SHA256Hex.hex(bytes)
            for chunk in [1, 7, 32, 64, 65, 1024, max(1, size)] {
                #expect(streamed(bytes, chunk: chunk) == oneShot, "size=\(size) chunk=\(chunk)")
            }
        }
    }
}
