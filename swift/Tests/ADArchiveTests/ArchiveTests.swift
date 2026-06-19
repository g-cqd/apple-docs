// Structure-level tests: tar bytes are validated by parsing them back
// (raw sink, no compression), zstd output by magic + rebuild-twice
// determinism. Cross-implementation extraction equality lives in the JS
// parity suite. Foundation here is test-only — the shipped targets stay
// Foundation-free.

import ADTestKit
import Foundation
import Testing

@testable import ADArchive

private struct CollectSink: ByteSink {
    var bytes: [UInt8] = []
    mutating func write(_ chunk: UnsafeRawBufferPointer) throws {
        bytes.append(contentsOf: chunk)
    }
    mutating func finish() throws {}
}

private func makeTree(_ files: [(String, [UInt8], Bool)]) throws -> URL {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("ad-archive-test-\(UUID().uuidString)")
    for (path, bytes, executable) in files {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(bytes).write(to: url)
        if executable {
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        }
    }
    return root
}

private func meta(root: URL, _ relative: String) -> FileMeta {
    let absolute = root.appendingPathComponent(relative).path
    var st = stat()
    lstat(absolute, &st)
    #if canImport(Darwin)
        let mtime = Int64(st.st_mtimespec.tv_sec)
    #else
        let mtime = Int64(st.st_mtim.tv_sec)
    #endif
    return FileMeta(
        relativePath: relative, absolutePath: absolute, size: Int64(st.st_size),
        mtime: mtime, executable: (st.st_mode & 0o100) != 0,
    )
}

private func field(_ block: ArraySlice<UInt8>, _ offset: Int, _ length: Int) -> [UInt8] {
    let base = block.startIndex
    return [UInt8](block[(base + offset) ..< (base + offset + length)])
}

private func cString(_ bytes: [UInt8]) -> String {
    String(decoding: bytes.prefix(while: { $0 != 0 }), as: UTF8.self)
}

@Test func headerGoldenFields() throws {
    var block = [UInt8](repeating: 0, count: 512)
    try Tar.writeHeader(into: &block, path: "docs/readme.md", size: 5, mtime: 1_700_000_000, executable: false)
    // Typed asserts keep each `field`/`cString` slice operand off the `#expect` macro's re-type-check
    // path, so the fanned-out golden-field checks stay under the 100ms whole-body budget.
    expectEqual(cString(field(block[...], 0, 100)), "docs/readme.md")
    expectEqual(cString(field(block[...], 100, 8)), "0000644")
    expectEqual(cString(field(block[...], 108, 8)), "0000000")  // uid 0
    expectEqual(cString(field(block[...], 124, 12)), "00000000005")  // size 5
    expectEqual(field(block[...], 156, 1), [UInt8(ascii: "0")])  // typeflag
    expectEqual(field(block[...], 257, 6), Array("ustar".utf8) + [0])  // magic
    expectEqual(field(block[...], 263, 2), Array("00".utf8))  // version
    expectEqual(cString(field(block[...], 265, 32)), "root")
    // Checksum: recompute with the chksum field as spaces and compare.
    var copy = block
    for i in 148 ..< 156 { copy[i] = UInt8(ascii: " ") }
    let expected = copy.reduce(0) { $0 + Int($1) }
    let digits = cString(field(block[...], 148, 7))
    expectEqual(Int(digits, radix: 8), expected)
    expectEqual(block[154], 0)
    expectEqual(block[155], UInt8(ascii: " "))
}

@Test func executableModeAndPrefixSplit() throws {
    var block = [UInt8](repeating: 0, count: 512)
    let long = "alpha/" + String(repeating: "b", count: 80) + "/" + String(repeating: "c", count: 90) + ".bin"
    try Tar.writeHeader(into: &block, path: long, size: 0, mtime: 0, executable: true)
    #expect(cString(field(block[...], 100, 8)) == "0000755")
    let name = cString(field(block[...], 0, 100))
    let prefix = cString(field(block[...], 345, 155))
    #expect("\(prefix)/\(name)" == long)
}

