public import AemiHTTP
import AppleDocsCore
import Synchronization

/// In-process RED metrics (rate, errors, duration) for the HTTP servers, rendered in the Prometheus text
/// exposition format (0.0.4).
///
/// Label cardinality is bounded by construction: paths collapse to one of the configured route prefixes
/// (longest match on a segment boundary, query stripped) or `other`, methods to the standard verbs or
/// `OTHER`, so hostile URLs can never grow the series set.
public final class HTTPMetricsRegistry: HTTPMetrics, Sendable {
    /// Histogram bucket upper bounds, in seconds.
    public static let bucketBounds: [Double] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]

    private struct CounterKey: Hashable {
        let method: String
        let route: String
        let status: Int
    }

    private struct Histogram {
        var buckets = [Int](repeating: 0, count: HTTPMetricsRegistry.bucketBounds.count)
        var count = 0
        var sum = 0.0
    }

    private struct State {
        var counters: [CounterKey: Int] = [:]
        var histograms: [String: Histogram] = [:]
    }

    private let routes: [String]
    private let state = Mutex(State())

    /// - Parameter routes: path prefixes that become `route` labels (e.g. `/doc`, `/api/search`, `/`).
    public init(routes: [String]) {
        self.routes = routes.sorted { $0.count > $1.count }
    }

    public func record(method: HTTPMethod, path: String, status: HTTPStatus, duration: Duration) {
        let key = CounterKey(method: Self.methodLabel(method), route: route(for: path), status: Int(status.code))
        let components = duration.components
        let seconds = max(0, Double(components.seconds) + Double(components.attoseconds) / 1e18)
        state.withLock { state in
            state.counters[key, default: 0] += 1
            var histogram = state.histograms[key.route] ?? Histogram()
            histogram.count += 1
            histogram.sum += seconds
            for (index, bound) in Self.bucketBounds.enumerated() where seconds <= bound {
                histogram.buckets[index] += 1
            }
            state.histograms[key.route] = histogram
        }
    }

    /// The route label for `path`: the longest configured prefix ending on a segment boundary, else `other`.
    public func route(for path: String) -> String {
        let bare =
            path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? path
        for prefix in routes {
            if prefix == "/" {
                if bare == "/" { return prefix }
                continue
            }
            if bare == prefix || bare.hasPrefix(prefix + "/") { return prefix }
        }
        return "other"
    }

    /// The Prometheus text exposition of every series, sorted for stable output.
    public func renderPrometheus() -> String {
        let snapshot = state.withLock { $0 }
        var lines = [
            "# HELP apple_docs_build_info apple-docs build information.",
            "# TYPE apple_docs_build_info gauge",
            "apple_docs_build_info{version=\"\(AppleDocsVersion.current)\"} 1",
            "# HELP apple_docs_http_requests_total Completed HTTP responses.",
            "# TYPE apple_docs_http_requests_total counter"
        ]
        let counters = snapshot.counters.sorted {
            ($0.key.route, $0.key.method, $0.key.status) < ($1.key.route, $1.key.method, $1.key.status)
        }
        for (key, value) in counters {
            lines.append(
                "apple_docs_http_requests_total{method=\"\(key.method)\",route=\"\(key.route)\",status=\"\(key.status)\"} \(value)"
            )
        }
        lines.append("# HELP apple_docs_http_request_duration_seconds Time to produce the response head.")
        lines.append("# TYPE apple_docs_http_request_duration_seconds histogram")
        for (route, histogram) in snapshot.histograms.sorted(by: { $0.key < $1.key }) {
            let name = "apple_docs_http_request_duration_seconds"
            for (index, bound) in Self.bucketBounds.enumerated() {
                lines.append("\(name)_bucket{route=\"\(route)\",le=\"\(bound.formatted)\"} \(histogram.buckets[index])")
            }
            lines.append("\(name)_bucket{route=\"\(route)\",le=\"+Inf\"} \(histogram.count)")
            lines.append("\(name)_sum{route=\"\(route)\"} \(histogram.sum)")
            lines.append("\(name)_count{route=\"\(route)\"} \(histogram.count)")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    private static func methodLabel(_ method: HTTPMethod) -> String {
        switch method {
            case .get: "GET"
            case .head: "HEAD"
            case .post: "POST"
            case .put: "PUT"
            case .delete: "DELETE"
            case .options: "OPTIONS"
            default: "OTHER"
        }
    }
}

extension Double {
    /// Shortest decimal form without a trailing `.0` for whole numbers (`1`, `2.5`, `0.005`).
    fileprivate var formatted: String {
        self == rounded() ? String(Int(self)) : String(self)
    }
}
