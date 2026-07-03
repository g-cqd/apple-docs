// Subprocess wrapper for the ops layer — the native port of ops/lib/run-cmd.js.
//
// Every ops verb that shells out (launchctl, install, git, caddy, the bun
// entrypoint) goes through one seam so timeouts are uniform + explicit
// (`deadlineMs`), stdout/stderr capture is bounded, and non-zero exits +
// timeouts throw the same structured error. `CommandRunner` is the injection
// point: verbs take `any CommandRunner`, tests pass a fake, production passes
// `ProcessCommandRunner`.

private import Foundation

/// How a child's stdout/stderr is handled.
public enum StdioMode: Sendable {
    case pipe
    case inherit
    case ignore
}

/// Options for a single command invocation.
public struct RunCmdOptions: Sendable {
    public var deadlineMs: Int
    public var cwd: String?
    public var env: [String: String]?
    public var stdout: StdioMode
    public var stderr: StdioMode
    public var stdin: String?
    public var stdoutMaxBytes: Int
    public var stderrMaxBytes: Int

    public init(
        deadlineMs: Int = 60_000,
        cwd: String? = nil,
        env: [String: String]? = nil,
        stdout: StdioMode = .pipe,
        stderr: StdioMode = .pipe,
        stdin: String? = nil,
        stdoutMaxBytes: Int = 4 * 1024 * 1024,
        stderrMaxBytes: Int = 256 * 1024
    ) {
        self.deadlineMs = deadlineMs
        self.cwd = cwd
        self.env = env
        self.stdout = stdout
        self.stderr = stderr
        self.stdin = stdin
        self.stdoutMaxBytes = stdoutMaxBytes
        self.stderrMaxBytes = stderrMaxBytes
    }
}

/// The result of a completed command.
public struct RunCmdResult: Sendable, Equatable {
    public let stdout: String
    public let stderr: String
    public let exitCode: Int32
    public let elapsedMs: Int

    public init(stdout: String, stderr: String, exitCode: Int32, elapsedMs: Int) {
        self.stdout = stdout
        self.stderr = stderr
        self.exitCode = exitCode
        self.elapsedMs = elapsedMs
    }
}

/// A structured subprocess failure. `kind` lets `runAllowFailure` return an exit
/// failure as a value while still rethrowing timeouts / usage errors.
public struct RunCmdError: Error, Sendable {
    public enum Kind: Sendable, Equatable { case usage, timeout, exit, spawn }
    public let message: String
    public let kind: Kind
    public let args: [String]
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String
    public let elapsedMs: Int

    public init(
        message: String, kind: Kind, args: [String] = [], exitCode: Int32 = 0,
        stdout: String = "", stderr: String = "", elapsedMs: Int = 0
    ) {
        self.message = message
        self.kind = kind
        self.args = args
        self.exitCode = exitCode
        self.stdout = stdout
        self.stderr = stderr
        self.elapsedMs = elapsedMs
    }
}

/// The subprocess seam. `run` throws on non-zero exit / timeout; `runAllowFailure`
/// returns a non-zero exit as a value (rethrows timeout / usage / spawn).
public protocol CommandRunner: Sendable {
    func run(_ args: [String], options: RunCmdOptions) async throws -> RunCmdResult
    func runAllowFailure(_ args: [String], options: RunCmdOptions) async throws -> RunCmdResult
}

extension CommandRunner {
    public func run(_ args: [String]) async throws -> RunCmdResult {
        try await run(args, options: RunCmdOptions())
    }
    /// Default `runAllowFailure`: call `run`, convert an `exit` failure to a value.
    public func runAllowFailure(_ args: [String], options: RunCmdOptions) async throws
        -> RunCmdResult
    {
        do {
            return try await run(args, options: options)
        } catch let error as RunCmdError where error.kind == .exit {
            return RunCmdResult(
                stdout: error.stdout, stderr: error.stderr, exitCode: error.exitCode,
                elapsedMs: error.elapsedMs)
        }
    }
}

/// The production runner: `Foundation.Process` with a SIGKILL deadline.
public struct ProcessCommandRunner: CommandRunner {
    private let nowMs: @Sendable () -> Double

    public init(nowMs: @escaping @Sendable () -> Double = ProcessCommandRunner.systemNowMs) {
        self.nowMs = nowMs
    }

    /// Wall clock in epoch-millis (body uses Foundation; the type does not).
    public static let systemNowMs: @Sendable () -> Double = {
        Date().timeIntervalSince1970 * 1000
    }

