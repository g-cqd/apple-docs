import Testing

@testable import ADOps

// Unit coverage for the launchctl wrapper (ops/lib/launchctl.js): the argv shape
// the sudoers allowlist matches, and the bootstrap→EEXIST→kickstart fallback.

@Test func isLoadedTrueWhenPrintExitsZero() async throws {
    let runner = FakeCommandRunner { _ in okResult() }
    let launchctl = Launchctl(runner: runner)
    #expect(try await launchctl.isLoaded("mt.everest.apple-docs.web"))
    #expect(
        runner.calls == [
            ["/usr/bin/sudo", "-n", "/bin/launchctl", "print", "system/mt.everest.apple-docs.web"]
        ])
}

@Test func isLoadedFalseWhenPrintExitsNonZero() async throws {
    let runner = FakeCommandRunner { _ in failResult(113) }
    let launchctl = Launchctl(runner: runner)
    #expect(try await launchctl.isLoaded("x") == false)
}

@Test func bootstrapSucceedsWhenNotLoaded() async throws {
    let runner = FakeCommandRunner { _ in okResult() }
    let launchctl = Launchctl(runner: runner)
    let outcome = try await launchctl.bootstrapOrKick("lbl", plistPath: "/Library/LaunchDaemons/lbl.plist")
    #expect(outcome == .bootstrapped)
    #expect(runner.calls.count == 1)
    #expect(runner.calls[0].contains("bootstrap"))
}

@Test func bootstrapFallsBackToKickstartOnEEXIST() async throws {
    // bootstrap fails (already loaded) → kickstart -k.
    let runner = FakeCommandRunner { args in
        args.contains("bootstrap") ? failResult(1, stderr: "Bootstrap failed: 17: File exists") : okResult()
    }
    let launchctl = Launchctl(runner: runner)
    let outcome = try await launchctl.bootstrapOrKick("lbl", plistPath: "/Library/LaunchDaemons/lbl.plist")
    #expect(outcome == .kickstarted)
    #expect(runner.calls.count == 2)
    #expect(runner.calls[0].contains("bootstrap"))
    #expect(
        runner.calls[1]
            == ["/usr/bin/sudo", "-n", "/bin/launchctl", "kickstart", "-k", "system/lbl"])
}

@Test func bootoutTolerated() async throws {
    let runner = FakeCommandRunner { _ in failResult(3) }  // not loaded — tolerated
    let launchctl = Launchctl(runner: runner)
    let result = try await launchctl.bootout("lbl")
    #expect(result.exitCode == 3)
    #expect(runner.calls[0] == ["/usr/bin/sudo", "-n", "/bin/launchctl", "bootout", "system/lbl"])
}

@Test func stopOneSkipsWhenNotLoaded() async throws {
    // print exits non-zero (not loaded) → no bootout issued.
    let runner = FakeCommandRunner { _ in failResult(113) }
    let launchctl = Launchctl(runner: runner)
    let logger = CapturingLogger()
    let outcome = try await launchctl.stopOne("lbl", logger: logger)
    #expect(outcome == .alreadyStopped)
    #expect(runner.calls.count == 1)  // only the isLoaded print
    #expect(logger.lines.contains { $0.contains("not loaded") })
}

@Test func stopOneBootsOutWhenLoaded() async throws {
    let runner = FakeCommandRunner { _ in okResult() }  // print 0 = loaded; bootout 0
    let launchctl = Launchctl(runner: runner)
    let outcome = try await launchctl.stopOne("lbl", logger: CapturingLogger())
    #expect(outcome == .stopped)
    #expect(runner.calls.count == 2)
    #expect(runner.calls[1].contains("bootout"))
}

@Test func startOneThrowsWhenPlistMissing() async {
    let runner = FakeCommandRunner { _ in okResult() }
    let launchctl = Launchctl(runner: runner)
    let fs = MemoryFileSystem()  // plist absent
    await #expect(throws: OpsIOError.self) {
        try await launchctl.startOne(
            "lbl", plistPath: "/Library/LaunchDaemons/lbl.plist", fs: fs, logger: CapturingLogger())
    }
}
