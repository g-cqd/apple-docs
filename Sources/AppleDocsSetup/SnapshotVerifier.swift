import AemiDigest
import Foundation

/// Cryptographic SHA-256 integrity verifier for downloaded corpus snapshots and models
/// (Threat Model T-03: supply-chain tamper detection before archive inspection or extraction).
///
/// Backed by `AemiDigest.ContentDigest.SHA256` (CryptoKit on macOS, `apple/swift-crypto`
/// BoringSSL on Linux) with streaming chunked reads so multi-GB archives use constant memory.
public enum SnapshotVerifier: Sendable {
    private static let streamChunkBytes = 262_144

    /// Computes the lowercase 64-character hex SHA-256 digest of `bytes`.
    public static func sha256Hex(of bytes: [UInt8]) -> String {
        ContentDigest.sha256Hex(bytes)
    }

    /// Streams the file at `path` in 256 KiB chunks and returns its lowercase hex SHA-256 digest.
    public static func sha256Hex(fileAtPath path: String) throws(SetupError) -> String {
        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
        } catch {
            throw .ioFailure("Cannot open \(path): \(error)")
        }
        defer { try? handle.close() }

        var hasher = ContentDigest.SHA256()
        while true {
            let chunk: Data?
            do {
                chunk = try handle.read(upToCount: streamChunkBytes)
            } catch {
                throw .ioFailure("Failed reading \(path): \(error)")
            }
            guard let chunk, !chunk.isEmpty else { break }
            hasher.update(Array(chunk))
        }
        let digest = hasher.finalize()
        return hexLowercase(digest)
    }

    /// Parses a `.sha256` sidecar string (`"<64-hex>  filename"` or bare `"<64-hex>"`).
    public static func parseExpectedHex(from raw: String) throws(SetupError) -> String {
        let token = raw.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
        let lower = token.lowercased()
        guard lower.utf8.count == 64,
            lower.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) })
        else {
            throw .invalidChecksumFormat(token)
        }
        return lower
    }

    /// Verifies that the file at `path` matches `expectedHex` (accepting raw `.sha256` sidecar text).
    public static func verifyFile(atPath path: String, against expectedChecksumText: String) throws(SetupError) {
        let expected = try parseExpectedHex(from: expectedChecksumText)
        let actual = try sha256Hex(fileAtPath: path)
        guard constantTimeEqual(expected, actual) else {
            throw .checksumMismatch(expected: expected, actual: actual)
        }
    }

    private static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8)
        let b = Array(rhs.utf8)
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for idx in 0 ..< a.count {
            diff |= a[idx] ^ b[idx]
        }
        return diff == 0
    }

    private static func hexLowercase(_ bytes: [UInt8]) -> String {
        let alphabet: [UInt8] = Array("0123456789abcdef".utf8)
        var out: [UInt8] = []
        out.reserveCapacity(bytes.count * 2)
        for byte in bytes {
            out.append(alphabet[Int(byte >> 4)])
            out.append(alphabet[Int(byte & 0x0F)])
        }
        return String(decoding: out, as: UTF8.self)
    }
}
