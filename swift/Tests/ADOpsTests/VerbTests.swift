import Testing

@testable import ADOps

// Unit coverage for cf-purge, proxy (control verbs), smoke-test, and watch-sync
// over the injected seams (no network / no launchctl / no caddy).

// MARK: - cf-purge

@Test func cfPurgeSoftFailsWithoutCredentials() async {
    let code = await CfPurge.run(
        processEnv: [:], loadedVars: [:], http: constantProbe(status: 200), logger: CapturingLogger())
    #expect(code == 0)
}

@Test func cfPurgeProcessEnvCredentialsWin() async {
    // The purge fires (proc-env creds present) and the API reports success.
    let http = FakeProbe { _, _ in (200, "{\"success\":true}", .http) }
    let code = await CfPurge.run(
        processEnv: ["CLOUDFLARE_API_TOKEN": "tok", "CLOUDFLARE_ZONE_ID": "zone12345"],
        loadedVars: nil, http: http, logger: CapturingLogger())
    #expect(code == 0)
}

@Test func cfPurgeUsesOpsVarsWhenProcessEnvEmpty() async {
    let http = FakeProbe { _, _ in (200, "{\"success\":true}", .http) }
    let code = await CfPurge.run(
        processEnv: [:], loadedVars: ["CLOUDFLARE_API_TOKEN": "t", "CLOUDFLARE_ZONE_ID": "z"],
        http: http, logger: CapturingLogger())
    #expect(code == 0)
}

@Test func cfPurgeFailsOnNonOkResponse() async {
    let code = await CfPurge.run(
        processEnv: ["CLOUDFLARE_API_TOKEN": "t", "CLOUDFLARE_ZONE_ID": "z"], loadedVars: nil,
        http: constantProbe(status: 403, body: "forbidden"), logger: CapturingLogger())
    #expect(code == 1)
}

@Test func cfPurgeFailsOn200ButSuccessFalse() async {
    // Cloudflare returns 200 with success:false on permission failures.
    let http = FakeProbe { _, _ in (200, "{\"success\":false,\"errors\":[]}", .http) }
    let code = await CfPurge.run(
        processEnv: ["CLOUDFLARE_API_TOKEN": "t", "CLOUDFLARE_ZONE_ID": "z"], loadedVars: nil,
        http: http, logger: CapturingLogger())
    #expect(code == 1)
}

@Test func cfPurgeSuccessBodyParsing() {
    #expect(CfPurge.cloudflareReportedSuccess("{\"success\":true}"))
    #expect(!CfPurge.cloudflareReportedSuccess("{\"success\":false}"))
    #expect(!CfPurge.cloudflareReportedSuccess("not json"))
}

// MARK: - proxy

private func proxyFS(withConfig: Bool, caddyPresent: Bool) -> MemoryFileSystem {
    let fs = MemoryFileSystem()
    if withConfig { fs.seed(file: "/ops/caddy/Caddyfile", Array("caddy config".utf8)) }
    if caddyPresent { fs.seed(file: "/opt/homebrew/bin/caddy", Array("bin".utf8)) }
    return fs
}

private func proxyDeps(
    _ fs: MemoryFileSystem, _ runner: FakeCommandRunner, _ http: FakeProbe
) -> Proxy.Deps {
    Proxy.Deps(fs: fs, runner: runner, http: http)
}

@Test func proxyValidateSucceeds() async {
    let fs = proxyFS(withConfig: true, caddyPresent: true)
    let runner = FakeCommandRunner { _ in okResult(stdout: "valid") }
    let code = await Proxy.runControl(
        verb: "validate", env: loadedFixtureEnv(), processEnv: [:],
        deps: proxyDeps(fs, runner, constantProbe(status: 200)), logger: CapturingLogger())
    #expect(code == 0)
    #expect(runner.calls.first?.contains("validate") ?? false)
}

@Test func proxyMissingConfigIs66() async {
    let fs = proxyFS(withConfig: false, caddyPresent: true)
    let code = await Proxy.runControl(
        verb: "validate", env: loadedFixtureEnv(), processEnv: [:],
        deps: proxyDeps(fs, FakeCommandRunner { _ in okResult() }, constantProbe(status: 200)),
        logger: CapturingLogger())
    #expect(code == 66)
}

