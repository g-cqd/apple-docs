// `ad-cli ops <verb>` — the native port of the ops/ deployment tooling
// (ops/cli.js dispatcher + ops/cmd/*.js). Each verb loads + validates ops/.env
// through ADOps, then delegates to the ADOps seams (RenderTemplate/RenderAll,
// Launchctl, RunCmd, HttpProbe, GhRelease, OpsLogger).
//
// The privileged/live-host verbs (install-daemons, deploy-update, pull-snapshot)
// are PREPARE-ONLY here: they default to `--dry-run`, which records + prints the
// exact privileged/network sequence WITHOUT executing it, and refuse to run live
// unless `--execute` is passed (never exercised off the production host).

import ADOps
import ArgumentParser
import Foundation

/// The `ops` verb group.
struct OpsCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "ops",
        abstract: "Deployment ops verbs (render templates, manage launchd services, probe health).",
        subcommands: [
            OpsRenderAllCommand.self,
            OpsServiceCommand.self,
            OpsProxyCommand.self,
            OpsCfPurgeCommand.self,
            OpsSmokeTestCommand.self,
            OpsWatchSyncCommand.self
        ])
}

/// Shared `.env` resolution for every ops verb. `--ops-dir` defaults to the
/// `OPS_DIR` process-env var; `--env-file` overrides the default `<ops-dir>/.env`.
struct OpsEnvOptions: ParsableArguments {
    @Option(name: .customLong("ops-dir"), help: "The ops/ directory (default: $OPS_DIR).")
    var opsDir: String?

    @Option(name: .customLong("env-file"), help: "Path to ops/.env (default: <ops-dir>/.env).")
    var envFile: String?

    /// Resolve the ops directory or throw a validation error.
    func resolvedOpsDir() throws -> String {
        if let opsDir, !opsDir.isEmpty { return opsDir }
        if let fromEnv = ProcessInfo.processInfo.environment["OPS_DIR"], !fromEnv.isEmpty {
            return fromEnv
        }
        throw ValidationError("ops: pass --ops-dir or set OPS_DIR")
    }

    /// Load + validate the ops environment.
    func load() throws -> LoadedEnv {
        let dir = try resolvedOpsDir()
        return try OpsEnv.load(opsDir: dir, path: envFile)
    }
}

/// The standard production seams the ops verbs wire together.
enum OpsRuntime {
    static func logger(logFile: String? = nil) -> OpsLogger {
        OpsLogger(logPath: logFile)
    }
    static var fileSystem: PosixFileSystem { PosixFileSystem() }
    static var commandRunner: ProcessCommandRunner { ProcessCommandRunner() }
    static var probe: URLSessionProbe { URLSessionProbe() }
}

/// Map an `EnvLoadError` to a stderr line + its bash-parity exit code.
func reportEnvError(_ error: any Error) -> Int32 {
    if let envError = error as? EnvLoadError {
        FileHandle.standardError.write(Data("ops: \(envError.message)\n".utf8))
        return envError.exitCode
    }
    FileHandle.standardError.write(Data("ops: \(error)\n".utf8))
    return 1
}

/// Exit the process with `code` (ArgumentParser's async run has no return value).
func exitOps(_ code: Int32) -> Never {
    exit(code)
}

// MARK: - render-all

/// `ad-cli ops render-all [--check] [--dry-run]` — re-render every ops/*.tpl from
/// ops/.env (ports ops/cmd/render-all.js).
struct OpsRenderAllCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "render-all",
        abstract: "Re-render every *.tpl (launchd/caddy/cloudflared/sudoers/systemd) from ops/.env.")

    @OptionGroup var env: OpsEnvOptions

    @Flag(name: .long, help: "Exit 1 if any output would differ from on-disk content (drift check).")
    var check = false

    @Flag(name: .customLong("dry-run"), help: "Print what would render without writing.")
    var dryRun = false

    func run() async throws {
        let loaded: LoadedEnv
        do {
            loaded = try env.load()
        } catch {
            exitOps(reportEnvError(error))
        }
        let mode: RenderAllMode = check ? .check : (dryRun ? .dryRun : .write)
        let outcome = RenderAll.run(
            env: loaded, mode: mode, fs: OpsRuntime.fileSystem, logger: OpsRuntime.logger())
        exitOps(outcome.exitCode)
    }
}

// MARK: - service

/// `ad-cli ops service <verb> <target>` — start/stop/restart/status a launchd
/// daemon (ports ops/cmd/service.js).
struct OpsServiceCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "service",
        abstract: "start | stop | restart | status a launchd daemon (or `all`).")

    @OptionGroup var env: OpsEnvOptions

    @Argument(help: "start | stop | restart | status")
    var verb: String

    @Argument(help: "proxy | web | mcp | watchdog | tunnel-web | tunnel-mcp | all")
    var target: String

    func run() async throws {
        let loaded: LoadedEnv
        do { loaded = try env.load() } catch { exitOps(reportEnvError(error)) }
        let launchctl = Launchctl(runner: OpsRuntime.commandRunner)
        let code = await Service.run(
            verb: verb, target: target, env: loaded, launchctl: launchctl,
            logger: OpsRuntime.logger())
        exitOps(code)
    }
}

