// `ops watchdog` — the long-running guardrail. Native port of ops/cmd/watchdog.js.
//
// Defends against four failure modes launchd KeepAlive can't catch: event-loop
// wedge (readyz on the backend port fails N times → kickstart), slow
// accumulation (optional daily kickstart), RSS runaway (backstop cap), and
// operator absence (unattended with a cooldown to avoid restart storms). The
// cooldown stamp is written BEFORE the kickstart so a watchdog killed mid-restart
// doesn't double-blip. Every seam (clock/sleep/probe/ps/kickstart/fs) is
// injected; `maxIterations` bounds the loop for tests.

private import Foundation

#if canImport(FoundationNetworking)
    private import FoundationNetworking  // URLSession/URLRequest live here on Linux (the Foundation split)
#endif

/// The two supervised backends.
private struct Backend {
    let name: String
    let label: String
    let url: String
    let rssCapMb: Int
    let psPattern: String
}

/// Injected seams for the watchdog loop.
public struct WatchdogDeps: Sendable {
    public var now: @Sendable () -> Double
    public var sleep: @Sendable (Int) async -> Void
    /// `(url, timeoutMs) -> (healthy, status)`. Healthy = 2xx AND `"ok":true`.
    public var probeReadyz: @Sendable (String, Int) async -> (ok: Bool, status: Int)
    /// `(psPattern) -> (rssMb, pidCount)`.
    public var psLookup: @Sendable (String) async -> (rssMb: Int, pidCount: Int)
    public var kickstart: @Sendable (String) async -> Void
    public var fs: any OpsFileSystem
    public var maxIterations: Int

    public init(
        fs: any OpsFileSystem,
        probeReadyz: @escaping @Sendable (String, Int) async -> (ok: Bool, status: Int),
        psLookup: @escaping @Sendable (String) async -> (rssMb: Int, pidCount: Int),
        kickstart: @escaping @Sendable (String) async -> Void,
        now: @escaping @Sendable () -> Double = ProcessCommandRunner.systemNowMs,
        sleep: @escaping @Sendable (Int) async -> Void = SmokeDeps.systemSleep,
        maxIterations: Int = Int.max
    ) {
        self.fs = fs
        self.probeReadyz = probeReadyz
        self.psLookup = psLookup
        self.kickstart = kickstart
        self.now = now
        self.sleep = sleep
        self.maxIterations = maxIterations
    }
}

/// Watchdog config parsed from the process env (all knobs optional).
public struct WatchdogConfig: Sendable, Equatable {
    public var intervalMs: Int
    public var failsBudget: Int
    public var probeTimeoutMs: Int
    public var cooldownMs: Int
    public var webRssCapMb: Int
    public var mcpRssCapMb: Int
    public var dailyHour: Int?
    public var dailyTargets: [String]

    /// Parse the WATCHDOG_* knobs (defaults mirror watchdog.js).
    public static func from(_ env: [String: String]) -> WatchdogConfig {
        WatchdogConfig(
            intervalMs: intEnv(env["WATCHDOG_INTERVAL"], 30) * 1000,
            failsBudget: intEnv(env["WATCHDOG_FAILS"], 3),
            probeTimeoutMs: intEnv(env["WATCHDOG_TIMEOUT"], 5) * 1000,
            cooldownMs: intEnv(env["WATCHDOG_COOLDOWN"], 300) * 1000,
            webRssCapMb: intEnv(env["WATCHDOG_WEB_RSS_LIMIT_MB"], 3072),
            mcpRssCapMb: intEnv(env["WATCHDOG_MCP_RSS_LIMIT_MB"], 8192),
            dailyHour: env["WATCHDOG_DAILY_RESTART_HOUR"].flatMap { Int($0) },
            dailyTargets: (env["WATCHDOG_DAILY_RESTART_TARGETS"] ?? "web")
                .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty })
    }
}

