import Foundation
import Testing

@testable import ADArchive

// S4 gzip seam + S10 native unzip. The gzip side asserts framing + roundtrip
// (byte-parity with bun's zlib-ng deflate is documented impossible — see
// Gzip.swift); the unzip side extracts python-zipfile fixtures (a deflated
// nested member + a stored one, plus a forced-ZIP64 local header).

// MARK: - fixtures (file scope for the type-check budget)

/// zipfile: AssetData/documentation-db/index.sql (deflated, 20 repeats of the
/// CREATE TABLE line) + AssetData/meta.txt (stored, "stored-bytes").
private let plainZipB64 =
    "UEsDBBQAAAAIAAAAIQDtNqewQQAAACQEAAAkAAAAQXNzZXREYXRhL2RvY3VtZW50YXRpb24tZGIvaW5kZXguc3Fscw5ydQxxVQhxdPJxVUjJTy7WyExR8PQLcXV3DVIICPL0dQyKVPB2jdRRyE6tVAhxjQjRtOZyHtU0qmlU00jRBABQSwMEFAAAAAAAAAAhAKZkOLMMAAAADAAAABIAAABBc3NldERhdGEvbWV0YS50eHRzdG9yZWQtYnl0ZXNQSwECFAMUAAAACAAAACEA7TansEEAAAAkBAAAJAAAAAAAAAAAAAAAgAEAAAAAQXNzZXREYXRhL2RvY3VtZW50YXRpb24tZGIvaW5kZXguc3FsUEsBAhQDFAAAAAAAAAAhAKZkOLMMAAAADAAAABIAAAAAAAAAAAAAAIABgwAAAEFzc2V0RGF0YS9tZXRhLnR4dFBLBQYAAAAAAgACAJIAAAC/AAAAAAA="

private let indexSqlExpected = String(
    repeating: "CREATE TABLE docs(id INTEGER PRIMARY KEY, key TEXT);\n", count: 20)

/// zipfile with force_zip64: big/member.bin (stored, 50 × "Z") — the LOCAL
/// header carries 0xFFFFFFFF sentinels + the 0x0001 extra; the central
/// directory keeps real 32-bit sizes (python only writes CD sentinels past
/// 4 GiB, so the CD-side ZIP64 sentinel branch is covered by code review,
/// not this fixture).
private let zip64B64 =
    "UEsDBC0AAAAAAAAAIQA6zg1C//////////8OABQAYmlnL21lbWJlci5iaW4BABAAMgAAAAAAAAAyAAAAAAAAAFpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaUEsBAi0DLQAAAAAAAAAhADrODUIyAAAAMgAAAA4AAAAAAAAAAAAAAIABAAAAAGJpZy9tZW1iZXIuYmluUEsFBgAAAAABAAEAPAAAAHIAAAAAAA=="

private func writeFixture(_ b64: String) throws -> String {
    let data = try #require(Data(base64Encoded: b64))
    let path = NSTemporaryDirectory() + "unzip-fixture-\(UUID().uuidString).zip"
    try data.write(to: URL(fileURLWithPath: path))
    return path
}

// MARK: - gzip

@Test func gzipRoundtripAndFraming() throws {
    let payload = Array("sitemap payload — compress me\n".utf8)
    let compressed = try #require(Gzip.compress(payload))
    // gzip magic + deflate method.
    #expect(compressed.count >= 18)
    #expect(compressed[0] == 0x1F && compressed[1] == 0x8B && compressed[2] == 0x08)
    #expect(Gzip.decompress(compressed) == payload)
}

@Test func gzipDecompressRejectsGarbage() {
    #expect(Gzip.decompress([0x1F, 0x8B, 0x08, 0x00, 0x01, 0x02]) == nil)
    #expect(Gzip.decompress([]) == nil)
}

@Test func inflateStreamChunked() throws {
    // Stream a compressed body through 7-byte input chunks.
    let payload = Array(String(repeating: "chunked inflate across boundaries. ", count: 100).utf8)
    let compressed = try #require(Gzip.compress(payload))
    let stream = try #require(InflateStream(windowBits: 15 + 32))
    defer { stream.end() }
    var out: [UInt8] = []
    var finished = false
    var i = 0
    while i < compressed.count && !finished {
        let chunk = Array(compressed[i ..< min(i + 7, compressed.count)])
        i += chunk.count
        switch stream.inflate(chunk, emit: { out.append(contentsOf: $0) }) {
            case .needsMore: continue
            case .finished: finished = true
            case .failed:
                Issue.record("inflate failed mid-stream")
                return
        }
    }
    #expect(finished)
    #expect(out == payload)
}

// MARK: - unzip

@Test func unzipListsAndExtractsPlainFixture() throws {
    let path = try writeFixture(plainZipB64)
    defer { try? FileManager.default.removeItem(atPath: path) }

    let entries = try Unzip.entries(path: path)
    #expect(entries.map(\.name) == ["AssetData/documentation-db/index.sql", "AssetData/meta.txt"])
    #expect(entries[0].method == 8)  // deflated
    #expect(entries[1].method == 0)  // stored

    var sql: [UInt8] = []
    try Unzip.extract(entries[0], from: path) { sql.append(contentsOf: $0) }
    #expect(String(decoding: sql, as: UTF8.self) == indexSqlExpected)

    var meta: [UInt8] = []
    try Unzip.extract(entries[1], from: path) { meta.append(contentsOf: $0) }
    #expect(String(decoding: meta, as: UTF8.self) == "stored-bytes")
}

@Test func unzipHandlesForcedZip64LocalHeader() throws {
    let path = try writeFixture(zip64B64)
    defer { try? FileManager.default.removeItem(atPath: path) }

    let entries = try Unzip.entries(path: path)
    #expect(entries.count == 1)
    #expect(entries[0].name == "big/member.bin")
    #expect(entries[0].uncompressedSize == 50)

    var out: [UInt8] = []
    try Unzip.extract(entries[0], from: path) { out.append(contentsOf: $0) }
    #expect(out.count == 50)
    #expect(out.allSatisfy { $0 == UInt8(ascii: "Z") })
}

@Test func unzipRejectsNonZip() throws {
    let path = NSTemporaryDirectory() + "not-a-zip-\(UUID().uuidString)"
    try Data("plain text, no directory".utf8).write(to: URL(fileURLWithPath: path))
    defer { try? FileManager.default.removeItem(atPath: path) }
    #expect(throws: Unzip.UnzipError.self) { try Unzip.entries(path: path) }
}
