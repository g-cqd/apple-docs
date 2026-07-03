// `ops pull-snapshot` — apply the latest GH-release snapshot to a running host.
// Native port of ops/cmd/pull-snapshot.js. Preserves the post-outage reordering:
// services come back IMMEDIATELY after `setup`, before the long web build, so the
// user-facing API is down for well under ten minutes. PREPARE-ONLY here: the
// setup/build subprocesses + launchctl go through injected seams (`--dry-run`
// traces them). Exit codes: 0 applied/no-op, 1 GH unreachable, 2 setup failed
// (services restored).

private import Foundation

private let githubRepoSlug = "g-cqd/apple-docs"

public enum PullSnapshot {
    /// Injected seams.
    public struct Deps: Sendable {
        public var fetcher: any GhFetcher
        public var runner: any CommandRunner
        public var launchctl: Launchctl
        public var http: any HTTPProbing
        public var fs: any OpsFileSystem
        public var sleep: @Sendable (Int) async -> Void

        public init(
            fetcher: any GhFetcher, runner: any CommandRunner, launchctl: Launchctl,
            http: any HTTPProbing, fs: any OpsFileSystem,
            sleep: @escaping @Sendable (Int) async -> Void = SmokeDeps.systemSleep
        ) {
            self.fetcher = fetcher
            self.runner = runner
            self.launchctl = launchctl
            self.http = http
            self.fs = fs
            self.sleep = sleep
        }
    }

    public static func run(
        env: LoadedEnv, processEnv: [String: String], force: Bool, deps: Deps,
        logger: any OpsLogging
    ) async -> Int32 {
        let channel = env.vars["SNAPSHOT_CHANNEL"] ?? "stable"
        logger.say("=== pull-snapshot starting (force=\(force ? 1 : 0), channel=\(channel)) ===")

        // 1. Latest release on the configured channel.
        let release: Release
        do {
            release = try await GhRelease.resolveChannelRelease(
                githubRepoSlug, channel: channel, fetcher: deps.fetcher)
        } catch {
            logger.error("could not fetch latest release: \(error)")
            return 1
        }
        logger.say("latest release: \(release.tagName)")

        // 2. Compare against the applied tag.
        let appliedFile = joinPath(joinPath(env.opsDir, "state"), "applied-snapshot")
        let applied = deps.fs.tryReadText(appliedFile)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        logger.say("currently applied: \(applied.isEmpty ? "<none>" : applied)")
        if applied == release.tagName, !force {
            logger.say("already at \(release.tagName) — nothing to do")
            logger.say("=== pull-snapshot done (no-op) ===")
            return 0
        }

        // 3. Stop services (watchdog → web → mcp).
        let labels = env.labels
        for label in [labels.watchdog, labels.web, labels.mcp] {
            logger.say("stopping \(label)")
            _ = try? await deps.launchctl.bootout(label)
        }

        // 4. setup --force --native [--beta].
        var setupArgs = [
            env.bunBin, "run", joinPath(env.repoDir, "cli.js"), "setup", "--force", "--native"
        ]
        if channel == "beta" { setupArgs.append("--beta") }
        logger.say("$ \(setupArgs.joined(separator: " "))")
        do {
            let result = try await deps.runner.run(setupArgs, options: RunCmdOptions(deadlineMs: 60 * 60_000))
            logger.runOutput(result.stdout)
            logger.runOutput(result.stderr)
        } catch {
            logger.error("apple-docs setup failed: \(error)")
            logger.say("restoring services before exiting")
            await restartAll(env: env, deps: deps, logger: logger)
            return 2
        }

        // 5. Bring services back UP before the web build.
        await restartAll(env: env, deps: deps, logger: logger)

        // 6. Web build (incremental).
        let buildArgs = [
            env.bunBin, "run", joinPath(env.repoDir, "cli.js"), "web", "build", "--incremental",
            "--out", env.staticDir, "--base-url", "https://\(env.vars["PUBLIC_WEB_HOST"] ?? "")"
        ]
        logger.say("$ \(env.bunBin) run \(joinPath(env.repoDir, "cli.js")) web build --incremental")
        do {
            _ = try await deps.runner.run(buildArgs, options: RunCmdOptions(deadlineMs: 60 * 60_000))
        } catch {
            logger.warn("incremental static build failed: \(error) — Caddy keeps the previous tree")
        }

        // 7. cf-purge.
        _ = await CfPurge.run(
            processEnv: processEnv, loadedVars: env.vars, http: deps.http, logger: logger)

        // 8. Smoke.
        await deps.sleep(3_000)
        let smokeCode = await SmokeTest.run(
            env: env, deps: SmokeDeps(http: deps.http, sleep: deps.sleep), logger: logger)
        if smokeCode != 0 {
            logger.warn("smoke test reported failures — investigate before declaring success")
        }

        // 9. Stamp applied-snapshot (strict tag allowlist first).
        guard isValidSnapshotTag(release.tagName) else {
            logger.error("refusing to stamp suspect tag name: \(release.tagName)")
            return 1
        }
        try? deps.fs.writeAtomic(appliedFile, Array("\(release.tagName)\n".utf8))
        logger.say("stamped applied-snapshot=\(release.tagName)")
        logger.say("=== pull-snapshot done ===")
        return 0
    }

    /// Bring web → mcp back up, then (after a settle) the watchdog last.
    private static func restartAll(env: LoadedEnv, deps: Deps, logger: any OpsLogging) async {
        for label in [env.labels.web, env.labels.mcp] {
            logger.say("bootstrapping \(label)")
            _ = try? await deps.launchctl.bootstrapOrKick(
                label, plistPath: "/Library/LaunchDaemons/\(label).plist")
        }
        await deps.sleep(3_000)
        logger.say("bootstrapping \(env.labels.watchdog)")
        _ = try? await deps.launchctl.bootstrapOrKick(
            env.labels.watchdog, plistPath: "/Library/LaunchDaemons/\(env.labels.watchdog).plist")
    }
}
