// `ops watch-sync` — first-boot helper: wait for an in-progress `apple-docs sync`
// to finish (poll `kill -0 <SYNC_PID>`), then bootstrap + kickstart web/mcp
// against the fresh corpus and smoke-test. Native port of ops/cmd/watch-sync.js.

private import Foundation

/// Injected seams for watch-sync.
public struct WatchSyncDeps: Sendable {
    /// Returns whether the pid is still alive (`kill(pid, 0)` succeeded).
    public var isAlive: @Sendable (Int32) -> Bool
    public var sleep: @Sendable (Int) async -> Void
    public var launchctl: Launchctl
    public var http: any HTTPProbing
    /// Runs the smoke battery for the env (informational; never gates).
    public var runSmoke: @Sendable (LoadedEnv) async -> Int32

    public init(
        launchctl: Launchctl,
        http: any HTTPProbing,
        runSmoke: @escaping @Sendable (LoadedEnv) async -> Int32,
        isAlive: @escaping @Sendable (Int32) -> Bool = WatchSyncDeps.systemIsAlive,
        sleep: @escaping @Sendable (Int) async -> Void = SmokeDeps.systemSleep
    ) {
        self.launchctl = launchctl
        self.http = http
        self.runSmoke = runSmoke
        self.isAlive = isAlive
        self.sleep = sleep
    }

    /// `kill(pid, 0) == 0` — the process exists (or is a zombie we can signal).
    public static let systemIsAlive: @Sendable (Int32) -> Bool = { pid in
        kill(pid, 0) == 0
    }
}

public enum WatchSync {
    /// Wait for `syncPid` (the detached `apple-docs sync`) to exit, then
    /// bootstrap + kickstart web/mcp and smoke-test. Returns the process exit
    /// code — 64 for a bad pid; 1 if web can't kickstart; else 0.
    public static func run(
        env: LoadedEnv, syncPid: Int32, deps: WatchSyncDeps, logger: any OpsLogging
    ) async -> Int32 {
        guard syncPid > 0 else {
            logger.error("watch-sync: set SYNC_PID=<pid of apple-docs sync> before invoking")
            return 64
        }

        logger.say("watcher started, waiting for PID \(syncPid)")
        while deps.isAlive(syncPid) {
            await deps.sleep(15_000)
        }
        logger.say("sync process exited")

        let labels = env.labels
        do {
            _ = try await deps.launchctl.bootstrapOrKick(
                labels.web, plistPath: plistPath(labels.web))
        } catch {
            logger.say("(bootstrap web failed: \(error) — will kickstart anyway)")
        }

        logger.say("kickstarting web daemon to rebuild caches from completed corpus")
        do {
            _ = try await deps.launchctl.kickstart(labels.web)
        } catch {
            logger.error("could not kickstart web daemon: \(error)")
            return 1
        }

        logger.say("kickstarting MCP daemon to drop stale LRU entries post-corpus-refresh")
        do {
            _ = try await deps.launchctl.kickstart(labels.mcp)
        } catch {
            logger.warn("could not kickstart mcp daemon: \(error)")
        }

        // Wait up to 20 s for the new web process to come online.
        for attempt in 1 ... 10 {
            await deps.sleep(2_000)
            let result = await deps.http.probe(
                "http://127.0.0.1:\(env.vars["WEB_PORT"] ?? "")/", options: ProbeOptions(deadlineMs: 3_000))
            if result.status == 200 {
                logger.say("local web responding 200 (attempt \(attempt))")
                break
            }
            logger.say(
                "waiting for web daemon (attempt \(attempt), got "
                    + "\(result.status.map(String.init) ?? outcomeLabel(result.outcome)))...")
        }

        logger.say("running smoke-test")
        _ = await deps.runSmoke(env)
        logger.say("watcher done")
        return 0
    }
}

private func plistPath(_ label: String) -> String { "/Library/LaunchDaemons/\(label).plist" }

private func outcomeLabel(_ outcome: ProbeOutcome) -> String {
    switch outcome {
        case .http: return "http"
        case .timeout: return "timeout"
        case .network: return "network"
    }
}