@Test func unrepresentableNamesAndFieldsThrow() {
    var block = [UInt8](repeating: 0, count: 512)
    let component = String(repeating: "x", count: 120)  // single component > 100
    #expect(throws: TarFailure.self) {
        try Tar.writeHeader(into: &block, path: "dir/\(component)", size: 0, mtime: 0, executable: false)
    }
    #expect(throws: TarFailure.self) {
        try Tar.writeHeader(into: &block, path: "ok.txt", size: -1, mtime: 0, executable: false)
    }
    #expect(throws: TarFailure.self) {
        try Tar.writeHeader(into: &block, path: "ok.txt", size: 0, mtime: -1, executable: false)
    }
    #expect(throws: TarFailure.self) {
        try Tar.writeHeader(into: &block, path: "ok.txt", size: Tar.maxFileSize + 1, mtime: 0, executable: false)
    }
}

@Test func streamTarStructureRoundTrips() throws {
    let root = try makeTree([
        ("a.txt", Array("hello".utf8), false),
        ("nested/dir/b.bin", [UInt8](repeating: 7, count: 600), true),
        ("empty.dat", [], false)
    ])
    defer { try? FileManager.default.removeItem(at: root) }
    let metas = [meta(root: root, "a.txt"), meta(root: root, "empty.dat"), meta(root: root, "nested/dir/b.bin")]
    var sink = CollectSink()
    try ArchiveWriter.streamTar(metas: metas, into: &sink)
    let bytes = sink.bytes

    expectEqual(bytes.count % Tar.recordSize, 0)  // padded to the 10240 record

    // Member 1: a.txt, 5 bytes, data at 512.
    expectEqual(cString(field(bytes[0 ..< 512], 0, 100)), "a.txt")
    expectEqual(Array(bytes[512 ..< 517]), Array("hello".utf8))
    expectTrue(bytes[517 ..< 1024].allSatisfy { $0 == 0 })  // body padding

    // Member 2: empty.dat — header only, no data blocks.
    expectEqual(cString(field(bytes[1024 ..< 1536], 0, 100)), "empty.dat")
    // Member 3 header follows immediately.
    expectEqual(cString(field(bytes[1536 ..< 2048], 0, 100)), "nested/dir/b.bin")
    let sizeOctal = cString(field(bytes[1536 ..< 2048], 124, 12))
    expectEqual(Int(sizeOctal, radix: 8), 600)
    // 600 bytes of data → 2 blocks; then EOF: two zero blocks.
    let eofStart = 2048 + 1024
    expectTrue(bytes[eofStart ..< (eofStart + 1024)].allSatisfy { $0 == 0 })
}

@Test(.enabled(if: Zstd.shared != nil))
func writeTarZstIsDeterministicAndFramed() throws {
    let root = try makeTree([
        ("one.txt", Array("determinism".utf8), false),
        ("two/three.txt", [UInt8](repeating: 42, count: 5000), false)
    ])
    defer { try? FileManager.default.removeItem(at: root) }
    let out1 = root.appendingPathComponent("out1.tar.zst").path
    let out2 = root.appendingPathComponent("out2.tar.zst").path
    let files = ["one.txt", "two/three.txt"]
    let r1 = ArchiveWriter.writeTarZst(
        .init(sourceDir: root.path, outputPath: out1, files: files, level: 9, workers: 3))
    let r2 = ArchiveWriter.writeTarZst(
        .init(sourceDir: root.path, outputPath: out2, files: files, level: 9, workers: 3))
    guard case .success(let done) = r1, case .success = r2 else {
        Issue.record("archive build failed: \(r1) / \(r2)")
        return
    }
    expectEqual(done.fileCount, 2)
    let bytes1 = try Data(contentsOf: URL(fileURLWithPath: out1))
    let bytes2 = try Data(contentsOf: URL(fileURLWithPath: out2))
    expectEqual([UInt8](bytes1.prefix(4)), [0x28, 0xB5, 0x2F, 0xFD])  // zstd magic
    expectEqual(bytes1, bytes2)  // rebuild-twice determinism
    expectEqual(Int64(bytes1.count), done.size)
}

