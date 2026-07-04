// Safe extraction of a snapshot `.tar.zst` (or `.tar.gz`) into a directory — the
// native install-extract for `ad-cli setup`. libzstd inflates the frame in
// BOUNDED memory (a DStream over the runtime binding in Zstd.swift, not the
// 32 MiB one-shot decoder) to a temp `.tar`, whose members are then VALIDATED
// against path traversal + unsafe entry types BEFORE the system `tar` extracts
// them. Mirrors the JS validate-archive.js → tar pipeline (setup.js:292), which
// also shells the OS `tar`; the added safety over a raw `tar -xf` is the pre-flight
// member audit. Extraction shells `tar` via Foundation.Process (never posix_spawn).

import Foundation

/// A structured archive-extraction failure (unsafe member, decompress/IO error).
public struct ArchiveExtractError: Error, Sendable, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

public enum TarZst {
    /// The system tar — present at this path on both macOS and Linux.
    private static let tarBinary = "/usr/bin/tar"

    /// Extract `archivePath` (`.tar.zst` / `.tar.gz` / `.tgz`) into `destDir`
    /// (created if absent). Rejects the WHOLE archive — before writing anything —
    /// if any member is an absolute path, contains a `..` component, or is not a
    /// regular file / directory (symlink, hardlink, device, fifo, socket). Throws
    /// `ArchiveExtractError` on an unsafe member, a decompress failure, or a tar
    /// non-zero exit.
    public static func extract(archivePath: String, into destDir: String) throws {
        try FileManager.default.createDirectory(atPath: destDir, withIntermediateDirectories: true)

        if archivePath.hasSuffix(".tar.zst") {
            guard Zstd.shared != nil else {
                throw ArchiveExtractError("libzstd not found — cannot decompress \(archivePath)")
            }
            let tempTar = temporaryPath(extension: "tar")
            defer { try? FileManager.default.removeItem(atPath: tempTar) }
            guard decompressToFile(archivePath, to: tempTar) else {
                throw ArchiveExtractError(
                    "zstd stream decompress failed for \(archivePath) (corrupt frame or IO error)")
            }
            try validateMembers(tempTar, gzip: false)
            try runTar(["-xf", tempTar, "-C", destDir, "--no-same-owner", "--no-same-permissions"])
        } else if archivePath.hasSuffix(".tar.gz") || archivePath.hasSuffix(".tgz") {
            // System tar decompresses gzip itself; validate through the same audit.
            try validateMembers(archivePath, gzip: true)
            try runTar(["-xzf", archivePath, "-C", destDir, "--no-same-owner", "--no-same-permissions"])
        } else {
            throw ArchiveExtractError(
                "unsupported archive format: \(archivePath) (expected .tar.zst, .tar.gz, or .tgz)")
        }
    }

    // MARK: - member validation (anti-traversal + type allowlist)

    /// Audit every member via two `tar -t` listings: the verbose form for the
    /// entry TYPE (first mode char), the plain form for the NAME. Throws on the
    /// first unsafe member. Only `-` (regular file) and `d` (directory) types pass.
    static func validateMembers(_ tarPath: String, gzip: Bool) throws {
        let verbose = try captureTar(gzip ? ["-tzvf", tarPath] : ["-tvf", tarPath])
        for line in verbose.split(separator: "\n", omittingEmptySubsequences: true) {
            // `tar -tv` renders the entry mode first; its leading char is the type:
            // -=file d=dir l=symlink h=hardlink c/b=device p=fifo s=socket.
            guard let type = line.first else { continue }
            if type != "-" && type != "d" {
                throw ArchiveExtractError(
                    "refusing archive: unsafe member type '\(type)' (\(String(line.prefix(120))))")
            }
        }

        let names = try captureTar(gzip ? ["-tzf", tarPath] : ["-tf", tarPath])
        for rawName in names.split(separator: "\n", omittingEmptySubsequences: true) {
            let name = String(rawName)
            if name.hasPrefix("/") {
                throw ArchiveExtractError("refusing archive: absolute member path: \(name)")
            }
            // Split KEEPING empties so a leading/interior `../` or `/..` is caught.
            if name.split(separator: "/", omittingEmptySubsequences: false).contains("..") {
                throw ArchiveExtractError("refusing archive: '..' in member path: \(name)")
            }
        }
    }

