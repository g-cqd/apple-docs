// `ops deploy` — pull-and-redeploy. Native port of ops/cmd/deploy-update.js:
// keep web/mcp serving while pulling + rendering + refreshing, then cut over.
// PREPARE-ONLY here: git / bun / launchctl all go through injected seams
// (`--dry-run` traces them). Exit codes mirror the JS (1 no repo, 2 diverged,
// 3 pull failed, 4 full build failed).

private import Foundation

private let deployRepoSlug = "g-cqd/apple-docs"
private let gitBin = "/usr/bin/git"

public enum DeployUpdate {
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
        env: LoadedEnv, processEnv: [String: String], fullRebuild: Bool, deps: Deps,
        logger: any OpsLogging
    ) async -> Int32 {
        let repoDir = firstNonEmptyString(processEnv["APPLE_DOCS_REPO"], env.repoDir)
        let keepServing = (processEnv["KEEP_SERVING_DURING_REFRESH"] ?? "1") == "1"
        let wantFull = fullRebuild || processEnv["REBUILD_STATIC_FULL"] == "1"

        logger.say("=== deploy-update starting ===")
        guard deps.fs.exists(repoDir) else {
            logger.error("repo directory \(repoDir) does not exist")
            return 1
        }

        // 1. Optional pre-down.
        if !keepServing {
            for label in [env.labels.web, env.labels.mcp] {
                logger.say("stopping \(label)")
                _ = try? await deps.launchctl.bootout(label)
            }
        } else {
            logger.say("keeping web + mcp online during refresh; cutover restart happens at the end")
        }

        // 2. Repo state + git pull.
        logger.say("current HEAD: \(await git(repoDir, ["rev-parse", "--short", "HEAD"], deps))")
        if await isDirty(repoDir, deps) {
            logger.say("working tree dirty — checking if changes are already on origin")
            _ = try? await deps.runner.run(
                [gitBin, "-C", repoDir, "fetch", "origin", "--quiet"], options: RunCmdOptions(deadlineMs: 60_000))
            let diff = await gitAllow(repoDir, ["diff", "origin/main", "--"], deps)
            guard diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                logger.error("local changes diverge from origin. Aborting deploy-update.")
                return 2
            }
            logger.say("local tree matches origin/main — resetting to drop local noise")
            _ = try? await deps.runner.run(
                [gitBin, "-C", repoDir, "reset", "--hard", "HEAD"], options: RunCmdOptions(deadlineMs: 60_000))
            _ = try? await deps.runner.run(
                [gitBin, "-C", repoDir, "clean", "-fd", "--", "src", "test", "cli.js"],
                options: RunCmdOptions(deadlineMs: 60_000))
        }

        _ = try? await deps.runner.run(
            [gitBin, "-C", repoDir, "fetch", "origin", "--quiet"], options: RunCmdOptions(deadlineMs: 60_000))
        let preLock = await gitAllow(repoDir, ["rev-parse", "HEAD:bun.lock"], deps)
        let prePkg = await gitAllow(repoDir, ["rev-parse", "HEAD:package.json"], deps)
        do {
            _ = try await deps.runner.run(
                [gitBin, "-C", repoDir, "pull", "--ff-only", "origin", "main"],
                options: RunCmdOptions(deadlineMs: 60_000))
        } catch {
            logger.error("git pull failed: \(error)")
            return 3
        }
        logger.say("new HEAD: \(await git(repoDir, ["rev-parse", "--short", "HEAD"], deps))")

        // 3. Install deps if lockfile/manifest changed.
        let postLock = await gitAllow(repoDir, ["rev-parse", "HEAD:bun.lock"], deps)
        let postPkg = await gitAllow(repoDir, ["rev-parse", "HEAD:package.json"], deps)
        if preLock != postLock || prePkg != postPkg {
            logger.say("package.json / bun.lock changed — running bun install")
            do {
                _ = try await deps.runner.run(
                    [env.bunBin, "install", "--frozen-lockfile"],
                    options: RunCmdOptions(deadlineMs: 5 * 60_000, cwd: repoDir))
            } catch {
                _ = try? await deps.runner.run(
                    [env.bunBin, "install"], options: RunCmdOptions(deadlineMs: 5 * 60_000, cwd: repoDir))
            }
        } else {
            logger.say("deps unchanged — skipping bun install")
        }

        // 4. Re-render; reload caddy on Caddyfile drift.
        let caddyfile = joinPath(joinPath(env.opsDir, "caddy"), "Caddyfile")
        let preHash = sha256OfFile(deps.fs, caddyfile)
        let renderOutcome = RenderAll.run(env: env, mode: .write, fs: deps.fs, logger: logger)
        if renderOutcome.exitCode != 0 {
            logger.warn("render-all failed; continuing with stale rendered config")
        } else {
            if preHash != sha256OfFile(deps.fs, caddyfile) {
                logger.say("Caddyfile changed — reloading caddy")
                let reload = await Proxy.runControl(
                    verb: "reload", env: env, processEnv: processEnv,
                    deps: Proxy.Deps(fs: deps.fs, runner: deps.runner, http: deps.http), logger: logger)
                if reload != 0 { logger.warn("caddy reload failed") }
            } else {
                logger.say("Caddyfile unchanged — skipping caddy reload")
            }
            warnOnPlistDrift(env: env, fs: deps.fs, logger: logger)
        }

        // 5. Corpus refresh.
        let mode = await chooseRefreshMode(processEnv: processEnv, env: env, deps: deps, logger: logger)
        if mode == .snapshot {
            let snapCode = await PullSnapshot.run(
                env: env, processEnv: processEnv, force: false,
                deps: PullSnapshot.Deps(
                    fetcher: deps.fetcher, runner: deps.runner, launchctl: deps.launchctl,
                    http: deps.http, fs: deps.fs, sleep: deps.sleep), logger: logger)
            if snapCode == 0 {
                logger.say("=== deploy-update done (snapshot refresh handled by pull-snapshot) ===")
                return 0
            }
            logger.warn("pull-snapshot failed — continuing with the existing corpus")
        } else if mode == .crawl {
            _ = try? await deps.runner.run(
                [env.bunBin, "run", joinPath(repoDir, "cli.js"), "sync"],
                options: RunCmdOptions(deadlineMs: 4 * 60 * 60_000, cwd: repoDir))
        }

        // 6. Rebuild static site.
        let buildArgs = [
            env.bunBin, "run", joinPath(repoDir, "cli.js"), "web", "build",
            wantFull ? "--full" : "--incremental", "--out", env.staticDir, "--base-url",
            "https://\(env.vars["PUBLIC_WEB_HOST"] ?? "")"
        ]
        do {
            _ = try await deps.runner.run(buildArgs, options: RunCmdOptions(deadlineMs: 60 * 60_000, cwd: repoDir))
        } catch {
            if wantFull {
                logger.error("full static build failed: \(error) — keeping existing \(env.staticDir)")
                return 4
            }
            logger.warn("incremental static build failed: \(error) — Caddy keeps the previous tree")
        }

        // 7. cf-purge.
        _ = await CfPurge.run(processEnv: processEnv, loadedVars: env.vars, http: deps.http, logger: logger)

        // 8. Cutover.
        for label in [env.labels.web, env.labels.mcp] {
            await cutoverOne(label, deps: deps, logger: logger)
        }
        await deps.sleep(3_000)
        await cutoverOne(env.labels.watchdog, deps: deps, logger: logger)

        // 9. Smoke.
        await deps.sleep(3_000)
        logger.say("=== smoke tests ===")
        let smokeCode = await SmokeTest.run(
            env: env, deps: SmokeDeps(http: deps.http, sleep: deps.sleep), logger: logger)
        if smokeCode != 0 { logger.warn("one or more smoke tests failed") }
        logger.say("=== deploy-update done ===")
        return 0
    }

    private enum RefreshMode { case snapshot, crawl, skip }

    private static func chooseRefreshMode(
        processEnv: [String: String], env: LoadedEnv, deps: Deps, logger: any OpsLogging
    ) async -> RefreshMode {
        if processEnv["USE_SNAPSHOT"] == "1" {
            logger.say("USE_SNAPSHOT=1 forced by env")
            return .snapshot
        }
        if processEnv["USE_SNAPSHOT"] == "0" || processEnv["USE_CRAWL"] == "1" {
            logger.say("crawl-on-host refresh forced by env")
            return .crawl
        }
        let appliedFile = joinPath(joinPath(env.opsDir, "state"), "applied-snapshot")
        let applied = deps.fs.tryReadText(appliedFile)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        do {
            let release = try await GhRelease.resolveChannelRelease(
                deployRepoSlug, channel: env.vars["SNAPSHOT_CHANNEL"] ?? "stable", fetcher: deps.fetcher)
            if !release.tagName.isEmpty, release.tagName != applied {
                logger.say(
                    "auto-detected new GH snapshot \(release.tagName) (was \(applied.isEmpty ? "<none>" : applied)) — using snapshot mode"
                )
                return .snapshot
            }
            logger.say(
                "snapshot tag unchanged (\(applied.isEmpty ? "<none>" : applied)) — code-only deploy, corpus refresh skipped"
            )
            return .skip
        } catch {
            logger.warn("could not query GH releases (\(error)) — skipping corpus refresh")
            return .skip
        }
    }

    private static func cutoverOne(_ label: String, deps: Deps, logger: any OpsLogging) async {
        if (try? await deps.launchctl.isLoaded(label)) == true {
            logger.say("kickstarting \(label) for cutover")
            _ = try? await deps.launchctl.kickstart(label)
        } else {
            logger.say("bootstrapping \(label)")
            _ = try? await deps.launchctl.bootstrapOrKick(
                label, plistPath: "/Library/LaunchDaemons/\(label).plist")
        }
    }

    private static func warnOnPlistDrift(env: LoadedEnv, fs: any OpsFileSystem, logger: any OpsLogging) {
        let labels = [
            env.vars["LABEL_PROXY"], env.vars["LABEL_WEB"], env.vars["LABEL_MCP"],
            env.vars["LABEL_WATCHDOG"], env.vars["LABEL_TUNNEL_WEB"], env.vars["LABEL_TUNNEL_MCP"]
        ]
        .compactMap { $0 }
        var drift = false
        for label in labels {
            let rendered = joinPath(joinPath(env.opsDir, "launchd"), "\(label).plist")
            let installed = "/Library/LaunchDaemons/\(label).plist"
            guard fs.exists(rendered) else { continue }
            if !fs.exists(installed) {
                logger.warn("\(installed) not yet installed — run `apple-docs-ops install`")
                drift = true
                continue
            }
            if sha256OfFile(fs, rendered) != sha256OfFile(fs, installed) {
                logger.warn("plist drift for \(label) — rendered \(rendered) differs from installed copy")
                drift = true
            }
        }
        if drift {
            logger.warn("one or more plists changed; kickstart will NOT pick them up. Run `apple-docs-ops install`")
        }
    }
}

