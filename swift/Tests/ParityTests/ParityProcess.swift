// A minimal `Process` wrapper shared by both engines: spawn an executable, capture stdout/stderr as
// UTF-8 text plus the exit code. The comparison layer (CLIParityTests.swift) sees one uniform
// `ProcessOutcome` regardless of whether it came from `bun cli.js` or the native `ad-cli`.

import Foundation

/// The captured result of running one CLI invocation.
struct ProcessOutcome: Sendable {
    var stdout: String
    var stderr: String
    var exitCode: Int32
}

enum ParityProcess {
    /// Runs `executable arguments...` in `currentDirectory`, with `environment` OVERLAID onto the
    /// ambient process environment (so `bun`/`ad-cli` still find their own runtime dependencies —
    /// dynamic linker search paths, `$HOME`, etc. — while the caller's deterministic overrides,
    /// e.g. `APPLE_DOCS_HOME`, always win).
    ///
    /// Reads stdout then stderr to EOF before `waitUntilExit()`, the same sequential-`readToEnd()`
    /// shape `ADWriteTests/SQLiteReferenceExtractor.build()` already uses for its own `bun`
    /// subprocess. That ordering can in principle deadlock a child that fills one pipe's kernel
    /// buffer before the other is drained, but every verb in this harness's fixed, deliberately tiny
    /// fixture-driven arg matrix produces at most a few KB of output — well under a pipe buffer —
    /// so the risk is theoretical here, and matching the established, already-proven pattern beats
    /// introducing a different concurrency shape for one file.
    static func run(
        executable: String, arguments: [String], environment overrides: [String: String],
        currentDirectory: String
    ) throws -> ProcessOutcome {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        for (key, value) in overrides { environment[key] = value }
        process.environment = environment
        process.currentDirectoryURL = URL(fileURLWithPath: currentDirectory)

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        try process.run()
        let outData = (try? stdoutPipe.fileHandleForReading.readToEnd()) ?? Data()
        let errData = (try? stderrPipe.fileHandleForReading.readToEnd()) ?? Data()
        process.waitUntilExit()

        return ProcessOutcome(
            stdout: String(decoding: outData, as: UTF8.self),
            stderr: String(decoding: errData, as: UTF8.self),
            exitCode: process.terminationStatus)
    }
}
