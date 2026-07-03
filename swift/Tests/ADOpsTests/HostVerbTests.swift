import Testing

@testable import ADOps

// Unit coverage for the prepare-only host verbs (install-daemons, pull-snapshot,
// deploy-update). All side effects go through injected seams (FakeCommandRunner /
// FakeGhFetcher / FakeProbe / MemoryFileSystem), so the tests assert the
// privileged/network SEQUENCE + exit codes without executing anything.

private let allPlistLabels = [
    "mt.everest.apple-docs.proxy", "mt.everest.apple-docs.web", "mt.everest.apple-docs.mcp",
    "mt.everest.apple-docs.watchdog", "mt.everest.apple-docs.autoroll",
    "mt.everest.apple-docs.cloudflared.web", "mt.everest.apple-docs.cloudflared.mcp"
]

// MARK: - install-daemons

@Test func installRefusesWhenNotRoot() async {
    let deps = InstallDaemons.Deps(
        fs: MemoryFileSystem(), runner: FakeCommandRunner { _ in okResult() },
        launchctl: Launchctl(runner: FakeCommandRunner { _ in okResult() }),
        http: constantProbe(status: 200), isRoot: { false })
    let code = await InstallDaemons.run(env: loadedFixtureEnv(), deps: deps, logger: CapturingLogger())
    #expect(code == 1)
}

@Test func installIssuesInstallVisudoAndSudoersWhenRoot() async {
    let fs = MemoryFileSystem()
    // Seed the rendered plists so the `install` step fires for each label.
    for label in allPlistLabels {
        fs.seed(file: "/ops/launchd/\(label).plist", Array("plist".utf8))
    }
    fs.seed(file: "/ops/launchd/sudoers.apple-docs-launchctl", Array("sudoers".utf8))
    let runner = FakeCommandRunner { _ in okResult() }
    let deps = InstallDaemons.Deps(
        fs: fs, runner: runner, launchctl: Launchctl(runner: runner),
        http: constantProbe(status: 200), sleep: instantSleep, isRoot: { true })
    let code = await InstallDaemons.run(env: loadedFixtureEnv(), deps: deps, logger: CapturingLogger())
    #expect(code == 0)
    let flat = runner.calls.map { $0.joined(separator: " ") }
    #expect(flat.contains { $0.contains("/usr/bin/id -u everest") })
    #expect(flat.contains { $0.hasPrefix("/usr/bin/install") && $0.contains("-m 644") })
    #expect(flat.contains { $0.hasPrefix("/usr/sbin/visudo -cf") })
    // sudoers stem replaces dots with underscores.
    #expect(flat.contains { $0.contains("/etc/sudoers.d/mt_everest_apple-docs-launchctl") })
}

// MARK: - pull-snapshot

private func releaseJSON(tag: String) -> [UInt8] {
    Array("{\"tag_name\":\"\(tag)\",\"published_at\":\"\",\"assets\":[]}".utf8)
}

@Test func pullSnapshotNoOpWhenAlreadyApplied() async {
    let fs = MemoryFileSystem()
    fs.seed(file: "/ops/state/applied-snapshot", Array("v1.0\n".utf8))
    let runner = FakeCommandRunner { _ in okResult() }
    let deps = PullSnapshot.Deps(
        fetcher: FakeGhFetcher { _ in GhResponse(status: 200, body: releaseJSON(tag: "v1.0")) },
        runner: runner, launchctl: Launchctl(runner: runner), http: constantProbe(status: 200),
        fs: fs, sleep: instantSleep)
    let code = await PullSnapshot.run(
        env: loadedFixtureEnv(), processEnv: [:], force: false, deps: deps, logger: CapturingLogger())
    #expect(code == 0)
    #expect(runner.calls.isEmpty)  // no services touched on a no-op
}

@Test func pullSnapshotAppliesNewReleaseAndStamps() async {
    let fs = MemoryFileSystem()
    fs.seed(file: "/ops/state/applied-snapshot", Array("v0.9\n".utf8))
    let runner = FakeCommandRunner { _ in okResult() }
    let deps = PullSnapshot.Deps(
        fetcher: FakeGhFetcher { _ in GhResponse(status: 200, body: releaseJSON(tag: "v1.0")) },
        runner: runner, launchctl: Launchctl(runner: runner),
        http: FakeProbe { _, _ in (200, "{\"success\":true,\"ok\":true}", .http) },
        fs: fs, sleep: instantSleep)
    let code = await PullSnapshot.run(
        env: loadedFixtureEnv(), processEnv: [:], force: false, deps: deps, logger: CapturingLogger())
    #expect(code == 0)
    let flat = runner.calls.map { $0.joined(separator: " ") }
    #expect(flat.contains { $0.contains("bootout system/mt.everest.apple-docs.web") })
    #expect(flat.contains { $0.contains("setup --force --native") })
    #expect(fs.tryReadText("/ops/state/applied-snapshot") == "v1.0\n")
}

