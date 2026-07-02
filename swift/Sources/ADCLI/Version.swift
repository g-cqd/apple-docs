// `ad-cli version` — the F1 maintenance verb mirroring cli.js `version`
// (src/cli/maintenance.js dispatchVersion): tool version + short commit hash,
// plus corpus provenance when a corpus is reachable. The verb must work with NO
// corpus at all (fresh install, standalone binary), so `--db` is optional here
// and an unopenable path is non-fatal — provenance is simply omitted, exactly
// like the JS try/catch around the snapshot_meta reads.

import ADJSONCore
import ADStorage
import ArgumentParser
import Foundation

/// The tool version. Source of truth is package.json `version` (the JS CLI
/// inlines it at build time via a JSON import); this constant MUST track it —
/// the cli-parity `version` cases fail on drift, and the F5 packaging step is
/// the designated place to stamp/verify it at release time.
let adVersion = "1.0.0"

/// `ad-cli version [--db <PATH>] [--json]`.
struct VersionCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "version",
        abstract: "Show tool version, commit, and corpus provenance.")

    @Option(name: .long, help: "Path to the corpus SQLite database (optional — provenance only).")
    var db: String?

    @Flag(name: .long, help: "Emit JSON instead of the human lines.")
    var json = false

    func run() throws {
        var snapshot: String?
        var buildMacos: String?
        // Corpus provenance is a bonus (JS: try/catch around the meta reads) —
        // a missing/unopenable corpus just means no `corpus:` line.
        if let db, let connection = StorageConnection(path: db) {
            snapshot =
                connection.getSnapshotMeta("snapshot_tag")
                ?? connection.getSnapshotMeta("snapshot_version")
            buildMacos = connection.getSnapshotMeta("build_macos")
        }
        let info = VersionInfo(
            version: adVersion, commit: gitCommitHash(), snapshot: snapshot,
            snapshotBuildMacos: buildMacos)
        print(json ? stringifyPretty(versionJSON(info)) : formatVersion(info))
    }
}

/// The `{ version, commit, snapshot?, snapshotBuildMacos? }` result.
struct VersionInfo {
    var version: String
    var commit: String?
    var snapshot: String?
    var snapshotBuildMacos: String?
}

/// JSON twin of the JS result object: `version` and `commit` always present
/// (commit may be null); the snapshot fields appear only when TRUTHY (JS
/// `if (tag) result.snapshot = tag` — an empty string is omitted).
func versionJSON(_ info: VersionInfo) -> JSONValue {
    var pairs: [(String, JSONValue)] = [
        ("version", .string(info.version)),
        ("commit", info.commit.map(JSONValue.string) ?? .null),
    ]
    if let snapshot = info.snapshot, !snapshot.isEmpty {
        pairs.append(("snapshot", .string(snapshot)))
    }
    if let macos = info.snapshotBuildMacos, !macos.isEmpty {
        pairs.append(("snapshotBuildMacos", .string(macos)))
    }
    return .obj(pairs)
}

/// The human formatter: `apple-docs <v>[ (<commit>)]` + an optional
/// `corpus: <tag>[ (built on macOS <v>)]` line. Truthiness mirrors the JS
/// template (`r.commit ?`, `r.snapshot ?`, `r.snapshotBuildMacos ?`).
func formatVersion(_ info: VersionInfo) -> String {
    var head = "apple-docs \(info.version)"
    if let commit = info.commit, !commit.isEmpty { head += " (\(commit))" }
    var lines = [head]
    if let snapshot = info.snapshot, !snapshot.isEmpty {
        var corpus = "corpus: \(snapshot)"
        if let macos = info.snapshotBuildMacos, !macos.isEmpty {
            corpus += " (built on macOS \(macos))"
        }
        lines.append(corpus)
    }
    return lines.joined(separator: "\n")
}
