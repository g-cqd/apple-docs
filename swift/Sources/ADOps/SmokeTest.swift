// `ops smoke-test` — the smoke-test battery for a live deploy. Native port of
// ops/cmd/smoke-test.js: a bounded readiness gate on the LOCAL daemons, healthz
// probes against local + edge web/mcp, and a staggered concurrency burst of
// search_docs calls with healthz sampling. Exit 0 when everything passes; 1 if
// anything fails. Every seam (probe/sleep/clock) is injected so the battery
// unit-tests without a live server.

private import Foundation

/// Injected seams for the smoke battery.
public struct SmokeDeps: Sendable {
    public var http: any HTTPProbing
    public var sleep: @Sendable (Int) async -> Void
    public var nowMs: @Sendable () -> Double

    public init(
        http: any HTTPProbing,
        sleep: @escaping @Sendable (Int) async -> Void = SmokeDeps.systemSleep,
        nowMs: @escaping @Sendable () -> Double = ProcessCommandRunner.systemNowMs
    ) {
        self.http = http
        self.sleep = sleep
        self.nowMs = nowMs
    }

    /// `Task.sleep`-backed default (milliseconds).
    public static let systemSleep: @Sendable (Int) async -> Void = { ms in
        try? await Task.sleep(nanoseconds: UInt64(max(0, ms)) * 1_000_000)
    }
}

public enum SmokeTest {
    public static func run(env: LoadedEnv, deps: SmokeDeps, logger: any OpsLogging) async -> Int32 {
        let vars = env.vars
        let burstSize = parseIntEnv(vars["SMOKE_BURST_SIZE"], 16)
        let burstStaggerMs = parseIntEnv(vars["SMOKE_BURST_STAGGER_MS"], 10)
        let healthzSamples = parseIntEnv(vars["SMOKE_HEALTHZ_SAMPLES"], 5)
        let readyTimeoutMs = parseIntEnv(vars["SMOKE_READY_TIMEOUT_MS"], 180_000)
        let readyPollMs = parseIntEnv(vars["SMOKE_READY_POLL_MS"], 5_000)

        var failed = 0

        // 0. Readiness gate on the local daemons.
        _ = await waitForLocalReadiness(
            urls: [
                "http://127.0.0.1:\(vars["WEB_PORT"] ?? "")/healthz",
                "http://127.0.0.1:\(vars["MCP_PORT"] ?? "")/healthz"
            ], timeoutMs: readyTimeoutMs, pollMs: readyPollMs, deps: deps, logger: logger)

        // 1. Healthz probes (local + edge).
        failed += await healthzProbes(vars: vars, deps: deps, logger: logger)

        // 2 + 3. Concurrency probe.
        logger.say("")
        logger.say(
            "concurrency probe (\(burstSize)x search_docs staggered \(burstStaggerMs)ms "
                + "+ healthz sampling):")
        let mcpEndpoint = "http://127.0.0.1:\(vars["MCP_PORT"] ?? "")/mcp"

        // Warmup so the first burst request doesn't pay cold-cache cost.
        _ = await issueSearchDocs(mcpEndpoint, query: "smoke-warmup", id: 0, deadlineMs: 15_000, deps: deps)

        var burstTasks: [Task<ProbeResult, Never>] = []
        for index in 1 ... max(1, burstSize) {
            let query = "probe-\(index)-\(Int(deps.nowMs()))"
            let http = deps.http
            burstTasks.append(
                Task {
                    await issueSearchDocs(
                        mcpEndpoint, query: query, id: index, deadlineMs: 30_000, deps: SmokeDeps(http: http))
                })
            if burstStaggerMs > 0, index < burstSize { await deps.sleep(burstStaggerMs) }
        }

        failed += await sampleHealthzDuringBurst(
            vars: vars, samples: healthzSamples, deps: deps, logger: logger)

        var burstFail = 0
        for (offset, task) in burstTasks.enumerated() {
            let result = await task.value
            if !isSuccess2xx(result.status) {
                burstFail += 1
                logger.say("  req \(offset + 1) failed: HTTP \(result.status.map(String.init) ?? "000")")
            }
        }
        logger.say("  burst: \(burstSize) requests, \(burstFail) failures")
        if burstFail > 0 { failed += 1 }

        return failed > 0 ? 1 : 0
    }