// The exact path that fell back in production: the FILENAME alone is 103
// bytes, which no 155+100 split can represent.
private let productionLongPath =
    "resources/symbols/public/black-large/"
    + "figure.seated.side.left.windshield.front.and.heat.waves.air.distribution.upper.and.middle.and.lower.svg"

@Test func paxRecordLengthIsSelfReferentialAcrossTheDigitGap() {
    // fixed overhead = 7 (space + "path=" + newline) + digits of the length.
    let r90 = Tar.paxPathRecord([UInt8](repeating: UInt8(ascii: "a"), count: 90))
    #expect(r90.count == 99)
    #expect(String(decoding: r90.prefix(3), as: UTF8.self) == "99 ")
    // A 91-byte value admits 101 but NEVER 100 — the classic gap.
    let r91 = Tar.paxPathRecord([UInt8](repeating: UInt8(ascii: "a"), count: 91))
    #expect(r91.count == 101)
    #expect(String(decoding: r91.prefix(4), as: UTF8.self) == "101 ")
    #expect(r91.last == UInt8(ascii: "\n"))
    let r5 = Tar.paxPathRecord(Array("a/b.c".utf8))
    #expect(String(decoding: r5, as: UTF8.self) == "14 path=a/b.c\n")
}

@Test func encodeMemberMatchesWriteHeaderForUstarFitPaths() throws {
    let blocks = try Tar.encodeMember(path: "docs/readme.md", size: 5, mtime: 1_700_000_000, executable: false)
    #expect(blocks.count == 1)
    var classic = [UInt8](repeating: 0, count: 512)
    try Tar.writeHeader(into: &classic, path: "docs/readme.md", size: 5, mtime: 1_700_000_000, executable: false)
    #expect(blocks[0] == classic)
}

@Test func encodeMemberEmitsPaxExtendedHeaderForTheProductionPath() throws {
    // Typed asserts plus a split (the pax extended header + its data block here; the file header and
    // determinism in the next test) keep each body under the 100ms budget — the combined form hit 217ms.
    let blocks = try Tar.encodeMember(path: productionLongPath, size: 1234, mtime: 1_700_000_000, executable: false)
    expectEqual(blocks.count, 3)  // xhdr + one data block + file header

    let xhdr = blocks[0]
    expectEqual(xhdr.count, 512)
    expectEqual(xhdr[156], UInt8(ascii: "x"))
    let paxName = cString(field(xhdr[...], 0, 100))
    expectTrue(paxName.hasPrefix("PaxHeaders/figure.seated"))
    expectTrue(Array(paxName.utf8).count <= 100)
    let record = Tar.paxPathRecord(Array(productionLongPath.utf8))
    expectEqual(Int(cString(field(xhdr[...], 124, 12)), radix: 8), record.count)  // size pre-padding
    // Checksum is valid under the spaces-while-summing rule.
    var copy = xhdr
    for i in 148 ..< 156 { copy[i] = UInt8(ascii: " ") }
    expectEqual(Int(cString(field(xhdr[...], 148, 7)), radix: 8), copy.reduce(0) { $0 + Int($1) })

    let data = blocks[1]
    expectEqual(data.count, 512)
    expectEqual(Array(data.prefix(record.count)), record)
    expectTrue(data.dropFirst(record.count).allSatisfy { $0 == 0 })
    expectEqual(String(decoding: record, as: UTF8.self), "\(record.count) path=\(productionLongPath)\n")
}

