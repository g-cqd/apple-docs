// `ops proxy <verb>` — Caddy proxy verbs (run|validate|reload|status). Native
// port of ops/cmd/proxy.js. All verbs read the Caddyfile from
// <opsDir>/caddy/Caddyfile and refuse to proceed when it doesn't exist
// (render-all must run first). The live `run` supervisor stays in the CLI layer;
// validate/reload/status are here (testable over injected seams).

/// The PATH the Caddy child runs with (Homebrew first).
public let brewPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

public enum Proxy {
    /// Locate `caddy` on the Homebrew-first PATH via the filesystem seam.
    public static func whichCaddy(_ fs: any OpsFileSystem) -> String? {
        for dir in brewPath.split(separator: ":") {
            let candidate = joinPath(String(dir), "caddy")
            if fs.exists(candidate) { return candidate }
        }
        return nil
    }

    /// The seams a proxy control verb needs (filesystem, subprocess, HTTP probe).
    public struct Deps: Sendable {
        public let fs: any OpsFileSystem
        public let runner: any CommandRunner
        public let http: any HTTPProbing
        public init(fs: any OpsFileSystem, runner: any CommandRunner, http: any HTTPProbing) {
            self.fs = fs
            self.runner = runner
            self.http = http
        }
    }

    /// Run a control verb (validate | reload | status). `run` is handled by the
    /// CLI (a live supervisor). Returns the bash-parity exit code.
    public static func runControl(
        verb: String, env: LoadedEnv, processEnv: [String: String], deps: Deps,
        logger: any OpsLogging
    ) async -> Int32 {
        let configPath = joinPath(joinPath(env.opsDir, "caddy"), "Caddyfile")
        let adminAddr = firstNonEmpty(env.vars["CADDY_ADMIN_ADDRESS"], env.vars["CADDY_ADMIN_ADDR"])

        if verb != "status", !deps.fs.exists(configPath) {
            logger.error("proxy: \(configPath) not found. Run `ops render-all` first.")
            return 66
        }
        if verb == "status" {
            return await status(adminAddr: adminAddr, http: deps.http, logger: logger)
        }

        guard let caddyBin = whichCaddy(deps.fs) else {
            logger.error("proxy: `caddy` not found in PATH")
            return 127
        }
        let runner = deps.runner
        var childEnv = processEnv
        childEnv["PATH"] = brewPath

        switch verb {
            case "validate":
                return await runCaddy(
                    [caddyBin, "validate", "--config", configPath, "--adapter", "caddyfile"],
                    childEnv: childEnv, runner: runner, logger: logger)
            case "reload":
                let validation = await runCaddy(
                    [caddyBin, "validate", "--config", configPath, "--adapter", "caddyfile"],
                    childEnv: childEnv, runner: runner, logger: logger)
                if validation != 0 { return validation }
                return await runCaddy(
                    [
                        caddyBin, "reload", "--config", configPath, "--adapter", "caddyfile",
                        "--address", adminAddr
                    ], childEnv: childEnv, runner: runner, logger: logger)
            default:
                logger.error("proxy: usage: proxy <run|validate|reload|status>")
                return 64
        }
    }

    private static func status(
        adminAddr: String, http: any HTTPProbing, logger: any OpsLogging
    ) async -> Int32 {
        logger.say("== Caddy upstream status ==")
        let result = await http.probe(
            "http://\(adminAddr)/reverse_proxy/upstreams", options: ProbeOptions(deadlineMs: 5_000))
        if !result.ok {
            logger.error(
                "proxy: could not query Caddy admin API at \(adminAddr) "
                    + "(\(result.outcome) \(result.status.map(String.init) ?? ""))")
            return 1
        }
        logger.say(result.body.isEmpty ? "<empty body>" : result.body)
        return 0
    }

    private static func runCaddy(
        _ args: [String], childEnv: [String: String], runner: any CommandRunner,
        logger: any OpsLogging
    ) async -> Int32 {
        logger.say("$ \(args.joined(separator: " "))")
        do {
            let result = try await runner.run(args, options: RunCmdOptions(env: childEnv))
            let out = result.stdout.trimmingTrailingNewlines()
            let err = result.stderr.trimmingTrailingNewlines()
            if !out.isEmpty { logger.say(out) }
            if !err.isEmpty { logger.say(err) }
            return result.exitCode == 0 ? 0 : 1
        } catch let error as RunCmdError {
            // runAllowFailure semantics: a non-zero exit is a value, not a throw —
            // but run() throws, so surface the captured output + return 1.
            let out = error.stdout.trimmingTrailingNewlines()
            let err = error.stderr.trimmingTrailingNewlines()
            if !out.isEmpty { logger.say(out) }
            if !err.isEmpty { logger.say(err) }
            if error.kind != .exit { logger.error(error.message) }
            return 1
        } catch {
            logger.error("\(error)")
            return 1
        }
    }
}

private func firstNonEmpty(_ values: String?...) -> String {
    for value in values where !(value ?? "").isEmpty { return value ?? "" }
    return ""
}

extension String {
    /// Drop trailing newlines (JS `trimEnd()` on the caddy output).
    fileprivate func trimmingTrailingNewlines() -> String {
        var result = self
        while let last = result.last, last == "\n" || last == "\r" { result.removeLast() }
        return result
    }
}
