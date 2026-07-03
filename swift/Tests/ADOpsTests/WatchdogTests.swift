import Foundation
import Testing

@testable import ADOps

// Unit coverage for the watchdog loop (ops/cmd/watchdog.js): config parsing, the
// consecutive-failure kickstart, the cooldown suppression, the RSS backstop, and
// the daily preventive restart — all over injected clock/probe/ps/kickstart/fs
// seams with a bounded iteration count.

@Test func watchdogConfigParsesKnobs() {
    let cfg = WatchdogConfig.from([
        "WATCHDOG_INTERVAL": "10", "WATCHDOG_FAILS": "5", "WATCHDOG_COOLDOWN": "60",
        "WATCHDOG_DAILY_RESTART_HOUR": "4", "WATCHDOG_DAILY_RESTART_TARGETS": "web,mcp"
    ])
    #expect(cfg.intervalMs == 10_000)
    #expect(cfg.failsBudget == 5)
    #expect(cfg.cooldownMs == 60_000)
    #expect(cfg.dailyHour == 4)
    #expect(cfg.dailyTargets == ["web", "mcp"])
}

@Test func watchdogConfigDefaults() {
    let cfg = WatchdogConfig.from([:])
    #expect(cfg.intervalMs == 30_000)
    #expect(cfg.failsBudget == 3)
    #expect(cfg.webRssCapMb == 3072)
    #expect(cfg.dailyHour == nil)
    #expect(cfg.dailyTargets == ["web"])
}

@Test func watchdogKickstartsAfterConsecutiveFailures() async {
    let fired = StringRecorder()
    let deps = WatchdogDeps(
        fs: MemoryFileSystem(),
        probeReadyz: { _, _ in (false, 503) },  // always failing
        psLookup: { _ in (0, 0) },  // skip RSS
        kickstart: { label in fired.record(label) },
        now: { 1_000_000_000 }, sleep: instantSleep, maxIterations: 3)
    let code = await Watchdog.run(
        env: loadedFixtureEnv(), processEnv: ["WATCHDOG_FAILS": "2"], deps: deps,
        logger: CapturingLogger())
    #expect(code == 0)
    // web + mcp each fire once (budget 2, first-fire has no cooldown stamp).
    #expect(fired.all.contains("mt.everest.apple-docs.web"))
    #expect(fired.all.contains("mt.everest.apple-docs.mcp"))
}

@Test func watchdogHealthyNeverKickstarts() async {
    let fired = StringRecorder()
    let deps = WatchdogDeps(
        fs: MemoryFileSystem(),
        probeReadyz: { _, _ in (true, 200) },
        psLookup: { _ in (0, 0) },
        kickstart: { label in fired.record(label) },
        now: { 1_000_000_000 }, sleep: instantSleep, maxIterations: 5)
    _ = await Watchdog.run(env: loadedFixtureEnv(), processEnv: [:], deps: deps, logger: CapturingLogger())
    #expect(fired.all.isEmpty)
}

@Test func watchdogRssBackstopFires() async {
    let fired = StringRecorder()
    let deps = WatchdogDeps(
        fs: MemoryFileSystem(),
        probeReadyz: { _, _ in (true, 200) },  // healthy readyz
        psLookup: { _ in (9000, 1) },  // 9 GB, single pid
        kickstart: { label in fired.record(label) },
        now: { 1_000_000_000 }, sleep: instantSleep, maxIterations: 1)
    _ = await Watchdog.run(
        env: loadedFixtureEnv(),
        processEnv: ["WATCHDOG_WEB_RSS_LIMIT_MB": "3072", "WATCHDOG_MCP_RSS_LIMIT_MB": "8192"],
        deps: deps, logger: CapturingLogger())
    // Both backends exceed their caps → both kickstart.
    #expect(fired.all.contains("mt.everest.apple-docs.web"))
    #expect(fired.all.contains("mt.everest.apple-docs.mcp"))
}

@Test func watchdogRssSkippedWhenMultiplePids() async {
    let fired = StringRecorder()
    let deps = WatchdogDeps(
        fs: MemoryFileSystem(),
        probeReadyz: { _, _ in (true, 200) },
        psLookup: { _ in (9000, 2) },  // ambiguous during a kickstart race
        kickstart: { label in fired.record(label) },
        now: { 1_000_000_000 }, sleep: instantSleep, maxIterations: 1)
    _ = await Watchdog.run(env: loadedFixtureEnv(), processEnv: [:], deps: deps, logger: CapturingLogger())
    #expect(fired.all.isEmpty)
}

@Test func watchdogCooldownSuppressesRepeatKickstart() async {
    let fired = StringRecorder()
    let fs = MemoryFileSystem()
    // A very recent last_restart stamp for web → within the 300s cooldown.
    fs.seed(file: "/ops/logs/.watchdog/web.last_restart", Array("1000000000".utf8))
    let deps = WatchdogDeps(
        fs: fs,
        probeReadyz: { url, _ in (!url.contains("\(3130)"), url.contains("\(3130)") ? 503 : 200) },
        psLookup: { _ in (0, 0) },
        kickstart: { label in fired.record(label) },
        now: { 1_000_000_000 }, sleep: instantSleep, maxIterations: 5)
    _ = await Watchdog.run(
        env: loadedFixtureEnv(), processEnv: ["WATCHDOG_FAILS": "1"], deps: deps,
        logger: CapturingLogger())
    // web is within cooldown → never fires despite failing.
    #expect(!fired.all.contains("mt.everest.apple-docs.web"))
}

@Test func watchdogDailyRestartFires() async {
    let fired = StringRecorder()
    let hour = Calendar.current.component(.hour, from: Date())
    let deps = WatchdogDeps(
        fs: MemoryFileSystem(),
        probeReadyz: { _, _ in (true, 200) },  // healthy: no probe-triggered kickstart
        psLookup: { _ in (0, 0) },
        kickstart: { label in fired.record(label) },
        now: { Date().timeIntervalSince1970 * 1000 }, sleep: instantSleep, maxIterations: 1)
    _ = await Watchdog.run(
        env: loadedFixtureEnv(), processEnv: ["WATCHDOG_DAILY_RESTART_HOUR": String(hour)],
        deps: deps, logger: CapturingLogger())
    #expect(fired.all == ["mt.everest.apple-docs.web"])  // default daily target
}

@Test func bodyReportsOkMatch() {
    #expect(bodyReportsOk("{\"ok\": true}"))
    #expect(bodyReportsOk("{\"status\":\"up\",\"ok\":true}"))
    #expect(!bodyReportsOk("{\"ok\": false}"))
    #expect(!bodyReportsOk("generic 200 page"))
}
