import Testing

@testable import ADOps

// Unit coverage for the subprocess wrapper (ops/lib/run-cmd.js) over the real
// Process runner: stdout capture, non-zero-exit throwing vs runAllowFailure,
// stdin feeding, and the SIGKILL deadline.

private let runner = ProcessCommandRunner()

@Test func capturesStdoutAndZeroExit() async throws {
    let result = try await runner.run(["/bin/echo", "hello ops"])
    #expect(result.stdout == "hello ops\n")
    #expect(result.exitCode == 0)
}

@Test func nonZeroExitThrows() async {
    let error = await #expect(throws: RunCmdError.self) {
        try await runner.run(["/usr/bin/false"])
    }
    #expect(error?.kind == .exit)
    #expect(error?.exitCode == 1)
}

@Test func runAllowFailureReturnsNonZeroAsValue() async throws {
    let result = try await runner.runAllowFailure(["/usr/bin/false"], options: RunCmdOptions())
    #expect(result.exitCode == 1)
}

@Test func emptyArgsIsUsageError() async {
    let error = await #expect(throws: RunCmdError.self) { try await runner.run([]) }
    #expect(error?.kind == .usage)
}

@Test func feedsStdin() async throws {
    let result = try await runner.run(
        ["/bin/cat"], options: RunCmdOptions(stdin: "piped-input"))
    #expect(result.stdout == "piped-input")
}

@Test func deadlineSigkillsAndThrowsTimeout() async {
    // sleep 10s under a 250ms deadline → SIGKILL + timeout error, fast.
    let error = await #expect(throws: RunCmdError.self) {
        try await runner.run(["/bin/sleep", "10"], options: RunCmdOptions(deadlineMs: 250))
    }
    #expect(error?.kind == .timeout)
}

@Test func spawnErrorForMissingBinary() async {
    let error = await #expect(throws: RunCmdError.self) {
        try await runner.run(["/nonexistent/binary/xyz"])
    }
    #expect(error?.kind == .spawn)
}
