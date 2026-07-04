import Foundation
import Testing

@testable import ADArchive

// Safe `.tar.zst` extraction (the native install-extract). The streaming zstd
// decompress must round-trip a real frame, and the member audit must REJECT the
// whole archive on the two escape vectors — a symlink member (the primary
// sandbox-escape) and a `../` path — before anything is written to disk. Skipped
// when libzstd is unavailable on the host (the loader degrades to nil).
@Suite("TarZst safe extraction", .serialized)
struct TarZstTests {
    private func run(_ launch: String, _ args: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launch)
        process.arguments = args
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
    }

    private func tempDir() -> String {
        let dir = NSTemporaryDirectory() + "tarzsttest-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    /// tar a source subtree, then zstd-compress the tar → a `.tar.zst` path.
    private func makeTarZst(sourceDir: String, member: String, at work: String) throws -> String? {
        let tarPath = work + "/bundle.tar"
        try run("/usr/bin/tar", ["-cf", tarPath, "-C", sourceDir, member])
        let tarBytes = [UInt8](try Data(contentsOf: URL(fileURLWithPath: tarPath)))
        guard let compressed = ZstdEncoder.compress(tarBytes) else { return nil }
        let zstPath = work + "/bundle.tar.zst"
        try Data(compressed).write(to: URL(fileURLWithPath: zstPath))
        return zstPath
    }

    @Test("a well-formed .tar.zst round-trips into the destination")
    func happyPath() throws {
        guard Zstd.shared != nil else { return }
        let work = tempDir()
        defer { try? FileManager.default.removeItem(atPath: work) }
        let source = work + "/src"
        try FileManager.default.createDirectory(atPath: source + "/sub", withIntermediateDirectories: true)
        try "hello".write(toFile: source + "/sub/a.txt", atomically: true, encoding: .utf8)

        guard let zstPath = try makeTarZst(sourceDir: source, member: "sub", at: work) else { return }
        let dest = work + "/out"
        try TarZst.extract(archivePath: zstPath, into: dest)

        #expect(FileManager.default.fileExists(atPath: dest + "/sub/a.txt"))
        #expect((try? String(contentsOfFile: dest + "/sub/a.txt", encoding: .utf8)) == "hello")
    }

    @Test("a symlink member is rejected before anything is extracted")
    func rejectsSymlink() throws {
        guard Zstd.shared != nil else { return }
        let work = tempDir()
        defer { try? FileManager.default.removeItem(atPath: work) }
        let source = work + "/src"
        try FileManager.default.createDirectory(atPath: source, withIntermediateDirectories: true)
        try run("/bin/ln", ["-s", "/etc/passwd", source + "/evil"])

        guard let zstPath = try makeTarZst(sourceDir: source, member: "evil", at: work) else { return }
        let dest = work + "/out"
        #expect(throws: ArchiveExtractError.self) {
            try TarZst.extract(archivePath: zstPath, into: dest)
        }
        #expect(!FileManager.default.fileExists(atPath: dest + "/evil"))
    }

    @Test("streaming zstd decompress reproduces the original bytes")
    func streamingDecompressRoundTrip() throws {
        guard Zstd.shared != nil else { return }
        let work = tempDir()
        defer { try? FileManager.default.removeItem(atPath: work) }
        // A few MB of compressible-but-varied data to exercise multi-chunk streaming.
        let original = (0 ..< (3 << 20)).map { UInt8(($0 &* 31 &+ 7) & 0xFF) }
        guard let compressed = ZstdEncoder.compress(original) else { return }
        let zstPath = work + "/blob.zst"
        try Data(compressed).write(to: URL(fileURLWithPath: zstPath))
        let outPath = work + "/blob.out"
        #expect(TarZst.decompressToFile(zstPath, to: outPath))
        let roundTripped = [UInt8](try Data(contentsOf: URL(fileURLWithPath: outPath)))
        #expect(roundTripped == original)
    }
}
