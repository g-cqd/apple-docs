// `ops install` — render + install launchd plists and the sudoers drop-in.
// Native port of ops/cmd/install-daemons.js. PREPARE-ONLY here: privileged steps
// (install / visudo / launchctl) all go through the injected CommandRunner +
// Launchctl, so `--dry-run` traces them without executing. Must be run as root
// on the live host (the CLI's `--execute`).

private import Foundation

private let appLabelKeys = ["LABEL_PROXY", "LABEL_WEB", "LABEL_MCP", "LABEL_WATCHDOG", "LABEL_AUTOROLL"]
private let allLabelKeys = appLabelKeys + ["LABEL_TUNNEL_WEB", "LABEL_TUNNEL_MCP"]

public enum InstallDaemons {
    /// Injected seams. `renderAll`/`smoke` default to the native ADOps paths.
    public struct Deps: Sendable {
        public var fs: any OpsFileSystem
        public var runner: any CommandRunner
        public var launchctl: Launchctl
        public var http: any HTTPProbing
        public var sleep: @Sendable (Int) async -> Void
        public var isRoot: @Sendable () -> Bool

        public init(
            fs: any OpsFileSystem, runner: any CommandRunner, launchctl: Launchctl,
            http: any HTTPProbing, sleep: @escaping @Sendable (Int) async -> Void = SmokeDeps.systemSleep,
            isRoot: @escaping @Sendable () -> Bool
        ) {
            self.fs = fs
            self.runner = runner
            self.launchctl = launchctl
            self.http = http
            self.sleep = sleep
            self.isRoot = isRoot
        }
    }

    public static func run(env: LoadedEnv, deps: Deps, logger: any OpsLogging) async -> Int32 {
        guard deps.isRoot() else {
            logger.error("install-daemons: must be run as root (sudo).")
            return 1
        }
        let runner = deps.runner
        let launchctl = deps.launchctl

        // 1. Render templates.
        logger.say("=== rendering templates ===")
        let renderOutcome = RenderAll.run(env: env, mode: .write, fs: deps.fs, logger: logger)
        if renderOutcome.exitCode != 0 { return renderOutcome.exitCode }

        // 2. Strip stale user-session LaunchAgents.
        logger.say("=== unloading stale user LaunchAgents ===")
        let userName = env.vars["USER_NAME"] ?? ""
        let uidResult = try? await runner.runAllowFailure(
            ["/usr/bin/id", "-u", userName], options: RunCmdOptions(deadlineMs: 5_000))
        let uid = (uidResult?.stdout ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        for key in allLabelKeys {
            let label = env.vars[key] ?? ""
            _ = try? await runner.runAllowFailure(
                ["/usr/bin/sudo", "-u", userName, "/bin/launchctl", "bootout", "gui/\(uid)/\(label)"],
                options: RunCmdOptions(deadlineMs: 5_000))
            _ = try? await runner.runAllowFailure(
                ["/bin/rm", "-f", "/Users/\(userName)/Library/LaunchAgents/\(label).plist"],
                options: RunCmdOptions(deadlineMs: 5_000))
        }

        // 3. Caddy presence (soft pre-check).
        logger.say("=== ensuring caddy is installed ===")
        do {
            _ = try await runner.run(
                [
                    "/usr/bin/sudo", "-u", userName, env.bunBin,
                    joinPath(env.opsDir, "cli.js"), "proxy", "validate"
                ], options: RunCmdOptions(deadlineMs: 60_000))
        } catch {
            logger.warn("caddy validation failed: \(error)")
        }

        // 4. Bootout existing app daemons.
        logger.say("=== unloading app daemons before reinstall ===")
        for key in appLabelKeys { _ = try? await launchctl.bootout(env.vars[key] ?? "") }

        // 5. Legacy cleanup.
        if let legacy = env.vars["LEGACY_LAUNCHD_LABELS"], !legacy.isEmpty {
            logger.say("=== removing legacy launchd labels ===")
            for label in legacy.split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) })
                .filter({ !$0.isEmpty })
            {
                logger.say("  legacy: \(label)")
                _ = try? await launchctl.bootout(label)
                _ = try? await runner.runAllowFailure(
                    ["/bin/rm", "-f", "/Library/LaunchDaemons/\(label).plist"],
                    options: RunCmdOptions(deadlineMs: 5_000))
            }
        }

        // 6. Install rendered plists.
        logger.say("=== installing plists to /Library/LaunchDaemons ===")
        for key in allLabelKeys {
            let label = env.vars[key] ?? ""
            let src = joinPath(joinPath(env.opsDir, "launchd"), "\(label).plist")
            guard deps.fs.exists(src) else {
                logger.warn("skip: \(src) missing")
                continue
            }
            _ = try? await runner.run(
                ["/usr/bin/install", "-o", "root", "-g", "wheel", "-m", "644", src, "/Library/LaunchDaemons/"],
                options: RunCmdOptions(deadlineMs: 5_000))
        }

        // 7. Bootstrap app daemons.
        logger.say("=== bootstrapping app daemons ===")
        for key in appLabelKeys {
            let label = env.vars[key] ?? ""
            let plist = "/Library/LaunchDaemons/\(label).plist"
            guard deps.fs.exists(plist) else { continue }
            _ = try? await launchctl.bootstrapOrKick(label, plistPath: plist)
        }

        // 8. Cloudflared tunnels.
        logger.say("=== ensuring cloudflared daemons are loaded ===")
        for key in ["LABEL_TUNNEL_WEB", "LABEL_TUNNEL_MCP"] {
            let label = env.vars[key] ?? ""
            let plist = "/Library/LaunchDaemons/\(label).plist"
            guard deps.fs.exists(plist) else { continue }
            if (try? await launchctl.isLoaded(label)) == true {
                _ = try? await launchctl.kickstart(label)
            } else {
                _ = try? await launchctl.bootstrapOrKick(label, plistPath: plist)
            }
        }

        // 9. Sudoers drop-in.
        logger.say("=== validating + installing sudoers drop-in ===")
        let stem = (env.vars["LABEL_PREFIX"] ?? "").replacingOccurrences(of: ".", with: "_")
        let renderedSudoers = joinPath(joinPath(env.opsDir, "launchd"), "sudoers.apple-docs-launchctl")
        _ = try? await runner.run(
            ["/usr/sbin/visudo", "-cf", renderedSudoers], options: RunCmdOptions(deadlineMs: 5_000))
        _ = try? await runner.run(
            [
                "/usr/bin/install", "-o", "root", "-g", "wheel", "-m", "440", renderedSudoers,
                "/etc/sudoers.d/\(stem)-launchctl"
            ], options: RunCmdOptions(deadlineMs: 5_000))

        // 10. Smoke.
        logger.say("=== waiting 8s for tunnels and services to settle ===")
        await deps.sleep(8_000)
        logger.say("=== smoke tests ===")
        let smokeCode = await SmokeTest.run(
            env: env, deps: SmokeDeps(http: deps.http, sleep: deps.sleep), logger: logger)
        if smokeCode != 0 { logger.warn("one or more smoke tests failed") }
        return 0
    }
}