@Test func encodeMemberPaxFileHeaderTruncatesNameAndIsDeterministic() throws {
    let blocks = try Tar.encodeMember(path: productionLongPath, size: 1234, mtime: 1_700_000_000, executable: false)
    let fileHeader = blocks[2]
    expectEqual(fileHeader[156], UInt8(ascii: "0"))
    expectEqual(Int(cString(field(fileHeader[...], 124, 12)), radix: 8), 1234)
    let truncated = cString(field(fileHeader[...], 0, 100))
    expectEqual(Array(truncated.utf8), Array(productionLongPath.utf8.prefix(100)))
    // Determinism: same input, same bytes.
    let again = try Tar.encodeMember(path: productionLongPath, size: 1234, mtime: 1_700_000_000, executable: false)
    expectEqual(again, blocks)
}

@Test func streamTarPlacesPaxBlocksAndKeepsByteAccounting() throws {
    let root = try makeTree([
        (productionLongPath, Array("svg-bytes".utf8), false),
        ("a.txt", Array("hi".utf8), false)
    ])
    defer { try? FileManager.default.removeItem(at: root) }
    let metas = [meta(root: root, "a.txt"), meta(root: root, productionLongPath)]
    var sink = CollectSink()
    try ArchiveWriter.streamTar(metas: metas, into: &sink)
    let bytes = sink.bytes
    expectEqual(bytes.count % Tar.recordSize, 0)
    // a.txt: header @0, data @512. pax member: xhdr @1024, pax data @1536,
    // file header @2048, file data @2560.
    expectEqual(cString(field(bytes[0 ..< 512], 0, 100)), "a.txt")
    expectEqual(bytes[1024 + 156], UInt8(ascii: "x"))
    expectTrue(cString(field(bytes[1024 ..< 1536], 0, 100)).hasPrefix("PaxHeaders/"))
    let record = Tar.paxPathRecord(Array(productionLongPath.utf8))
    expectEqual(Array(bytes[1536 ..< (1536 + record.count)]), record)
    expectEqual(bytes[2048 + 156], UInt8(ascii: "0"))
    expectEqual(Array(bytes[2560 ..< 2569]), Array("svg-bytes".utf8))
}

@Test(.enabled(if: Zstd.shared != nil))
func writeTarZstHandlesPaxPathsWithPledgedSizeIntact() throws {
    // End-to-end through the pledged-size integrity check: any prepass-vs-
    // stream byte drift makes zstd error at finish, so success here IS the
    // shared-encoder invariant.
    let bothViolated = String(repeating: "p", count: 120) + "/" + String(repeating: "q", count: 120) + ".txt"
    let root = try makeTree([
        (productionLongPath, [UInt8](repeating: 9, count: 700), false),
        (bothViolated, Array("deep".utf8), false),
        ("short.txt", Array("ok".utf8), false)
    ])
    defer { try? FileManager.default.removeItem(at: root) }
    let files = [productionLongPath, bothViolated, "short.txt"].sorted()
    let out1 = root.appendingPathComponent("p1.tar.zst").path
    let out2 = root.appendingPathComponent("p2.tar.zst").path
    let r1 = ArchiveWriter.writeTarZst(
        .init(sourceDir: root.path, outputPath: out1, files: files, level: 9, workers: 3))
    let r2 = ArchiveWriter.writeTarZst(
        .init(sourceDir: root.path, outputPath: out2, files: files, level: 9, workers: 3))
    guard case .success(let done) = r1, case .success = r2 else {
        Issue.record("pax archive build failed: \(r1) / \(r2)")
        return
    }
    expectEqual(done.fileCount, 3)  // pax blocks are not members
    expectEqual(try Data(contentsOf: URL(fileURLWithPath: out1)), try Data(contentsOf: URL(fileURLWithPath: out2)))
}

@Test func writeTarZstRejectsBadInputs() {
    let result = ArchiveWriter.writeTarZst(
        .init(sourceDir: "/nonexistent", outputPath: "/tmp/never.tar.zst", files: ["../escape"], level: 9, workers: 3),
    )
    guard case .failure(let failure) = result else {
        Issue.record("expected failure")
        return
    }
    #expect(failure.isInvalidInput)
}
