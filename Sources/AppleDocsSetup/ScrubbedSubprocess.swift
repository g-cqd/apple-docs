import Foundation
import Subprocess

#if canImport(System)
    import System
#elseif canImport(SystemPackage)
    import SystemPackage
#endif

/// Hardened subprocess runner backed by `swiftlang/swift-subprocess` (Threat Model T-05).
///
/// Enforces:
/// - Argv-only execution (zero shell interpolation).
/// - Scrubbed environment allowlist (`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL` only) so operator
///   credentials like `GITHUB_TOKEN` never leak into helper tools (`tar`, `zstd`, `hdiutil`, `pkgutil`).
/// - Bounded stdout/stderr collection caps.
public enum ScrubbedSubprocess: Sendable {
    /// Result returned by a completed subprocess invocation.
    public struct Outcome: Hashable, Sendable {
        public let exitCode: Int32
        public let stdout: String
        public let stderr: String
    }

    /// Standard environment keys permitted to pass into child setup processes.
    public static let defaultAllowedEnvKeys: Set<String> = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]

    /// Builds a scrubbed environment dictionary retaining only `allowedKeys`.
    public static func scrubbedEnvironment(
        from source: [String: String]? = nil,
        allowedKeys: Set<String> = defaultAllowedEnvKeys
    ) -> [String: String] {
        let env = source ?? ProcessInfo.processInfo.environment
        var filtered: [String: String] = [:]
        for key in allowedKeys {
            if let value = env[key] {
                filtered[key] = value
            }
        }
        if filtered["PATH"] == nil {
            filtered["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        }
        return filtered
    }

    /// Executes `executable` requiring exit status `0`, returning standard output or throwing
    /// ``SetupError/commandFailed(tool:exitCode:stderr:)``.
    public static func runChecked(
        executable: String,
        arguments: [String],
        toolLabel: String? = nil,
        maxOutputBytes: Int = 1_048_576
    ) async throws(SetupError) -> String {
        let outcome = try await run(executable: executable, arguments: arguments, maxOutputBytes: maxOutputBytes)
        guard outcome.exitCode == 0 else {
            throw .commandFailed(tool: toolLabel ?? executable, exitCode: outcome.exitCode, stderr: outcome.stderr)
        }
        return outcome.stdout
    }

    /// Executes `executable` (by name via `PATH` or absolute path) with scrubbed environment and capped output.
    public static func run(
        executable: String,
        arguments: [String],
        maxOutputBytes: Int = 1_048_576
    ) async throws(SetupError) -> Outcome {
        let envMap = scrubbedEnvironment()
        var rawEnv: [Environment.Key: String] = [:]
        for (key, value) in envMap {
            if let envKey = Environment.Key(rawValue: key) {
                rawEnv[envKey] = value
            }
        }
        let exec: Executable = executable.hasPrefix("/") ? .path(FilePath(executable)) : .name(executable)
        do {
            let result = try await Subprocess.run(
                exec,
                arguments: Arguments(arguments),
                environment: .custom(rawEnv),
                output: .string(limit: maxOutputBytes),
                error: .string(limit: maxOutputBytes)
            )
            let code: Int32 =
                switch result.terminationStatus {
                    case .exited(let status): status
                    case .signaled(let signal): -signal
                }
            return Outcome(
                exitCode: code,
                stdout: result.standardOutput,
                stderr: result.standardError
            )
        } catch {
            throw .ioFailure("Subprocess '\(executable)' failed to launch: \(error)")
        }
    }
}