@Test func pullSnapshotSetupFailureRestoresAndReturns2() async {
    let fs = MemoryFileSystem()
    let runner = FakeCommandRunner { args in
        args.contains("setup") ? failResult(1, stderr: "boom") : okResult()
    }
    let deps = PullSnapshot.Deps(
        fetcher: FakeGhFetcher { _ in GhResponse(status: 200, body: releaseJSON(tag: "v2")) },
        runner: runner, launchctl: Launchctl(runner: runner), http: constantProbe(status: 200),
        fs: fs, sleep: instantSleep)
    let code = await PullSnapshot.run(
        env: loadedFixtureEnv(), processEnv: [:], force: false, deps: deps, logger: CapturingLogger())
    #expect(code == 2)
    // Services restored (web bootstrapped) after the setup failure.
    let flat = runner.calls.map { $0.joined(separator: " ") }
    #expect(flat.contains { $0.contains("bootstrap system /Library/LaunchDaemons/mt.everest.apple-docs.web.plist") })
    // No stamp written on failure.
    #expect(fs.tryReadText("/ops/state/applied-snapshot") == nil)
}

// MARK: - deploy-update

@Test func deployUpdateFailsWhenRepoMissing() async {
    let runner = FakeCommandRunner { _ in okResult() }
    let deps = DeployUpdate.Deps(
        fetcher: FakeGhFetcher { _ in GhResponse(status: 200, body: releaseJSON(tag: "v1")) },
        runner: runner, launchctl: Launchctl(runner: runner), http: constantProbe(status: 200),
        fs: MemoryFileSystem(), sleep: instantSleep)
    let code = await DeployUpdate.run(
        env: loadedFixtureEnv(), processEnv: [:], fullRebuild: false, deps: deps,
        logger: CapturingLogger())
    #expect(code == 1)
}

@Test func deployUpdateSnapshotModeDelegatesToPullSnapshot() async {
    let fs = MemoryFileSystem()
    fs.seed(file: "/Users/everest/Developer/apple-docs/cli.js", Array("//".utf8))
    let runner = FakeCommandRunner { _ in okResult() }  // clean tree, ff pull ok
    let deps = DeployUpdate.Deps(
        // A new tag → snapshot mode; pull-snapshot then succeeds and deploy returns 0.
        fetcher: FakeGhFetcher { _ in GhResponse(status: 200, body: releaseJSON(tag: "v9")) },
        runner: runner, launchctl: Launchctl(runner: runner),
        http: FakeProbe { _, _ in (200, "{\"success\":true,\"ok\":true}", .http) },
        fs: fs, sleep: instantSleep)
    let code = await DeployUpdate.run(
        env: loadedFixtureEnv(), processEnv: [:], fullRebuild: false, deps: deps,
        logger: CapturingLogger())
    #expect(code == 0)
    let flat = runner.calls.map { $0.joined(separator: " ") }
    #expect(flat.contains { $0.contains("git") && $0.contains("pull --ff-only") })
    #expect(flat.contains { $0.contains("setup --force --native") })  // via pull-snapshot
}

@Test func deployUpdateForcedCrawlRunsSync() async {
    let fs = MemoryFileSystem()
    fs.seed(file: "/Users/everest/Developer/apple-docs/cli.js", Array("//".utf8))
    let runner = FakeCommandRunner { _ in okResult() }
    let deps = DeployUpdate.Deps(
        fetcher: FakeGhFetcher { _ in GhResponse(status: 200, body: releaseJSON(tag: "v1")) },
        runner: runner, launchctl: Launchctl(runner: runner),
        http: FakeProbe { _, _ in (200, "{\"success\":true,\"ok\":true}", .http) },
        fs: fs, sleep: instantSleep)
    let code = await DeployUpdate.run(
        env: loadedFixtureEnv(), processEnv: ["USE_CRAWL": "1"], fullRebuild: false, deps: deps,
        logger: CapturingLogger())
    #expect(code == 0)
    let flat = runner.calls.map { $0.joined(separator: " ") }
    #expect(flat.contains { $0.contains("cli.js sync") })
}