public enum Watchdog {
    public static func run(
        env: LoadedEnv, processEnv: [String: String], deps: WatchdogDeps, logger: any OpsLogging
    ) async -> Int32 {
        let cfg = WatchdogConfig.from(processEnv)
        let backends = [
            Backend(
                name: "web", label: env.labels.web,
                url: "http://127.0.0.1:\(env.vars["WEB_BACKEND_PORT"] ?? "")/readyz",
                rssCapMb: cfg.webRssCapMb, psPattern: "\(env.repoDir)/cli.js web serve"),
            Backend(
                name: "mcp", label: env.labels.mcp,
                url: "http://127.0.0.1:\(env.vars["MCP_BACKEND_PORT"] ?? "")/readyz",
                rssCapMb: cfg.mcpRssCapMb, psPattern: "\(env.repoDir)/cli.js mcp serve")
        ]
        let stateDir = "\(env.opsDir)/logs/.watchdog"
        try? deps.fs.ensureDir(stateDir)

        logger.say(
            "watchdog starting (interval=\(cfg.intervalMs / 1000)s, fails=\(cfg.failsBudget), "
                + "timeout=\(cfg.probeTimeoutMs / 1000)s, cooldown=\(cfg.cooldownMs / 1000)s, "
                + "daily_hour=\(cfg.dailyHour.map(String.init) ?? "off"))")

        var fails: [String: Int] = ["web": 0, "mcp": 0]
        var iterations = 0
        while iterations < deps.maxIterations {
            iterations += 1
            for backend in backends {
                await probeOne(backend, cfg: cfg, stateDir: stateDir, fails: &fails, deps: deps, logger: logger)
                await checkRss(backend, cfg: cfg, stateDir: stateDir, deps: deps, logger: logger)
            }
            if cfg.dailyHour != nil {
                await dailyRestartCheck(backends, cfg: cfg, stateDir: stateDir, deps: deps, logger: logger)
            }
            if iterations >= deps.maxIterations { break }
            await deps.sleep(cfg.intervalMs)
        }
        logger.say("watchdog stopping")
        return 0
    }

    private static func probeOne(
        _ backend: Backend, cfg: WatchdogConfig, stateDir: String, fails: inout [String: Int],
        deps: WatchdogDeps, logger: any OpsLogging
    ) async {
        let result = await deps.probeReadyz(backend.url, cfg.probeTimeoutMs)
        if result.ok {
            fails[backend.name] = 0
            return
        }
        let count = (fails[backend.name] ?? 0) + 1
        fails[backend.name] = count
        logger.say(
            "\(backend.name) healthz probe failed (HTTP \(result.status), fail \(count)/\(cfg.failsBudget))")
        if count >= cfg.failsBudget {
            let fired = await maybeKickstart(
                (backend.name, backend.label),
                reason: "\(count) consecutive /readyz failures (last status \(result.status))",
                cfg: cfg, stateDir: stateDir, deps: deps, logger: logger)
            if fired { fails[backend.name] = 0 }
        }
    }

    private static func checkRss(
        _ backend: Backend, cfg: WatchdogConfig, stateDir: String, deps: WatchdogDeps,
        logger: any OpsLogging
    ) async {
        guard backend.rssCapMb > 0 else { return }
        let info = await deps.psLookup(backend.psPattern)
        if info.pidCount == 0 { return }
        if info.pidCount > 1 {
            logger.warn("\(backend.name) RSS check skipped — \(info.pidCount) pids match '\(backend.psPattern)'")
            return
        }
        if info.rssMb > backend.rssCapMb {
            _ = await maybeKickstart(
                (backend.name, backend.label),
                reason: "RSS \(info.rssMb)MB > \(backend.rssCapMb)MB cap", cfg: cfg,
                stateDir: stateDir, deps: deps, logger: logger)
        }
    }

