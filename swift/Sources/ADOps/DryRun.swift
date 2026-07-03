// A CommandRunner that never executes: it logs each command it is asked to run
// and returns a scripted result (exit 0 by default). This is how the prepare-only
// host verbs (install-daemons, deploy-update, pull-snapshot) support `--dry-run`
// — the CLI wires a DryRunCommandRunner so the privileged/network sequence is
// TRACED, not run. `--execute` swaps in the real ProcessCommandRunner (never
// exercised off the production host).

/// A tiny lock wrapper usable from async contexts (NSLock.lock() is banned there).
private import class Foundation.NSLock

/// A no-op runner that records + logs commands and returns a canned result.
public final class DryRunCommandRunner: CommandRunner, @unchecked Sendable {
    private let logger: any OpsLogging
    private let stdoutFor: @Sendable ([String]) -> String
    private let lock = NSLockShim()
    private var recorded: [[String]] = []

    /// `stdoutFor` supplies optional canned stdout per command (default empty), so
    /// a dry-run of a verb that branches on `git rev-parse` output can be steered
    /// in tests.
    public init(
        logger: any OpsLogging,
        stdoutFor: @escaping @Sendable ([String]) -> String = { _ in "" }
    ) {
        self.logger = logger
        self.stdoutFor = stdoutFor
    }

    public var calls: [[String]] { lock.withLock { recorded } }

    public func run(_ args: [String], options: RunCmdOptions) async throws -> RunCmdResult {
        lock.withLock { recorded.append(args) }
        logger.say("[dry-run] $ \(args.joined(separator: " "))")
        return RunCmdResult(stdout: stdoutFor(args), stderr: "", exitCode: 0, elapsedMs: 0)
    }
}

/// A GitHub fetcher that never hits the network: it logs the intended GET and
/// returns a canned releases/latest payload so a dry-run traces the full flow.
public struct DryRunGhFetcher: GhFetcher {
    private let logger: any OpsLogging
    public init(logger: any OpsLogging) { self.logger = logger }

    public func get(_ url: String, headers: [String: String]) async throws -> GhResponse {
        logger.say("[dry-run] would GET \(url)")
        let canned = "{\"tag_name\":\"dry-run-snapshot\",\"published_at\":\"\",\"assets\":[]}"
        return GhResponse(status: 200, body: Array(canned.utf8))
    }
}

/// An HTTP probe that never hits the network: returns a canned healthy response
/// so a dry-run of cf-purge / smoke traces the happy path.
public struct DryRunProbe: HTTPProbing {
    public init() {}
    public func probe(_ url: String, options: ProbeOptions) async -> ProbeResult {
        ProbeResult(
            ok: options.expectedStatus == 200, status: 200, elapsedMs: 0,
            body: "{\"success\":true,\"ok\":true}", outcome: .http, url: url)
    }
}

final class NSLockShim: @unchecked Sendable {
    private let lock = NSLock()
    func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