// MARK: - helpers

private func git(_ repoDir: String, _ args: [String], _ deps: DeployUpdate.Deps) async -> String {
    let result = try? await deps.runner.run(
        [gitBin, "-C", repoDir] + args, options: RunCmdOptions(deadlineMs: 60_000))
    return (result?.stdout ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
}

private func gitAllow(_ repoDir: String, _ args: [String], _ deps: DeployUpdate.Deps) async -> String {
    let result = try? await deps.runner.runAllowFailure(
        [gitBin, "-C", repoDir] + args, options: RunCmdOptions(deadlineMs: 60_000))
    return (result?.stdout ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
}

private func isDirty(_ repoDir: String, _ deps: DeployUpdate.Deps) async -> Bool {
    let a = try? await deps.runner.runAllowFailure(
        [gitBin, "-C", repoDir, "diff", "--quiet"], options: RunCmdOptions(deadlineMs: 30_000))
    let b = try? await deps.runner.runAllowFailure(
        [gitBin, "-C", repoDir, "diff", "--cached", "--quiet"], options: RunCmdOptions(deadlineMs: 30_000))
    return (a?.exitCode ?? 0) != 0 || (b?.exitCode ?? 0) != 0
}

private func sha256OfFile(_ fs: any OpsFileSystem, _ path: String) -> String {
    guard let bytes = fs.tryRead(path) else { return "" }
    return SHA256Hex.hex(bytes)
}

private func firstNonEmptyString(_ values: String?...) -> String {
    for value in values where !(value ?? "").isEmpty { return value ?? "" }
    return ""
}
