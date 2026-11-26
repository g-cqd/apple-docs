import Foundation

/// A request target split into its path and decoded query parameters (`+` and percent escapes decoded).
struct WebRequestTarget: Sendable {
    let path: String
    let query: [String: String]

    init(path: String, query: [String: String]) {
        self.path = path
        self.query = query
    }

    init(_ target: String) {
        guard let qIndex = target.firstIndex(of: "?") else {
            self.path = target
            self.query = [:]
            return
        }
        self.path = String(target[..<qIndex])
        var params: [String: String] = [:]
        for pair in target[target.index(after: qIndex)...].split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1)
            guard let rawKey = parts.first, !rawKey.isEmpty else { continue }
            let key = String(rawKey).removingPercentEncoding ?? String(rawKey)
            let rawValue = parts.count > 1 ? String(parts[1]) : ""
            let spaced = rawValue.replacing("+", with: " ")
            params[key] = spaced.removingPercentEncoding ?? spaced
        }
        self.query = params
    }
}
