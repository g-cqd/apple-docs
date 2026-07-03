// launchctl wrapper for the ops layer — the native port of ops/lib/launchctl.js.
//
// Every privileged load/unload/kick call goes through here so the sudoers
// passwordless allowlist only needs to cover `/bin/launchctl` + the standard
// verbs, the argv shape stays consistent, and tests inject a fake CommandRunner.
// The "bootstrap → on EEXIST fall back to kickstart -k" semantics the bash
// scripts repeated everywhere are built in.

private let launchctlBin = "/bin/launchctl"
private let sudoBin = "/usr/bin/sudo"

/// The outcome of a start attempt.
public enum BootstrapOutcome: Sendable, Equatable {
    /// `bootstrap` succeeded (the label was not previously loaded).
    case bootstrapped
    /// The label was already loaded (bootstrap EEXIST) → `kickstart -k`.
    case kickstarted
}

/// The outcome of a stop attempt.
public enum StopOutcome: Sendable, Equatable {
    case alreadyStopped
    case stopped
}

/// launchctl verbs over an injected `CommandRunner`.
public struct Launchctl: Sendable {
    private let runner: any CommandRunner

    public init(runner: any CommandRunner) {
        self.runner = runner
    }

    /// `launchctl print system/<label>` exits 0 when loaded — branch on exit code
    /// (print's grammar isn't stable enough to parse).
    public func isLoaded(_ label: String) async throws -> Bool {
        let result = try await runner.runAllowFailure(
            [sudoBin, "-n", launchctlBin, "print", "system/\(label)"],
            options: RunCmdOptions(deadlineMs: 10_000, stdout: .ignore, stderr: .pipe))
        return result.exitCode == 0
    }

    /// `bootstrap` a plist; on any non-zero exit (EEXIST when already loaded) fall
    /// back to `kickstart -k`, which SIGKILLs + re-execs from the on-disk plist.
    @discardableResult
    public func bootstrapOrKick(_ label: String, plistPath: String) async throws -> BootstrapOutcome {
        let result = try await runner.runAllowFailure(
            [sudoBin, "-n", launchctlBin, "bootstrap", "system", plistPath],
            options: RunCmdOptions(deadlineMs: 15_000))
        if result.exitCode == 0 { return .bootstrapped }
        _ = try await kickstart(label)
        return .kickstarted
    }

    /// `bootout` a label; a no-op (non-zero exit tolerated) when already absent.
    @discardableResult
    public func bootout(_ label: String) async throws -> RunCmdResult {
        try await runner.runAllowFailure(
            [sudoBin, "-n", launchctlBin, "bootout", "system/\(label)"],
            options: RunCmdOptions(deadlineMs: 15_000))
    }

    /// `kickstart -k` — SIGKILL the running process and let launchd re-exec it.
    @discardableResult
    public func kickstart(_ label: String) async throws -> RunCmdResult {
        try await runner.run(
            [sudoBin, "-n", launchctlBin, "kickstart", "-k", "system/\(label)"],
            options: RunCmdOptions(deadlineMs: 15_000))
    }

    /// `launchctl print system/<label>` capturing stdout (for `service status`).
    /// Never throws on a non-zero exit — the caller reads exitCode + stdout.
    public func printStatus(_ label: String) async throws -> RunCmdResult {
        try await runner.runAllowFailure(
            [sudoBin, "-n", launchctlBin, "print", "system/\(label)"],
            options: RunCmdOptions(deadlineMs: 10_000))
    }

    /// Stop a label if loaded; no-op (logged) when already absent.
    @discardableResult
    public func stopOne(_ label: String, logger: any OpsLogging) async throws -> StopOutcome {
        if try await !isLoaded(label) {
            logger.say("\(label) not loaded — skipping bootout")
            return .alreadyStopped
        }
        logger.say("stopping \(label)")
        _ = try await bootout(label)
        return .stopped
    }

    /// Start a label. A missing plist is an install bug → throw (not a warning).
    @discardableResult
    public func startOne(
        _ label: String, plistPath: String, fs: any OpsFileSystem, logger: any OpsLogging
    ) async throws -> BootstrapOutcome {
        guard fs.exists(plistPath) else {
            throw OpsIOError("launchctl: \(plistPath) missing — cannot start \(label)")
        }
        logger.say("bootstrapping \(label)")
        return try await bootstrapOrKick(label, plistPath: plistPath)
    }
}
