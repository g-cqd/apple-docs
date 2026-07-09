// A small, self-contained subprocess runner for the SF Symbols codepoint stamper's
// tool calls (`swiftc` to build the helper dylib; `hdiutil`/`pkgutil` when provisioning
// a downloaded .app). Modeled on ADStorage/FontSync.swift's `runTool` + `PipeDrain` and
// ADRender/HbViewRenderer's drain-then-deadline shape: both pipes drain on background
// queues so output larger than a pipe buffer can never wedge the child, and the child
// is SIGKILLed past the deadline so an OS-level hang can't stall the stamp. Returns an
// outcome (never throws) so every callsite degrades gracefully on a non-zero exit.

import Foundation

#if canImport(Darwin)
    import Darwin  // kill, SIGKILL
#else
    import Glibc
#endif

/// The result of a bounded subprocess run: exit status (-1 on spawn failure / timeout) + captured
/// output. `status == 0` means a clean exit.
struct SfSymbolProcessOutcome {
    let status: Int32
    let stdout: String
    let stderr: String
}

/// Run `executable args…`, draining both pipes on background queues, and SIGKILL past `deadlineMs`.
/// Never throws: a spawn failure or timeout yields `status = -1` with the reason on `stderr`.
func runProcess(_ executable: String, _ args: [String], deadlineMs: Int) -> SfSymbolProcessOutcome {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = args
    let outPipe = Pipe()
    let errPipe = Pipe()
    process.standardOutput = outPipe
    process.standardError = errPipe
    let exited = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in exited.signal() }
    do {
        try process.run()
    } catch {
        return SfSymbolProcessOutcome(
            status: -1, stdout: "", stderr: "cannot spawn \(executable): \(error.localizedDescription)")
    }
    let stdout = CodepointPipeDrain(outPipe)
    let stderr = CodepointPipeDrain(errPipe)
    if exited.wait(timeout: .now() + .milliseconds(deadlineMs)) == .timedOut {
        kill(process.processIdentifier, SIGKILL)
        _ = stdout.wait(ms: 1_000)
        _ = stderr.wait(ms: 1_000)
        return SfSymbolProcessOutcome(
            status: -1, stdout: stdout.string, stderr: "\(executable) timed out after \(deadlineMs / 1_000)s")
    }
    _ = stdout.wait(ms: 5_000)
    _ = stderr.wait(ms: 5_000)
    return SfSymbolProcessOutcome(
        status: process.terminationStatus, stdout: stdout.string, stderr: stderr.string)
}

/// Drains one pipe to EOF on a background queue, then `wait` establishes the happens-before edge for
/// reading `string` (the `FontSync.PipeDrain` pattern; named apart so it never clashes with it).
private final class CodepointPipeDrain: @unchecked Sendable {
    private var data = Data()
    private let drained = DispatchGroup()

    init(_ pipe: Pipe) {
        drained.enter()
        DispatchQueue.global(qos: .utility)
            .async {
                self.data = pipe.fileHandleForReading.readDataToEndOfFile()
                self.drained.leave()
            }
    }

    @discardableResult
    func wait(ms: Int) -> Bool { drained.wait(timeout: .now() + .milliseconds(ms)) == .success }

    var string: String { String(decoding: data, as: UTF8.self) }
}