    private static func dailyRestartCheck(
        _ backends: [Backend], cfg: WatchdogConfig, stateDir: String, deps: WatchdogDeps,
        logger: any OpsLogging
    ) async {
        let date = Date(timeIntervalSince1970: deps.now() / 1000)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let parts = calendar.dateComponents([.year, .month, .day, .hour], from: date)
        guard parts.hour == cfg.dailyHour else { return }
        let today = String(
            format: "%04d%02d%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        let stamp = "\(stateDir)/daily_\(today).done"
        if deps.fs.exists(stamp) { return }

        var didRestart = false
        for target in cfg.dailyTargets {
            guard target.allSatisfy({ $0.isLowercase && $0.isLetter }) else {
                logger.warn("skipping malformed target '\(target)'")
                continue
            }
            guard let backend = backends.first(where: { $0.name == target }) else {
                logger.warn("WATCHDOG_DAILY_RESTART_TARGETS includes unknown target '\(target)' — skipping")
                continue
            }
            let fired = await maybeKickstart(
                (target, backend.label),
                reason: "daily preventive restart (hour \(cfg.dailyHour ?? -1))", cfg: cfg,
                stateDir: stateDir, deps: deps, logger: logger)
            if fired { didRestart = true }
        }
        if didRestart { try? deps.fs.writeAtomic(stamp, []) }
    }

    private static func maybeKickstart(
        _ service: (name: String, label: String), reason: String, cfg: WatchdogConfig,
        stateDir: String, deps: WatchdogDeps, logger: any OpsLogging
    ) async -> Bool {
        let (name, label) = service
        let lastFile = "\(stateDir)/\(name).last_restart"
        let last = readInt(deps.fs, lastFile)
        let nowMs = deps.now()
        if nowMs - Double(last) < Double(cfg.cooldownMs) {
            let remaining = Int((Double(cfg.cooldownMs) - (nowMs - Double(last))) / 1000) + 1
            logger.say("skip \(name) kickstart (cooldown \(remaining)s remaining): \(reason)")
            return false
        }
        logger.say("kickstart \(name) (\(label)): \(reason)")
        // Stamp BEFORE the call (see the file-level note).
        try? deps.fs.writeAtomic(lastFile, Array(String(Int(nowMs)).utf8))
        await deps.kickstart(label)
        return true
    }
}

// MARK: - default live seams

extension WatchdogDeps {
    /// The live readyz probe: 2xx AND a `"ok":true` somewhere in the JSON body.
    public static let systemProbeReadyz: @Sendable (String, Int) async -> (ok: Bool, status: Int) = { url, timeoutMs in
        let result = await URLSessionProbe().probe(url, options: ProbeOptions(deadlineMs: timeoutMs))
        let status = result.status ?? 0
        let ok = status >= 200 && status < 300 && bodyReportsOk(result.body)
        return (ok, status)
    }

    /// The live `pgrep -f` + `ps -o rss=` lookup over a CommandRunner.
    public static func systemPsLookup(_ runner: any CommandRunner)
        -> @Sendable (String) async -> (
            rssMb: Int, pidCount: Int
        )
    {
        { pattern in
            let pgrep = try? await runner.runAllowFailure(
                ["/usr/bin/pgrep", "-f", pattern], options: RunCmdOptions(deadlineMs: 5_000))
            let pids = (pgrep?.stdout ?? "").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            if pids.isEmpty { return (0, 0) }
            if pids.count > 1 { return (0, pids.count) }
            let ps = try? await runner.runAllowFailure(
                ["/bin/ps", "-o", "rss=", "-p", pids[0]], options: RunCmdOptions(deadlineMs: 5_000))
            let rssKb = Int((ps?.stdout ?? "").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
            return (rssKb / 1024, 1)
        }
    }

    /// The live `sudo -n launchctl kickstart -k` over a CommandRunner.
    public static func systemKickstart(_ runner: any CommandRunner) -> @Sendable (String) async -> Void {
        { label in
            _ = try? await runner.runAllowFailure(
                ["/usr/bin/sudo", "-n", "/bin/launchctl", "kickstart", "-k", "system/\(label)"],
                options: RunCmdOptions(deadlineMs: 15_000))
        }
    }
}

// MARK: - helpers

private func intEnv(_ value: String?, _ fallback: Int) -> Int {
    guard let value, let parsed = Int(value.trimmingCharacters(in: .whitespaces)) else {
        return fallback
    }
    return parsed
}

private func readInt(_ fs: any OpsFileSystem, _ path: String) -> Int {
    guard let text = fs.tryReadText(path)?.trimmingCharacters(in: .whitespacesAndNewlines),
        let value = Int(text)
    else { return 0 }
    return value
}

/// A `"ok"\s*:\s*true` match anywhere in the body (guards against a squatting 200).
func bodyReportsOk(_ body: String) -> Bool {
    guard
        let regex = try? NSRegularExpression(pattern: "\"ok\"\\s*:\\s*true", options: [])
    else { return false }
    return regex.firstMatch(in: body, range: NSRange(body.startIndex..., in: body)) != nil
}
