// HTTP probe used by smoke-test / proxy status / watchdog readiness — the native
// port of ops/lib/http-probe.js. Bounds every request with a hard deadline,
// caps the captured body, and NEVER throws: it always resolves to a structured
// `ProbeResult` so callers can aggregate. `HTTPProbing` is the injection seam.

private import Foundation

/// How a probe resolved.
public enum ProbeOutcome: Sendable, Equatable {
    case http
    case timeout
    case network
}

/// A structured probe outcome (never an exception).
public struct ProbeResult: Sendable, Equatable {
    public let ok: Bool
    /// The HTTP status, or `nil` when the request never resolved.
    public let status: Int?
    public let elapsedMs: Int
    /// The response body, truncated to `bodyMaxBytes`.
    public let body: String
    public let outcome: ProbeOutcome
    public let url: String
    /// Reason text for non-http outcomes.
    public let error: String?

    public init(
        ok: Bool, status: Int?, elapsedMs: Int, body: String, outcome: ProbeOutcome, url: String,
        error: String? = nil
    ) {
        self.ok = ok
        self.status = status
        self.elapsedMs = elapsedMs
        self.body = body
        self.outcome = outcome
        self.url = url
        self.error = error
    }
}

/// Options for one probe.
public struct ProbeOptions: Sendable {
    public var expectedStatus: Int
    public var deadlineMs: Int
    public var bodyMaxBytes: Int
    public var method: String
    public var headers: [String: String]?
    public var body: String?

    public init(
        expectedStatus: Int = 200,
        deadlineMs: Int = 5_000,
        bodyMaxBytes: Int = 32 * 1024,
        method: String = "GET",
        headers: [String: String]? = nil,
        body: String? = nil
    ) {
        self.expectedStatus = expectedStatus
        self.deadlineMs = deadlineMs
        self.bodyMaxBytes = bodyMaxBytes
        self.method = method
        self.headers = headers
        self.body = body
    }
}

/// The HTTP probe seam. Never throws.
public protocol HTTPProbing: Sendable {
    func probe(_ url: String, options: ProbeOptions) async -> ProbeResult
}

extension HTTPProbing {
    public func probe(_ url: String) async -> ProbeResult {
        await probe(url, options: ProbeOptions())
    }
}

/// The production probe over `URLSession`.
public struct URLSessionProbe: HTTPProbing {
    private let nowMs: @Sendable () -> Double
    private let session: URLSession

    public init(nowMs: @escaping @Sendable () -> Double = URLSessionProbe.systemNowMs) {
        self.nowMs = nowMs
        self.session = URLSession(configuration: .ephemeral)
    }

    /// Wall clock in epoch-millis (body uses Foundation; the type does not).
    public static let systemNowMs: @Sendable () -> Double = {
        Date().timeIntervalSince1970 * 1000
    }

    public func probe(_ url: String, options: ProbeOptions) async -> ProbeResult {
        let started = nowMs()
        guard let requestURL = URL(string: url) else {
            return ProbeResult(
                ok: false, status: nil, elapsedMs: 0, body: "", outcome: .network, url: url,
                error: "invalid url")
        }
        var request = URLRequest(url: requestURL)
        request.httpMethod = options.method
        request.timeoutInterval = Double(options.deadlineMs) / 1000
        if let headers = options.headers {
            for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        }
        if let body = options.body { request.httpBody = Data(body.utf8) }

        do {
            let (data, response) = try await session.data(for: request)
            let elapsed = Int(nowMs() - started)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let capped = data.count > options.bodyMaxBytes ? data.prefix(options.bodyMaxBytes) : data[...]
            let body = String(decoding: capped, as: UTF8.self)
            return ProbeResult(
                ok: status == options.expectedStatus, status: status, elapsedMs: elapsed,
                body: body, outcome: .http, url: url)
        } catch {
            let elapsed = Int(nowMs() - started)
            let urlError = error as? URLError
            let timedOut = urlError?.code == .timedOut || urlError?.code == .cancelled
            return ProbeResult(
                ok: false, status: nil, elapsedMs: elapsed, body: "",
                outcome: timedOut ? .timeout : .network, url: url,
                error: (error as NSError).localizedDescription)
        }
    }
}

/// One-liner formatter matching the bash smoke-test output shape.
public func formatProbeLine(_ result: ProbeResult) -> String {
    let status = result.status.map(String.init) ?? outcomeLabel(result.outcome)
    let mark = result.ok ? "✓" : "✗"
    let errorSuffix = result.error.map { " — \($0)" } ?? ""
    return "  \(mark) \(result.url) → \(status) (\(result.elapsedMs)ms\(errorSuffix))"
}

private func outcomeLabel(_ outcome: ProbeOutcome) -> String {
    switch outcome {
        case .http: return "http"
        case .timeout: return "timeout"
        case .network: return "network"
    }
}
