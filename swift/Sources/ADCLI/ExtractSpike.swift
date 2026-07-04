// `ad-cli _extract-spike --archive <path> --out <dir>` — a hidden functional
// harness for the native install-extract (ADArchive.TarZst): stream-decompress +
// validate + extract a `.tar.zst` / `.tar.gz`. Mirrors the `_addb-*-spike` debug
// verbs; not part of the public surface (the forthcoming `setup` verb calls
// `TarZst.extract` directly). Exits 0 on success, 2 when the archive is rejected
// (unsafe member), 1 on any other extraction error.

import ADArchive
import ArgumentParser
import Foundation

struct ExtractSpikeCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "_extract-spike",
        abstract: "Debug: safely extract a .tar.zst/.tar.gz snapshot archive.",
        shouldDisplay: false)

    @Option(name: .long, help: "The .tar.zst / .tar.gz archive to extract.")
    var archive: String

    @Option(name: .long, help: "Destination directory (created if absent).")
    var out: String

    func run() throws {
        do {
            try TarZst.extract(archivePath: archive, into: out)
            print("extracted \(archive) -> \(out)")
        } catch let error as ArchiveExtractError {
            FileHandle.standardError.write(Data("REJECTED: \(error.message)\n".utf8))
            throw ExitCode(2)
        }
    }
}