@Test func proxyMissingCaddyIs127() async {
    let fs = proxyFS(withConfig: true, caddyPresent: false)
    let code = await Proxy.runControl(
        verb: "validate", env: loadedFixtureEnv(), processEnv: [:],
        deps: proxyDeps(fs, FakeCommandRunner { _ in okResult() }, constantProbe(status: 200)),
        logger: CapturingLogger())
    #expect(code == 127)
}

@Test func proxyStatusOkAndFail() async {
    let fs = proxyFS(withConfig: true, caddyPresent: true)
    let runner = FakeCommandRunner { _ in okResult() }
    let okCode = await Proxy.runControl(
        verb: "status", env: loadedFixtureEnv(), processEnv: [:],
        deps: proxyDeps(fs, runner, constantProbe(status: 200, body: "{}")),
        logger: CapturingLogger())
    #expect(okCode == 0)
    let failCode = await Proxy.runControl(
        verb: "status", env: loadedFixtureEnv(), processEnv: [:],
        deps: proxyDeps(fs, runner, constantProbe(status: nil, outcome: .network)),
        logger: CapturingLogger())
    #expect(failCode == 1)
}

@Test func proxyReloadValidatesFirst() async {
    let fs = proxyFS(withConfig: true, caddyPresent: true)
    // validate fails (exit 1) → reload never runs.
    let runner = FakeCommandRunner { args in args.contains("validate") ? failResult(1) : okResult() }
    let code = await Proxy.runControl(
        verb: "reload", env: loadedFixtureEnv(), processEnv: [:],
        deps: proxyDeps(fs, runner, constantProbe(status: 200)), logger: CapturingLogger())
    #expect(code == 1)
    #expect(!runner.calls.contains { $0.contains("reload") })
}

// MARK: - smoke-test

/// A tiny burst env keeps the concurrency probe fast.
private func smokeEnv() -> LoadedEnv {
    var vars = loadedFixtureEnv().vars
    vars["SMOKE_BURST_SIZE"] = "2"
    vars["SMOKE_HEALTHZ_SAMPLES"] = "2"
    vars["SMOKE_READY_TIMEOUT_MS"] = "10"
    vars["SMOKE_READY_POLL_MS"] = "5"
    return OpsEnv.finalize(vars: vars, opsDir: "/ops")
}

@Test func smokeAllHealthyPasses() async {
    let deps = SmokeDeps(http: constantProbe(status: 200, body: "{\"ok\":true}"), sleep: instantSleep, nowMs: { 0 })
    let code = await SmokeTest.run(env: smokeEnv(), deps: deps, logger: CapturingLogger())
    #expect(code == 0)
}

@Test func smokeFailsWhenEndpointsDown() async {
    let deps = SmokeDeps(http: constantProbe(status: 503), sleep: instantSleep, nowMs: { 0 })
    let code = await SmokeTest.run(env: smokeEnv(), deps: deps, logger: CapturingLogger())
    #expect(code == 1)
}

// MARK: - watch-sync

private func watchSyncEnv() -> LoadedEnv { loadedFixtureEnv() }

@Test func watchSyncRejectsBadPid() async {
    let deps = WatchSyncDeps(
        launchctl: Launchctl(runner: FakeCommandRunner { _ in okResult() }),
        http: constantProbe(status: 200), runSmoke: { _ in 0 }, isAlive: { _ in false },
        sleep: instantSleep)
    let code = await WatchSync.run(env: watchSyncEnv(), syncPid: 0, deps: deps, logger: CapturingLogger())
    #expect(code == 64)
}

@Test func watchSyncHappyPathBootstrapsAndKickstarts() async {
    let runner = FakeCommandRunner { _ in okResult() }
    let deps = WatchSyncDeps(
        launchctl: Launchctl(runner: runner), http: constantProbe(status: 200),
        runSmoke: { _ in 0 }, isAlive: { _ in false }, sleep: instantSleep)
    let code = await WatchSync.run(env: watchSyncEnv(), syncPid: 4242, deps: deps, logger: CapturingLogger())
    #expect(code == 0)
    // web bootstrap + web kickstart + mcp kickstart all issued.
    #expect(runner.calls.contains { $0.contains("bootstrap") })
    #expect(runner.calls.contains { $0.contains("kickstart") && $0.last!.contains(".web") })
    #expect(runner.calls.contains { $0.contains("kickstart") && $0.last!.contains(".mcp") })
}
