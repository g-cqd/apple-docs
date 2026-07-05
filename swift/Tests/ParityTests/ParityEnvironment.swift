// Tier 1 CLI/HTTP verb-for-verb golden parity harness (RFC 0007 §12). This file locates the
// external tools the harness drives — `bun` (the JS engine, `cli.js`), the release-built `ad-cli`
// binary (the Swift engine), and the apple-docs repo root `bun` needs as its working directory —
// plus the committed fixture corpus both engines read.
//
// Every lookup is best-effort and non-throwing: `isAvailable` gates the whole suite (see
// CLIParityTests.swift's `.enabled(if:)`), so a missing tool SKIPS the parity tests instead of
// crashing them — the same discipline `SQLiteReferenceExtractor.bunAvailable` already established
// for the schema-parity gate (ADWriteTests). That type is internal to the ADWriteTests module, so
// the small "locate bun on PATH" lookup is duplicated here rather than shared across the test-target
// boundary (this package has no shared test-support target; each test target owns its own).

import Foundation

enum ParityEnvironment {
    /// Resolve `bun`: PATH first (`env which bun`), then common install locations.
    static func locateBun() -> String? {
        let candidates = [
            "/opt/homebrew/bin/bun", "/usr/local/bin/bun",
            (NSHomeDirectory() as NSString).appendingPathComponent(".bun/bin/bun")
        ]
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        which.arguments = ["which", "bun"]
        let pipe = Pipe()
        which.standardOutput = pipe
        which.standardError = Pipe()
        if (try? which.run()) != nil {
            which.waitUntilExit()
            if which.terminationStatus == 0,
                let data = try? pipe.fileHandleForReading.readToEnd(),
                let path = String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                !path.isEmpty, FileManager.default.isExecutableFile(atPath: path)
            {
                return path
            }
        }
        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        return nil
    }

    /// Walks up from this source file to the apple-docs repo root (the directory containing
    /// `cli.js`). This file lives at `<root>/swift/Tests/ParityTests/ParityEnvironment.swift`, so
    /// the walk is short — but resolving it dynamically (rather than hardcoding `../../..`) keeps
    /// the lookup correct regardless of where the checkout lives on disk.
    static func locateAppleDocsRoot(fromFile file: String = #filePath) -> String? {
        var dir = URL(fileURLWithPath: file).deletingLastPathComponent()
        for _ in 0 ..< 8 {
            let marker = dir.appendingPathComponent("cli.js")
            if FileManager.default.fileExists(atPath: marker.path) { return dir.path }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        return nil
    }

    /// The Swift package root (`<repo>/swift`), so `.build/<config>/ad-cli` can be found relative
    /// to it without hardcoding a relative offset from this file.
    static func locateSwiftPackageRoot(fromFile file: String = #filePath) -> String? {
        var dir = URL(fileURLWithPath: file).deletingLastPathComponent()
        for _ in 0 ..< 8 {
            let marker = dir.appendingPathComponent("Package.swift")
            if FileManager.default.fileExists(atPath: marker.path) { return dir.path }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        return nil
    }

    /// Resolve the `ad-cli` binary: an explicit `AD_CLI_BINARY` override first (CI can point this
    /// at whatever config/path it built), else `.build/release/ad-cli`, else `.build/debug/ad-cli`,
    /// relative to the Swift package root. Release is preferred (it's what the task's own build
    /// step produces), debug is a fallback for a local `swift test` that never ran a release build.
    static func locateAdCli() -> String? {
        let env = ProcessInfo.processInfo.environment
        if let override = env["AD_CLI_BINARY"], !override.isEmpty,
            FileManager.default.isExecutableFile(atPath: override)
        {
            return override
        }
        guard let packageRoot = locateSwiftPackageRoot() else { return nil }
        for config in ["release", "debug"] {
            let candidate = (packageRoot as NSString).appendingPathComponent(".build/\(config)/ad-cli")
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    /// Whether the apple-docs root has `node_modules` installed — `cli.js`'s very first imports
    /// (`src/config.js`) pull `zod`, so a checkout that never ran `bun install` fails immediately
    /// with a module-resolution error. Treated as an availability gate (skip), not a hard failure.
    static func hasNodeModules(appleDocsRoot: String) -> Bool {
        var isDirectory: ObjCBool = false
        let path = (appleDocsRoot as NSString).appendingPathComponent("node_modules")
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    static let bunPath: String? = locateBun()
    static let appleDocsRoot: String? = locateAppleDocsRoot()
    static let adCliPath: String? = locateAdCli()
    static let nodeModulesPresent: Bool = appleDocsRoot.map(hasNodeModules(appleDocsRoot:)) ?? false

    /// The committed fixture directory (read-only source of truth — tests copy out of it, never
    /// operate on it directly; see `ParityFixture.makeFresh`).
    static let fixturesRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")

    /// Whether every external prerequisite is present. `.enabled(if:)` gates the whole suite on
    /// this so a leg without `bun`/`node_modules`/a release `ad-cli` build SKIPS cleanly.
    static var isAvailable: Bool {
        bunPath != nil && appleDocsRoot != nil && adCliPath != nil && nodeModulesPresent
    }

    /// A human-readable diagnostic for why the suite is disabled — printed once by the suite's
    /// `.enabled(if:)` reason string (only meaningful when `isAvailable` is false).
    static var unavailableReason: String {
        var missing: [String] = []
        if bunPath == nil { missing.append("bun (checked PATH + common install locations)") }
        if appleDocsRoot == nil { missing.append("apple-docs repo root (walked up looking for cli.js)") }
        if adCliPath == nil {
            missing.append(
                "ad-cli binary (checked $AD_CLI_BINARY, .build/release/ad-cli, .build/debug/ad-cli — "
                    + "run `swift build -c release --product ad-cli` first)")
        }
        if let appleDocsRoot, !hasNodeModules(appleDocsRoot: appleDocsRoot) {
            missing.append("node_modules at \(appleDocsRoot) (run `bun install`)")
        }
        return missing.isEmpty ? "unknown" : missing.joined(separator: "; ")
    }
}
