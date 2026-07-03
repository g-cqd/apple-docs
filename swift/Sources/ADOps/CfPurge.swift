// `ops cf-purge` — wipe the Cloudflare edge cache. Native port of
// ops/cmd/cf-purge.js.
//
// Soft-fails (exit 0 + warn) when the token/zone isn't configured (the dev
// default). Returns non-zero only when the token IS set but the API call
// returned a non-success payload. Credentials come from the process env first
// (a CI runner may pass them without landing them in ops/.env), then ops/.env.

private import Foundation

private let cloudflareAPIBase = "https://api.cloudflare.com/client/v4"

public enum CfPurge {
    /// Purge the zone. `processEnv` credentials win over `loadedVars` (the
    /// ops/.env bag, or nil when .env is absent/invalid).
    public static func run(
        processEnv: [String: String], loadedVars: [String: String]?, http: any HTTPProbing,
        logger: any OpsLogging
    ) async -> Int32 {
        let token = processEnv["CLOUDFLARE_API_TOKEN"] ?? loadedVars?["CLOUDFLARE_API_TOKEN"]
        let zone = processEnv["CLOUDFLARE_ZONE_ID"] ?? loadedVars?["CLOUDFLARE_ZONE_ID"]

        guard let token, !token.isEmpty, let zone, !zone.isEmpty else {
            logger.warn(
                "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID not set — skipping edge purge. "
                    + "Stale /api/search and /api/filters may persist at the edge for up to 5 min.")
            return 0
        }

        logger.say("purging zone \(String(zone.prefix(8)))…")
        let url = "\(cloudflareAPIBase)/zones/\(percentEncode(zone))/purge_cache"
        let result = await http.probe(
            url,
            options: ProbeOptions(
                expectedStatus: 200, deadlineMs: 30_000, method: "POST",
                headers: ["Authorization": "Bearer \(token)", "Content-Type": "application/json"],
                body: "{\"purge_everything\":true}"))

        if !result.ok {
            logger.error("Cloudflare purge failed: \(outcomeText(result.outcome)) status=\(statusText(result.status))")
            if !result.body.isEmpty { logger.error(String(result.body.prefix(512))) }
            return 1
        }
        // Cloudflare can return HTTP 200 with success:false on auth failures.
        guard cloudflareReportedSuccess(result.body) else {
            logger.error("Cloudflare purge response did not report success")
            if !result.body.isEmpty { logger.error(String(result.body.prefix(512))) }
            return 1
        }
        logger.say("purge ok")
        return 0
    }

    /// Parse the CF response body and check `success === true`. Exposed for tests.
    public static func cloudflareReportedSuccess(_ body: String) -> Bool {
        guard let data = body.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return (object["success"] as? Bool) == true
    }
}

private func percentEncode(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
}

private func statusText(_ status: Int?) -> String { status.map(String.init) ?? "nil" }

private func outcomeText(_ outcome: ProbeOutcome) -> String {
    switch outcome {
        case .http: return "http"
        case .timeout: return "timeout"
        case .network: return "network"
    }
}
