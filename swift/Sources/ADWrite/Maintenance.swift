// Shared plumbing for the maintenance verbs (`storage gc/materialize/compact`,
// `prune`, `index rebuild`) — the write-connection helpers their JS
// counterparts get from DocsDatabase (`hasTable`, `changes()`) plus the
// `withFileTempStore` VACUUM guard from `src/storage/pragmas.js` (VACUUM builds
// its transient copy in temp storage; FILE keeps a multi-GB corpus VACUUM from
// allocating that copy in RAM) and the `keyPath`/`writeText` file helpers from
// `src/lib/safe-path.js` / `src/storage/files.js`.

import ADStorage
import Foundation

/// A maintenance verb's refusal — the JS `ValidationError` surface. The CLI
/// prints `Error: <message>` to stderr and exits 1 (the cli.js catch contract).
public struct MaintenanceError: Error, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

extension SQLiteWriteConnection {
    /// `DocsDatabase.hasTable(name)` — one sqlite_master probe.
    func hasTable(_ name: String) throws(SQLiteWriteError) -> Bool {
        try get(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=$name",
            ["name": .text(name)]) != nil
    }

    /// `SELECT changes()` — rows touched by the connection's last statement
    /// (the JS gc's orphan accounting).
    func changes() throws(SQLiteWriteError) -> Int {
        Int(try get("SELECT changes() AS c")?.int("c") ?? 0)
    }

    /// `withFileTempStore(db, fn)` (src/storage/pragmas.js): run `body` with
    /// `temp_store = FILE`, restoring MEMORY afterwards even on throw.
    func withFileTempStore(_ body: () throws(SQLiteWriteError) -> Void) throws(SQLiteWriteError) {
        try run("PRAGMA temp_store = FILE")
        defer { try? run("PRAGMA temp_store = MEMORY") }
        try body()
    }
}

/// `keyPath(dataDir, subdir, key, ext)` (lib/safe-path.js) — the shared
/// key→path mapping the snapshot writer and the read verbs already use. nil
/// when the key fails validation (traversal / absolute / forbidden char).
func keyPath(dataDir: String, subdir: String, key: String, ext: String) -> String? {
    Snapshot.storageKeyPath(dataDir: dataDir, subdir: subdir, key: key, ext: ext)
}

/// `writeText(filePath, text)` (storage/files.js): ensure the parent directory,
/// then write the file (overwriting).
func writeText(_ text: String, to path: String) throws {
    let parent = (path as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
    try text.write(toFile: path, atomically: true, encoding: .utf8)
}

/// `$p0,$p1,…` placeholders + their bound values for a dynamic `IN (…)` list —
/// the JS verbs' `paths.map(() => '?').join(',')` under this connection's
/// named-parameter binding.
func inList(_ values: [SQLiteValue]) -> (marks: String, params: [String: SQLiteValue]) {
    var params: [String: SQLiteValue] = [:]
    params.reserveCapacity(values.count)
    var marks: [String] = []
    marks.reserveCapacity(values.count)
    for (index, value) in values.enumerated() {
        marks.append("$p\(index)")
        params["p\(index)"] = value
    }
    return (marks.joined(separator: ","), params)
}
