// `ops service <verb> <target>` — start/stop/restart/status against the
// launchd-managed daemons. Native port of ops/cmd/service.js.
//
// For `all`, the start order is dependency-aware (web → mcp → tunnels → proxy →
// watchdog, watchdog last so it never observes a half-up backend); stop is the
// reverse so the watchdog isn't kicking services being intentionally taken down.

/// A launchd service verb.
public enum ServiceVerb: String, Sendable, CaseIterable {
    case start, stop, restart, status
}

/// The concrete targets, in dependency-aware START order.
public let serviceStartOrder = ["web", "mcp", "tunnel-web", "tunnel-mcp", "proxy", "watchdog"]
/// Every accepted target token (the six labels plus `all`).
public let serviceTargets = Set(serviceStartOrder + ["all"])

/// A target's launchd label + installed plist path.
public struct ServiceRef: Sendable, Equatable {
    public let label: String
    public let plistPath: String
}

public enum Service {
    /// Resolve a target token to its `{ label, plistPath }`. Returns nil for an
    /// unknown target (mirrors JS throwing on an unknown target).
    public static func resolveTarget(_ target: String, vars: [String: String]) -> ServiceRef? {
        let key: String
        switch target {
            case "proxy": key = "LABEL_PROXY"
            case "web": key = "LABEL_WEB"
            case "mcp": key = "LABEL_MCP"
            case "watchdog": key = "LABEL_WATCHDOG"
            case "tunnel-web": key = "LABEL_TUNNEL_WEB"
            case "tunnel-mcp": key = "LABEL_TUNNEL_MCP"
            default: return nil
        }
        guard let label = vars[key], !label.isEmpty else { return nil }
        return ServiceRef(label: label, plistPath: "/Library/LaunchDaemons/\(label).plist")
    }

    /// Expand `target` into the sequence to act on: `[target]` for a single
    /// target; the start- or stop-ordered list for `all`.
    public static func expandTargets(_ target: String, verb: ServiceVerb) -> [String] {
        if target != "all" { return [target] }
        return verb == .stop ? serviceStartOrder.reversed() : serviceStartOrder
    }

    /// Run a service verb. Returns the process exit code (1 when a non-status
    /// verb had a failure; status always 0). `64` for a usage error.
    public static func run(
        verb: String, target: String, env: LoadedEnv, launchctl: Launchctl,
        logger: any OpsLogging
    ) async -> Int32 {
        guard let parsedVerb = ServiceVerb(rawValue: verb) else {
            logger.error("service: unknown verb \"\(verb)\"")
            return 64
        }
        guard serviceTargets.contains(target) else {
            logger.error("service: unknown target \"\(target)\"")
            return 64
        }

        var failCount = 0
        for concrete in expandTargets(target, verb: parsedVerb) {
            guard let ref = resolveTarget(concrete, vars: env.vars) else {
                failCount += 1
                logger.error("service \(verb) \(concrete): unknown target")
                continue
            }
            do {
                switch parsedVerb {
                    case .start, .restart:
                        try await start(concrete, ref, launchctl: launchctl, logger: logger)
                    case .stop:
                        logger.say("stop service: \(concrete) (\(ref.label))")
                        _ = try await launchctl.bootout(ref.label)
                    case .status:
                        if try await !status(concrete, ref, launchctl: launchctl, logger: logger) {
                            failCount += 1
                        }
                }
                if parsedVerb != .status { logger.say("") }
            } catch {
                failCount += 1
                logger.error("service \(verb) \(concrete): \(error)")
            }
        }
        return failCount > 0 && parsedVerb != .status ? 1 : 0
    }

    private static func start(
        _ target: String, _ ref: ServiceRef, launchctl: Launchctl, logger: any OpsLogging
    ) async throws {
        if try await launchctl.isLoaded(ref.label) {
            logger.say("restart loaded service: \(target) (\(ref.label))")
            _ = try await launchctl.kickstart(ref.label)
        } else {
            logger.say("bootstrap service: \(target) (\(ref.label))")
            _ = try await launchctl.bootstrapOrKick(ref.label, plistPath: ref.plistPath)
        }
    }

    private static func status(
        _ target: String, _ ref: ServiceRef, launchctl: Launchctl, logger: any OpsLogging
    ) async throws -> Bool {
        let result = try await launchctl.printStatus(ref.label)
        logger.say("\(target) (\(ref.label))")
        let source = result.stdout.isEmpty ? result.stderr : result.stdout
        let summary =
            source
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { isInterestingStatusLine(String($0)) }
            .map { "  " + $0.trimmingCharactersASCII() }
            .joined(separator: "\n")
        if !summary.isEmpty {
            logger.say(summary)
        } else if !source.trimmingCharactersASCII().isEmpty {
            logger.say("  " + String(source.trimmingCharactersASCII().prefix(512)))
        }
        return result.exitCode == 0
    }
}

/// The status lines `service status` keeps (JS `/state =|pid =|last exit code =|path =/`).
private func isInterestingStatusLine(_ line: String) -> Bool {
    line.contains("state =") || line.contains("pid =") || line.contains("last exit code =")
        || line.contains("path =")
}

extension StringProtocol {
    /// Trim ASCII leading/trailing whitespace (space/tab/CR/LF).
    fileprivate func trimmingCharactersASCII() -> String {
        var scalars = Array(unicodeScalars)
        let isSpace: (Unicode.Scalar) -> Bool = { $0 == " " || $0 == "\t" || $0 == "\r" || $0 == "\n" }
        while let first = scalars.first, isSpace(first) { scalars.removeFirst() }
        while let last = scalars.last, isSpace(last) { scalars.removeLast() }
        var out = ""
        out.unicodeScalars.append(contentsOf: scalars)
        return out
    }
}
