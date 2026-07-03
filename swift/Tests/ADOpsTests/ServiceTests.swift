import Testing

@testable import ADOps

// Unit coverage for `ops service` (ops/cmd/service.js): target resolution, the
// dependency-aware `all` ordering, and the start/stop/status verbs over a fake
// launchctl.

@Test func resolveTargetMapsToLabelAndPlist() {
    let vars = loadedFixtureEnv().vars
    let web = Service.resolveTarget("web", vars: vars)
    #expect(web?.label == "mt.everest.apple-docs.web")
    #expect(web?.plistPath == "/Library/LaunchDaemons/mt.everest.apple-docs.web.plist")
    #expect(Service.resolveTarget("tunnel-mcp", vars: vars)?.label == "mt.everest.apple-docs.cloudflared.mcp")
    #expect(Service.resolveTarget("bogus", vars: vars) == nil)
}

@Test func expandTargetsStartOrderAndReverseStop() {
    #expect(Service.expandTargets("web", verb: .start) == ["web"])
    #expect(
        Service.expandTargets("all", verb: .start)
            == ["web", "mcp", "tunnel-web", "tunnel-mcp", "proxy", "watchdog"])
    #expect(
        Service.expandTargets("all", verb: .stop)
            == ["watchdog", "proxy", "tunnel-mcp", "tunnel-web", "mcp", "web"])
}

@Test func startBootstrapsWhenNotLoaded() async {
    // print exits non-zero (not loaded) → bootstrap.
    let runner = FakeCommandRunner { args in args.contains("print") ? failResult(113) : okResult() }
    let launchctl = Launchctl(runner: runner)
    let code = await Service.run(
        verb: "start", target: "web", env: loadedFixtureEnv(), launchctl: launchctl,
        logger: CapturingLogger())
    #expect(code == 0)
    #expect(runner.calls.contains { $0.contains("bootstrap") })
}

@Test func restartKickstartsWhenLoaded() async {
    // print exits 0 (loaded) → kickstart.
    let runner = FakeCommandRunner { _ in okResult() }
    let launchctl = Launchctl(runner: runner)
    let code = await Service.run(
        verb: "restart", target: "mcp", env: loadedFixtureEnv(), launchctl: launchctl,
        logger: CapturingLogger())
    #expect(code == 0)
    #expect(runner.calls.contains { $0.contains("kickstart") })
}

@Test func stopBootsOut() async {
    let runner = FakeCommandRunner { _ in okResult() }
    let launchctl = Launchctl(runner: runner)
    let code = await Service.run(
        verb: "stop", target: "web", env: loadedFixtureEnv(), launchctl: launchctl,
        logger: CapturingLogger())
    #expect(code == 0)
    #expect(runner.calls.contains { $0.contains("bootout") })
}

@Test func statusSummarizesInterestingLines() async {
    let printOut = "state = running\npid = 4242\nfoo = bar\nlast exit code = 0\n"
    let runner = FakeCommandRunner { args in
        args.contains("print") ? okResult(stdout: printOut) : okResult()
    }
    let launchctl = Launchctl(runner: runner)
    let logger = CapturingLogger()
    let code = await Service.run(
        verb: "status", target: "web", env: loadedFixtureEnv(), launchctl: launchctl,
        logger: logger)
    #expect(code == 0)
    let joined = logger.lines.joined(separator: "\n")
    #expect(joined.contains("state = running"))
    #expect(joined.contains("pid = 4242"))
    #expect(!joined.contains("foo = bar"))  // uninteresting line filtered out
}

@Test func unknownVerbAndTargetAre64() async {
    let launchctl = Launchctl(runner: FakeCommandRunner { _ in okResult() })
    let env = loadedFixtureEnv()
    #expect(
        await Service.run(verb: "frobnicate", target: "web", env: env, launchctl: launchctl, logger: CapturingLogger())
            == 64)
    #expect(
        await Service.run(verb: "start", target: "nope", env: env, launchctl: launchctl, logger: CapturingLogger())
            == 64)
}

@Test func startAllFollowsDependencyOrder() async {
    let runner = FakeCommandRunner { args in args.contains("print") ? failResult(113) : okResult() }
    let launchctl = Launchctl(runner: runner)
    let code = await Service.run(
        verb: "start", target: "all", env: loadedFixtureEnv(), launchctl: launchctl,
        logger: CapturingLogger())
    #expect(code == 0)
    // The six bootstraps land in start order (web first, watchdog last).
    let bootstrapPlists = runner.calls
        .filter { $0.contains("bootstrap") }
        .compactMap { $0.last }
    #expect(bootstrapPlists.first?.contains(".web.plist") ?? false)
    #expect(bootstrapPlists.last?.contains(".watchdog.plist") ?? false)
    #expect(bootstrapPlists.count == 6)
}
