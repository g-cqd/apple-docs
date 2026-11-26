/// Enforces bans on legacy concurrency, non-deterministic test sleeps, and Darwin leaks.
enum BannedAPIs {
    struct Rule: Sendable {
        let name: String
        let needles: [String]
        let reason: String
    }

    static let universalRules: [Rule] = [
        Rule(
            name: "Grand Central Dispatch",
            needles: [
                "import Dispatch", "DispatchQueue", "DispatchSource",
                "DispatchSemaphore", "DispatchGroup", "DispatchWorkItem",
                "DispatchTime", "DispatchIO"
            ],
            reason: "use Swift Concurrency, Synchronization.Mutex, or Atomic instead of GCD"
        )
    ]

    static let testOnlyRules: [Rule] = [
        Rule(
            name: "Sleeps in tests",
            needles: ["Task.sleep", "Thread.sleep", "usleep("],
            reason: "inject controllable clocks or event continuations for deterministic tests"
        )
    ]

    static let crossPlatformDarwinRules: [Rule] = [
        Rule(
            name: "Darwin UI/AppKit frameworks in cross-platform targets",
            needles: ["import AppKit", "import CoreText", "import CoreGraphics", "import ImageIO", "import SwiftUI"],
            reason: "keep macOS-only frameworks isolated inside AppleDocsSetupDarwin behind #if os(macOS)"
        )
    ]

    /// Returns one finding per banned needle match across `files`.
    static func problems(in files: [(path: String, text: String)], rules: [Rule]) -> [String] {
        var findings: [String] = []
        for file in files {
            for (index, line) in file.text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                for rule in rules {
                    for needle in rule.needles where line.contains(needle) {
                        findings.append("\(file.path):\(index + 1): \(needle) (\(rule.name): \(rule.reason))")
                    }
                }
            }
        }
        return findings
    }
}
