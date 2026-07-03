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
            OpsRenderAllCommand.self
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
