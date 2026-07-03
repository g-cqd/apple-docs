// Operator-facing logger for the ops verbs — the native port of ops/lib/logger.js.
//
// Mirrors the `say()` / `run()` idiom every bash ops script used:
//   say "stopping …"  → [2026-05-13T02:31:02+02:00] stopping …
//   run launchctl …   → [2026-05-13T02:31:02+02:00] $ launchctl …
// Output goes to a process stream (stderr by default) and, optionally, a
// per-command log file. Every write passes through `redactSensitive` so bearer
// tokens / HTTP auth headers from a subprocess's stdout never land on disk.

// `public import` because OpsLogger's public initializer exposes Foundation's
// `Date` (the injected clock) and `TimeZone` in its signature.
public import Foundation

/// The logger surface the ops verbs write through.
public protocol OpsLogging: Sendable {
    func say(_ message: String)
    func warn(_ message: String)
    func error(_ message: String)
    func runStart(_ command: String, _ arguments: [String])
    func runOutput(_ text: String)
    var logPath: String? { get }
}

/// A logger that timestamps every line and (optionally) tees to a log file.
public final class OpsLogger: OpsLogging, Sendable {
    private let sink: @Sendable (String) -> Void
    private let clock: @Sendable () -> Date
    private let timeZone: TimeZone
    public let logPath: String?
    private let lock = NSLock()

    /// - Parameters:
    ///   - logPath: file to append to; `nil` disables file logging.
    ///   - sink: where formatted lines go (default: stderr).
    ///   - clock: the wall clock (default: `Date()`); injected in tests.
    ///   - timeZone: the timezone for the ISO-offset stamp (default: `.current`).
    public init(
        logPath: String? = nil,
        sink: @escaping @Sendable (String) -> Void = OpsLogger.stderrSink,
        clock: @escaping @Sendable () -> Date = { Date() },
        timeZone: TimeZone = .current
    ) {
        self.logPath = logPath
        self.sink = sink
        self.clock = clock
        self.timeZone = timeZone
        if let logPath {
            let dir = (logPath as NSString).deletingLastPathComponent
            if !dir.isEmpty {
                try? FileManager.default.createDirectory(
                    atPath: dir, withIntermediateDirectories: true)
            }
        }
    }

    public func say(_ message: String) { write(format(prefix: "", message)) }
    public func warn(_ message: String) { write(format(prefix: "WARN: ", message)) }
    public func error(_ message: String) { write(format(prefix: "ERROR: ", message)) }

    public func runStart(_ command: String, _ arguments: [String]) {
        let formatted = ([command] + arguments).joined(separator: " ")
        write(format(prefix: "$ ", formatted))
    }

    public func runOutput(_ text: String) {
        // Subcommand output is already line-terminated; pass it through verbatim
        // (still redacted inside `write`).
        if text.isEmpty { return }
        write(text)
    }

    private func format(prefix: String, _ message: String) -> String {
        "[\(isoOffset(clock(), timeZone: timeZone))] \(prefix)\(message)\n"
    }

    private func write(_ line: String) {
        let safe = redactSensitive(line)
        lock.lock()
        defer { lock.unlock() }
        sink(safe)
        if let logPath {
            appendToFile(logPath, safe)
        }
    }

    /// The default stderr sink.
    public static let stderrSink: @Sendable (String) -> Void = { line in
        FileHandle.standardError.write(Data(line.utf8))
    }
}

/// Append text to a file (O_APPEND|O_CREAT), best-effort.
private func appendToFile(_ path: String, _ text: String) {
    let fd = path.withCString { open($0, O_WRONLY | O_APPEND | O_CREAT, mode_t(0o644)) }
    guard fd >= 0 else { return }
    defer { close(fd) }
    let bytes = Array(text.utf8)
    bytes.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
            let n = write(fd, raw.baseAddress?.advanced(by: offset), raw.count - offset)
            if n <= 0 { break }
            offset += n
        }
    }
}

// MARK: - ISO-offset timestamp

/// Format a `Date` as `2026-05-13T02:31:02+02:00` in `timeZone` — the shape the
/// bash `date -Iseconds` produced (the log scrapers expect it). Port of
/// logger.js `isoOffset`.
func isoOffset(_ date: Date, timeZone: TimeZone) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let parts = calendar.dateComponents(
        [.year, .month, .day, .hour, .minute, .second], from: date)
    func pad(_ value: Int) -> String {
        let string = String(value)
        return string.count >= 2 ? string : "0" + string
    }
    let offsetSeconds = timeZone.secondsFromGMT(for: date)
    let sign = offsetSeconds >= 0 ? "+" : "-"
    let absMinutes = abs(offsetSeconds) / 60
    let tzHour = pad(absMinutes / 60)
    let tzMinute = pad(absMinutes % 60)
    let year = String(parts.year ?? 0)
    return
        "\(year)-\(pad(parts.month ?? 0))-\(pad(parts.day ?? 0))T"
        + "\(pad(parts.hour ?? 0)):\(pad(parts.minute ?? 0)):\(pad(parts.second ?? 0))"
        + "\(sign)\(tzHour):\(tzMinute)"
}

// MARK: - redaction

/// Redact common credential shapes from arbitrary text before it lands on disk.
/// Port of logger.js `redactSensitive` — HTTP auth/cookie headers, JSON secret
/// values, and URL query credentials each become `<redacted>`.
public func redactSensitive(_ text: String) -> String {
    if text.isEmpty { return text }
    var result = text
    for (regex, template) in redactionRules {
        let range = NSRange(result.startIndex ..< result.endIndex, in: result)
        result = regex.stringByReplacingMatches(
            in: result, options: [], range: range, withTemplate: template)
    }
    return result
}

/// The compiled redaction rules, shared across the process (the SDK's
/// `NSRegularExpression` is `Sendable`).
private let redactionRules: [(NSRegularExpression, String)] = {
    let patterns: [(String, String)] = [
        // HTTP-style headers (name preceded by start-of-string or punctuation).
        (
            "((?:^|[^A-Za-z])(?:authorization|cookie|x-api-key|x-auth-token|x-cloudflare-token|x-amz-security-token)\\s*:\\s*)[^\\r\\n]+",
            "$1<redacted>"
        ),
        // JSON-ish "key": "value" pairs.
        (
            "([\"'](?:token|secret|authorization|cookie|password|api[_-]?key|bearer)[\"']\\s*:\\s*[\"'])[^\"'\\\\]+([\"'])",
            "$1<redacted>$2"
        ),
        // URL query-string fragments.
        (
            "([?&](?:token|secret|api[_-]?key|access[_-]?token|auth)=)[^&\\s]+",
            "$1<redacted>"
        )
    ]
    return patterns.compactMap { pattern, template in
        guard
            let regex = try? NSRegularExpression(
                pattern: pattern, options: [.caseInsensitive])
        else { return nil }
        return (regex, template)
    }
}()
