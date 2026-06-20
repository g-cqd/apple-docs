// Builds the crawl-persist parity FIXTURE by shelling out to the deterministic
// `bun` generator (Tests/ADWriteTests/Fixtures/make-fixture.js). The generator
// reads a handful of real apple-docs documents from the test corpus and emits
// BOTH the native input (normalized.json) and the JS-writer reference
// (reference.sqlite). This Swift side only locates the inputs, runs the script,
// and returns the output paths.
//
// Mirrors SQLiteReferenceExtractor's `bun`/root-locating idiom so the two gates
// resolve their toolchain the same way.

import Foundation

enum FixtureError: Error, CustomStringConvertible {
    case appleDocsRootNotFound(triedFrom: String)
    case bunNotFound
    case corpusNotFound(path: String)
    case generatorFailed(status: Int32, stderr: String)
    case outputMissing(String)

    var description: String {
        switch self {
            case .appleDocsRootNotFound(let from):
                return "could not locate the apple-docs root (with src/storage/database.js) walking up from \(from)"
            case .bunNotFound:
                return "`bun` was not found on PATH or at common locations; the persist parity gate needs it to build the fixture"
            case .corpusNotFound(let path):
                return "the apple-docs test corpus was not found at \(path) (set AD_PERSIST_CORPUS to override)"
            case .generatorFailed(let status, let stderr):
                return "make-fixture.js exited \(status):\n\(stderr)"
            case .outputMissing(let what):
                return "make-fixture.js did not produce \(what)"
        }
    }
}

enum FixtureBuilder {
    struct Fixture {
        /// The throwaway directory holding the generated fixture (caller removes it).
        var directory: URL
        /// The native input: an array of normalize() records.
        var normalizedJSON: URL
        /// The JS-writer reference DB (a fresh SQLite written by DocsDatabase).
        var referenceSQLite: URL
    }

    /// The default corpus path (overridable via the `AD_PERSIST_CORPUS` env var).
    static let defaultCorpusPath =
        "/Users/guillaumecoquard/Public/apple-docs-testing-native/apple-docs.db"

    /// Generate the fixture into a fresh temp directory and return its paths.
    static func build() throws -> Fixture {
        let root = try locateAppleDocsRoot()
        let bun = try locateBun()
        let corpusPath = ProcessInfo.processInfo.environment["AD_PERSIST_CORPUS"] ?? defaultCorpusPath
        guard FileManager.default.fileExists(atPath: corpusPath) else {
            throw FixtureError.corpusNotFound(path: corpusPath)
        }

        let outDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adwrite-persist-fixture-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

        let script = "\(root)/swift/Tests/ADWriteTests/Fixtures/make-fixture.js"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: bun)
        process.arguments = [script, corpusPath, outDir.path]
        process.currentDirectoryURL = URL(fileURLWithPath: root)
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        let errData = (try? stderr.fileHandleForReading.readToEnd()) ?? Data()
        _ = try? stdout.fileHandleForReading.readToEnd()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw FixtureError.generatorFailed(
                status: process.terminationStatus,
                stderr: String(data: errData, encoding: .utf8) ?? "<non-utf8 stderr>")
        }

        let normalizedJSON = outDir.appendingPathComponent("normalized.json")
        let referenceSQLite = outDir.appendingPathComponent("reference.sqlite")
        guard FileManager.default.fileExists(atPath: normalizedJSON.path) else {
            throw FixtureError.outputMissing("normalized.json")
        }
        guard FileManager.default.fileExists(atPath: referenceSQLite.path) else {
            throw FixtureError.outputMissing("reference.sqlite")
        }
        return Fixture(
            directory: outDir, normalizedJSON: normalizedJSON, referenceSQLite: referenceSQLite)
    }

    /// Walk up from this source file to the apple-docs root (the dir with
    /// `src/storage/database.js`). This file lives at
    /// `<root>/swift/Tests/ADWriteTests/FixtureBuilder.swift`.
    static func locateAppleDocsRoot(fromFile file: String = #filePath) throws -> String {
        var dir = URL(fileURLWithPath: file).deletingLastPathComponent()
        for _ in 0..<8 {
            let marker = dir.appendingPathComponent("src/storage/database.js")
            if FileManager.default.fileExists(atPath: marker.path) { return dir.path }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        throw FixtureError.appleDocsRootNotFound(triedFrom: file)
    }

    /// Resolve a `bun` executable: PATH first, then common install locations.
    static func locateBun() throws -> String {
        let candidates = [
            "/opt/homebrew/bin/bun", "/usr/local/bin/bun",
            (NSHomeDirectory() as NSString).appendingPathComponent(".bun/bin/bun"),
        ]
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        which.arguments = ["which", "bun"]
        let pipe = Pipe()
        which.standardOutput = pipe
        which.standardError = Pipe()
        try? which.run()
        which.waitUntilExit()
        if which.terminationStatus == 0,
            let data = try? pipe.fileHandleForReading.readToEnd(),
            let path = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
            !path.isEmpty, FileManager.default.isExecutableFile(atPath: path)
        {
            return path
        }
        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        throw FixtureError.bunNotFound
    }
}