    // MARK: - streaming zstd → file

    /// Stream-decompress a `.zst` file to `outputPath` with bounded memory via
    /// libzstd's DStream. false when libzstd is unavailable or on a zstd/IO error.
    static func decompressToFile(_ inputPath: String, to outputPath: String) -> Bool {
        guard let lib = Zstd.shared,
            let input = FileHandle(forReadingAtPath: inputPath),
            FileManager.default.createFile(atPath: outputPath, contents: nil),
            let output = FileHandle(forWritingAtPath: outputPath),
            let dstream = lib.createDStream()
        else { return false }
        defer {
            try? input.close()
            try? output.close()
            _ = lib.freeDStream(dstream)
        }
        _ = lib.initDStream(dstream)

        let inChunk = max(lib.dStreamInSize(), 1 << 16)
        let outCapacity = max(lib.dStreamOutSize(), 1 << 16)
        var outBuffer = [UInt8](repeating: 0, count: outCapacity)

        while true {
            // `read(upToCount:)` returns nil at EOF; a `try?` would fold that into the
            // failure path, so distinguish EOF (empty → break) from a real IO throw.
            let data: Data
            do {
                data = try input.read(upToCount: inChunk) ?? Data()
            } catch {
                return false
            }
            if data.isEmpty { break }  // EOF
            let source = [UInt8](data)
            var failed = false
            source.withUnsafeBytes { (sourceRaw: UnsafeRawBufferPointer) in
                var inState = ZstdInBuffer(src: sourceRaw.baseAddress, size: source.count, pos: 0)
                while inState.pos < inState.size {
                    let previousInPos = inState.pos
                    var produced = 0
                    outBuffer.withUnsafeMutableBytes { (destRaw: UnsafeMutableRawBufferPointer) in
                        var outState = ZstdOutBuffer(dst: destRaw.baseAddress, size: outCapacity, pos: 0)
                        let ret = withUnsafeMutablePointer(to: &inState) { inPointer in
                            withUnsafeMutablePointer(to: &outState) { outPointer in
                                lib.decompressStream(
                                    dstream, UnsafeMutableRawPointer(outPointer), UnsafeMutableRawPointer(inPointer))
                            }
                        }
                        if lib.isError(ret) != 0 { failed = true }
                        produced = outState.pos
                    }
                    if failed { return }
                    if produced > 0 { output.write(Data(outBuffer[0 ..< produced])) }
                    // A valid stream always consumes input or emits output; if neither
                    // moved, the frame is malformed — bail instead of spinning.
                    if inState.pos == previousInPos && produced == 0 {
                        failed = true
                        return
                    }
                }
            }
            if failed { return false }
        }
        return true
    }

    // MARK: - process helpers

    /// Run `tar <args>`, discarding stdout, throwing on a non-zero exit.
    private static func runTar(_ args: [String]) throws {
        _ = try captureTar(args)
    }

    /// Run `tar <args>` and return stdout; throw `ArchiveExtractError` on failure.
    /// stdout is drained before `waitUntilExit` so a large listing can't deadlock
    /// on a full pipe buffer.
    @discardableResult
    private static func captureTar(_ args: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tarBinary)
        process.arguments = args
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        do {
            try process.run()
        } catch {
            throw ArchiveExtractError("cannot launch \(tarBinary): \(error.localizedDescription)")
        }
        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let stderr = String(decoding: errData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw ArchiveExtractError(
                "tar \(args.first ?? "") failed (exit \(process.terminationStatus)): \(stderr.prefix(400))")
        }
        return String(decoding: outData, as: UTF8.self)
    }

    /// A unique path in the system temp dir for the decompressed `.tar`.
    private static func temporaryPath(extension ext: String) -> String {
        let dir = NSTemporaryDirectory()
        return "\(dir)adcli-extract-\(UUID().uuidString).\(ext)"
    }
}