    /// Poll the local healthz endpoints until all answer 2xx/3xx or the attempt
    /// budget runs out. Attempt-bounded (never spins forever under a fake clock).
    private static func waitForLocalReadiness(
        urls: [String], timeoutMs: Int, pollMs: Int, deps: SmokeDeps, logger: any OpsLogging
    ) async -> Bool {
        let start = deps.nowMs()
        let maxAttempts = max(1, (timeoutMs + pollMs - 1) / pollMs)
        for attempt in 1 ... maxAttempts {
            var pending: [String] = []
            for url in urls {
                let result = await deps.http.probe(url, options: ProbeOptions(deadlineMs: 5_000))
                if !isReady2xx3xx(result.status) { pending.append(url) }
            }
            if pending.isEmpty {
                if attempt > 1 {
                    let secs = Int((deps.nowMs() - start) / 1000)
                    logger.say("local daemons ready after \(secs)s (\(attempt) probes)")
                }
                return true
            }
            if attempt == maxAttempts { break }
            if attempt == 1 || attempt % 6 == 0 {
                logger.say(
                    "waiting for local readiness (attempt \(attempt)/\(maxAttempts)): "
                        + pending.joined(separator: ", "))
            }
            await deps.sleep(pollMs)
        }
        logger.warn("local daemons not ready after ~\(timeoutMs / 1000)s — asserting current state")
        return false
    }

    private static func healthzProbes(
        vars: [String: String], deps: SmokeDeps, logger: any OpsLogging
    ) async -> Int {
        let targets: [(label: String, url: String)] = [
            ("local web", "http://127.0.0.1:\(vars["WEB_PORT"] ?? "")/healthz"),
            ("local mcp", "http://127.0.0.1:\(vars["MCP_PORT"] ?? "")/healthz"),
            ("edge  web", "https://\(vars["PUBLIC_WEB_HOST"] ?? "")/healthz"),
            ("edge  mcp", "https://\(vars["PUBLIC_MCP_HOST"] ?? "")/healthz")
        ]
        var failed = 0
        for target in targets {
            let result = await deps.http.probe(target.url, options: ProbeOptions(deadlineMs: 10_000))
            let status = result.status.map(String.init) ?? outcomeText(result.outcome)
            logger.say("\(target.label.padTo(10)) \(target.url) -> HTTP \(status)")
            if !isReady2xx3xx(result.status) { failed += 1 }
        }
        return failed
    }

    private static func sampleHealthzDuringBurst(
        vars: [String: String], samples: Int, deps: SmokeDeps, logger: any OpsLogging
    ) async -> Int {
        var healthyCount = 0
        var codes: [String] = []
        for _ in 0 ..< samples {
            let result = await deps.http.probe(
                "http://127.0.0.1:\(vars["MCP_PORT"] ?? "")/healthz",
                options: ProbeOptions(deadlineMs: 3_000))
            codes.append(result.status.map(String.init) ?? outcomeText(result.outcome))
            if isSuccess2xx(result.status) { healthyCount += 1 }
            await deps.sleep(200)
        }
        logger.say("  healthz during burst -> \(healthyCount)/\(samples) 2xx [\(codes.joined(separator: " "))]")
        return healthyCount == 0 ? 1 : 0
    }

    private static func issueSearchDocs(
        _ url: String, query: String, id: Int, deadlineMs: Int, deps: SmokeDeps
    ) async -> ProbeResult {
        let body =
            "{\"jsonrpc\":\"2.0\",\"id\":\(id),\"method\":\"tools/call\","
            + "\"params\":{\"name\":\"search_docs\",\"arguments\":{\"query\":\(jsonString(query)),\"limit\":5}}}"
        return await deps.http.probe(
            url,
            options: ProbeOptions(
                deadlineMs: deadlineMs, method: "POST",
                headers: [
                    "content-type": "application/json",
                    "accept": "application/json, text/event-stream"
                ], body: body))
    }
}

// MARK: - helpers

private func isSuccess2xx(_ status: Int?) -> Bool {
    guard let status else { return false }
    return status >= 200 && status < 300
}

private func isReady2xx3xx(_ status: Int?) -> Bool {
    guard let status else { return false }
    return status >= 200 && status < 400
}

private func parseIntEnv(_ value: String?, _ fallback: Int) -> Int {
    let trimmed = (value ?? "").trimmingCharacters(in: .whitespaces)
    guard let parsed = Int(trimmed), parsed > 0 else { return fallback }
    return parsed
}

private func outcomeText(_ outcome: ProbeOutcome) -> String {
    switch outcome {
        case .http: return "http"
        case .timeout: return "timeout"
        case .network: return "network"
    }
}

/// JSON-encode a string value (adds quotes + escapes) via Foundation.
private func jsonString(_ value: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: [value]),
        let array = String(data: data, encoding: .utf8)
    else { return "\"\"" }
    // strip the surrounding [ ] of the single-element array.
    return String(array.dropFirst().dropLast())
}

extension String {
    /// Right-pad with spaces to `width` (JS `padEnd`).
    fileprivate func padTo(_ width: Int) -> String {
        count >= width ? self : self + String(repeating: " ", count: width - count)
    }
}