    public func run(_ args: [String], options: RunCmdOptions) async throws -> RunCmdResult {
        guard let executable = args.first else {
            throw RunCmdError(message: "runCmd: args must be a non-empty array", kind: .usage)
        }
        let started = nowMs()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = Array(args.dropFirst())
        if let cwd = options.cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        if let env = options.env { process.environment = env }

        let outPipe = configureStdout(process, options.stdout)
        let errPipe = configureStderr(process, options.stderr)
        configureStdin(process, options.stdin)

        do {
            try process.run()
        } catch {
            throw RunCmdError(
                message: "runCmd: cannot spawn \(executable): \(error)", kind: .spawn, args: args)
        }

        async let outText = readCapped(outPipe, maxBytes: options.stdoutMaxBytes)
        async let errText = readCapped(errPipe, maxBytes: options.stderrMaxBytes)
        let timedOut = await raceExitOrDeadline(process, deadlineMs: options.deadlineMs)
        let stdoutText = await outText
        let stderrText = await errText
        let elapsed = Int(nowMs() - started)

        if timedOut {
            throw RunCmdError(
                message: "runCmd: \(executable) exceeded \(options.deadlineMs)ms",
                kind: .timeout, args: args, stderr: stderrText, elapsedMs: elapsed)
        }
        let code = process.terminationStatus
        if code != 0 {
            let snippet = stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
            let brief = snippet.isEmpty ? "<no stderr>" : String(snippet.prefix(512))
            throw RunCmdError(
                message: "runCmd: \(executable) exited \(code): \(brief)", kind: .exit, args: args,
                exitCode: code, stdout: stdoutText, stderr: stderrText, elapsedMs: elapsed)
        }
        return RunCmdResult(
            stdout: stdoutText, stderr: stderrText, exitCode: code, elapsedMs: elapsed)
    }
}

// MARK: - Process plumbing

private func configureStdout(_ process: Process, _ mode: StdioMode) -> Pipe? {
    switch mode {
        case .pipe:
            let pipe = Pipe()
            process.standardOutput = pipe
            return pipe
        case .ignore:
            process.standardOutput = FileHandle.nullDevice
            return nil
        case .inherit:
            return nil
    }
}

private func configureStderr(_ process: Process, _ mode: StdioMode) -> Pipe? {
    switch mode {
        case .pipe:
            let pipe = Pipe()
            process.standardError = pipe
            return pipe
        case .ignore:
            process.standardError = FileHandle.nullDevice
            return nil
        case .inherit:
            return nil
    }
}

private func configureStdin(_ process: Process, _ stdin: String?) {
    guard let stdin else { return }
    let pipe = Pipe()
    process.standardInput = pipe
    let handle = pipe.fileHandleForWriting
    handle.write(Data(stdin.utf8))
    try? handle.close()
}

/// Read a pipe to EOF (or `maxBytes`), off the cooperative pool.
private func readCapped(_ pipe: Pipe?, maxBytes: Int) async -> String {
    guard let pipe else { return "" }
    return await withCheckedContinuation { (continuation: CheckedContinuation<String, Never>) in
        DispatchQueue.global()
            .async {
                let handle = pipe.fileHandleForReading
                var collected = Data()
                while collected.count < maxBytes {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break }
                    collected.append(chunk)
                }
                let capped = collected.count > maxBytes ? collected.prefix(maxBytes) : collected[...]
                continuation.resume(returning: String(decoding: capped, as: UTF8.self))
            }
    }
}

/// Resolve to `true` iff the deadline fired first (and the child was SIGKILLed).
/// The continuation is claimed exactly once by whichever path wins.
private func raceExitOrDeadline(_ process: Process, deadlineMs: Int) async -> Bool {
    let claim = ResumeOnce()
    return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
        DispatchQueue.global()
            .async {
                process.waitUntilExit()
                if claim.tryClaim() { continuation.resume(returning: false) }
            }
        DispatchQueue.global()
            .asyncAfter(deadline: .now() + .milliseconds(max(0, deadlineMs))) {
                if claim.tryClaim() {
                    kill(process.processIdentifier, SIGKILL)
                    continuation.resume(returning: true)
                }
            }
    }
}

/// A one-shot claim guard, so the shared continuation resumes exactly once.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false
    func tryClaim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if claimed { return false }
        claimed = true
        return true
    }
}