// MARK: - proxy

/// `ad-cli ops proxy <run|validate|reload|status>` (ports ops/cmd/proxy.js). The
/// live `run` supervisor stays here; validate/reload/status delegate to ADOps.
struct OpsProxyCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "proxy", abstract: "Caddy proxy verbs: run | validate | reload | status.")

    @OptionGroup var env: OpsEnvOptions

    @Argument(help: "run | validate | reload | status")
    var verb: String

    func run() async throws {
        let loaded: LoadedEnv
        do { loaded = try env.load() } catch { exitOps(reportEnvError(error)) }
        let logger = OpsRuntime.logger()
        if verb == "run" {
            exitOps(superviseCaddyRun(env: loaded, fs: OpsRuntime.fileSystem, logger: logger))
        }
        let deps = Proxy.Deps(
            fs: OpsRuntime.fileSystem, runner: OpsRuntime.commandRunner, http: OpsRuntime.probe)
        let code = await Proxy.runControl(
            verb: verb, env: loaded, processEnv: ProcessInfo.processInfo.environment, deps: deps,
            logger: logger)
        exitOps(code)
    }
}

/// Long-running `caddy run` supervisor (the `run` verb). runCmd's deadline would
/// SIGKILL caddy, so this spawns it directly with inherited stdio and waits.
private func superviseCaddyRun(env: LoadedEnv, fs: PosixFileSystem, logger: OpsLogger) -> Int32 {
    let configPath = "\(env.opsDir)/caddy/Caddyfile"
    guard fs.exists(configPath) else {
        logger.error("proxy: \(configPath) not found. Run `ops render-all` first.")
        return 66
    }
    guard let caddyBin = Proxy.whichCaddy(fs) else {
        logger.error("proxy: `caddy` not found in PATH")
        return 127
    }
    let args = ["run", "--config", configPath, "--adapter", "caddyfile"]
    logger.say("$ \(caddyBin) \(args.joined(separator: " "))")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: caddyBin)
    process.arguments = args
    var childEnv = ProcessInfo.processInfo.environment
    childEnv["PATH"] = brewPath
    process.environment = childEnv
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        logger.error("proxy: caddy run failed: \(error)")
        return 1
    }
    return process.terminationStatus
}

// MARK: - cf-purge

/// `ad-cli ops cf-purge` — purge the Cloudflare edge cache (ports
/// ops/cmd/cf-purge.js). Soft-fails when the token/zone isn't configured.
struct OpsCfPurgeCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "cf-purge", abstract: "Purge the Cloudflare edge cache.")

    @OptionGroup var env: OpsEnvOptions

    func run() async throws {
        let processEnv = ProcessInfo.processInfo.environment
        // Only touch ops/.env if the creds aren't already in the process env.
        var loadedVars: [String: String]?
        if processEnv["CLOUDFLARE_API_TOKEN"] == nil || processEnv["CLOUDFLARE_ZONE_ID"] == nil {
            loadedVars = (try? env.load())?.vars
        }
        let code = await CfPurge.run(
            processEnv: processEnv, loadedVars: loadedVars, http: OpsRuntime.probe,
            logger: OpsRuntime.logger())
        exitOps(code)
    }
}

// MARK: - smoke-test

/// `ad-cli ops smoke-test` — the readiness + healthz + concurrency battery
/// (ports ops/cmd/smoke-test.js).
struct OpsSmokeTestCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "smoke-test", abstract: "Run the smoke-test probe battery against a live deploy.")

    @OptionGroup var env: OpsEnvOptions

    func run() async throws {
        let loaded: LoadedEnv
        do { loaded = try env.load() } catch { exitOps(reportEnvError(error)) }
        let code = await SmokeTest.run(
            env: loaded, deps: SmokeDeps(http: OpsRuntime.probe), logger: OpsRuntime.logger())
        exitOps(code)
    }
}

// MARK: - watch-sync

/// `ad-cli ops watch-sync` — wait for SYNC_PID then bootstrap web+mcp (ports
/// ops/cmd/watch-sync.js).
struct OpsWatchSyncCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "watch-sync",
        abstract: "Wait for an in-progress sync (SYNC_PID), then start web + mcp and smoke-test.")

    @OptionGroup var env: OpsEnvOptions

    func run() async throws {
        let processEnv = ProcessInfo.processInfo.environment
        guard let pidString = processEnv["SYNC_PID"], let pid = Int32(pidString), pid > 0 else {
            OpsRuntime.logger()
                .error(
                    "watch-sync: set SYNC_PID=<pid of apple-docs sync> before invoking")
            exitOps(64)
        }
        let loaded: LoadedEnv
        do { loaded = try env.load() } catch { exitOps(reportEnvError(error)) }
        let logger = OpsRuntime.logger()
        let launchctl = Launchctl(runner: OpsRuntime.commandRunner)
        let deps = WatchSyncDeps(
            launchctl: launchctl, http: OpsRuntime.probe,
            runSmoke: { environment in
                await SmokeTest.run(
                    env: environment, deps: SmokeDeps(http: URLSessionProbe()),
                    logger: OpsLogger())
            })
        exitOps(await WatchSync.run(env: loaded, syncPid: pid, deps: deps, logger: logger))
    }
}
