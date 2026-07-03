import Foundation
import Testing

@testable import ADOps

/// Access to the bundled `Fixtures/` resource tree (templates + JS-rendered
/// expected outputs + the canonical `.env`).
enum Fixtures {
    static let base: URL = {
        guard let url = Bundle.module.url(forResource: "Fixtures", withExtension: nil) else {
            fatalError("ADOpsTests: Fixtures/ resource directory not bundled")
        }
        return url
    }()

    static func bytes(_ relative: String) -> [UInt8] {
        let url = base.appendingPathComponent(relative)
        guard let data = try? Data(contentsOf: url) else {
            fatalError("ADOpsTests: missing fixture \(relative)")
        }
        return [UInt8](data)
    }

    static func text(_ relative: String) -> String {
        String(decoding: bytes(relative), as: UTF8.self)
    }
}

/// A test-only logger that captures every emitted line in order.
final class CapturingLogger: OpsLogging, @unchecked Sendable {
    private let lock = NSLock()
    private var _lines: [String] = []
    let logPath: String? = nil

    var lines: [String] {
        lock.lock()
        defer { lock.unlock() }
        return _lines
    }

    private func append(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        _lines.append(line)
    }

    func say(_ message: String) { append(message) }
    func warn(_ message: String) { append("WARN: " + message) }
    func error(_ message: String) { append("ERROR: " + message) }
    func runStart(_ command: String, _ arguments: [String]) {
        append("$ " + ([command] + arguments).joined(separator: " "))
    }
    func runOutput(_ text: String) { append(text) }
}

/// An in-memory filesystem for exercising RenderAll without touching disk.
final class MemoryFileSystem: OpsFileSystem, @unchecked Sendable {
    private let lock = NSLock()
    private var files: [String: [UInt8]] = [:]
    private var dirs: Set<String> = []

    init(files: [String: [UInt8]] = [:], dirs: Set<String> = []) {
        self.files = files
        self.dirs = dirs
    }

    func seed(file path: String, _ bytes: [UInt8]) {
        lock.lock()
        defer { lock.unlock() }
        files[path] = bytes
        var parent = parentPath(path)
        while !parent.isEmpty {
            dirs.insert(parent)
            parent = parentPath(parent)
        }
    }

    func snapshot() -> [String: [UInt8]] {
        lock.lock()
        defer { lock.unlock() }
        return files
    }

    func read(_ path: String) throws -> [UInt8] {
        lock.lock()
        defer { lock.unlock() }
        guard let bytes = files[path] else { throw OpsIOError("no such file \(path)") }
        return bytes
    }

    func tryRead(_ path: String) -> [UInt8]? {
        lock.lock()
        defer { lock.unlock() }
        return files[path]
    }

    func exists(_ path: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return files[path] != nil || dirs.contains(path)
    }

    func listDir(_ path: String) throws -> [DirEntry] {
        lock.lock()
        defer { lock.unlock() }
        var entries: [DirEntry] = []
        var seen: Set<String> = []
        let prefix = path.hasSuffix("/") ? path : path + "/"
        for key in files.keys where key.hasPrefix(prefix) {
            let rest = String(key.dropFirst(prefix.count))
            if let slash = rest.firstIndex(of: "/") {
                let dir = String(rest[rest.startIndex ..< slash])
                if seen.insert(dir).inserted {
                    entries.append(DirEntry(name: dir, isDirectory: true, isFile: false))
                }
            } else if seen.insert(rest).inserted {
                entries.append(DirEntry(name: rest, isDirectory: false, isFile: true))
            }
        }
        for dir in dirs where dir.hasPrefix(prefix) {
            let rest = String(dir.dropFirst(prefix.count))
            if !rest.contains("/"), seen.insert(rest).inserted {
                entries.append(DirEntry(name: rest, isDirectory: true, isFile: false))
            }
        }
        return entries
    }

    func ensureDir(_ path: String) throws {
        lock.lock()
        defer { lock.unlock() }
        dirs.insert(path)
    }

    func writeAtomic(_ path: String, _ bytes: [UInt8], mode: UInt16) throws {
        lock.lock()
        defer { lock.unlock() }
        files[path] = bytes
        dirs.insert(parentPath(path))
    }
}

/// A scripted CommandRunner that records every invocation. `run` throws a
/// `.exit` RunCmdError when the scripted result is non-zero, so the protocol's
/// default `runAllowFailure` returns it as a value (mirrors the real runner).
final class FakeCommandRunner: CommandRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [[String]] = []
    private let responder: @Sendable ([String]) throws -> RunCmdResult

    init(_ responder: @escaping @Sendable ([String]) throws -> RunCmdResult) {
        self.responder = responder
    }

    var calls: [[String]] {
        lock.lock()
        defer { lock.unlock() }
        return _calls
    }

    func run(_ args: [String], options: RunCmdOptions) async throws -> RunCmdResult {
        lock.withLock { _calls.append(args) }
        let result = try responder(args)
        if result.exitCode != 0 {
            throw RunCmdError(
                message: "exit \(result.exitCode)", kind: .exit, args: args,
                exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr)
        }
        return result
    }
}

/// A zero-exit result with the given streams.
func okResult(stdout: String = "", stderr: String = "") -> RunCmdResult {
    RunCmdResult(stdout: stdout, stderr: stderr, exitCode: 0, elapsedMs: 1)
}

/// A non-zero-exit result.
func failResult(_ code: Int32, stderr: String = "") -> RunCmdResult {
    RunCmdResult(stdout: "", stderr: stderr, exitCode: code, elapsedMs: 1)
}

/// A scripted GitHub fetcher.
struct FakeGhFetcher: GhFetcher {
    let responder: @Sendable (String) -> GhResponse
    func get(_ url: String, headers: [String: String]) async throws -> GhResponse {
        responder(url)
    }
}

/// A scripted HTTP probe (no network). `ok` is computed as `status == expected`,
/// matching the real probe.
struct FakeProbe: HTTPProbing {
    let responder: @Sendable (String, ProbeOptions) -> (status: Int?, body: String, outcome: ProbeOutcome)
    func probe(_ url: String, options: ProbeOptions) async -> ProbeResult {
        let scripted = responder(url, options)
        return ProbeResult(
            ok: scripted.status == options.expectedStatus, status: scripted.status,
            elapsedMs: 1, body: scripted.body, outcome: scripted.outcome, url: url)
    }
}

/// A probe that answers the same status/body/outcome for every request.
func constantProbe(status: Int?, body: String = "", outcome: ProbeOutcome = .http) -> FakeProbe {
    FakeProbe { _, _ in (status, body, outcome) }
}

/// A no-op async sleep (for verbs that inject their sleep seam).
let instantSleep: @Sendable (Int) async -> Void = { _ in }

/// A fully-derived LoadedEnv from the canonical fixture .env.
func loadedFixtureEnv(opsDir: String = "/ops") -> LoadedEnv {
    var vars = OpsEnv.parse(Fixtures.text("fixture.env"))
    // applyDerived only throws on a bad channel; the fixture is valid.
    try? OpsEnv.applyDerived(&vars)
    return OpsEnv.finalize(vars: vars, opsDir: opsDir)
}
