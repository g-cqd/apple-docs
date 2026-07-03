import Foundation
import Testing

@testable import ADOps

// Unit coverage for the operator logger (ops/lib/logger.js): the `date -Iseconds`
// timestamp shape, credential redaction, and the say/warn/error/run formatting.

// A fixed instant: Unix 1_700_000_000 = 2023-11-14T22:13:20Z.
private let fixedInstant = Date(timeIntervalSince1970: 1_700_000_000)

@Test func isoOffsetUTC() {
    #expect(isoOffset(fixedInstant, timeZone: fixedZone(0)) == "2023-11-14T22:13:20+00:00")
}

@Test func isoOffsetPositiveOffset() {
    #expect(isoOffset(fixedInstant, timeZone: fixedZone(7200)) == "2023-11-15T00:13:20+02:00")
}

@Test func isoOffsetNegativeOffset() {
    #expect(isoOffset(fixedInstant, timeZone: fixedZone(-18000)) == "2023-11-14T17:13:20-05:00")
}

@Test func isoOffsetHalfHourZone() {
    // +05:30 (India) — exercises the minute component of the offset.
    #expect(isoOffset(fixedInstant, timeZone: fixedZone(19800)) == "2023-11-15T03:43:20+05:30")
}

private func fixedZone(_ seconds: Int) -> TimeZone {
    TimeZone(secondsFromGMT: seconds) ?? .gmt
}

// MARK: - redaction

@Test func redactsHttpAuthorizationHeader() {
    #expect(redactSensitive("Authorization: Bearer abc.def.ghi") == "Authorization: <redacted>")
}

@Test func redactsCurlStyleHeaderWithPrefix() {
    // curl verbose `> ` prefix — the space before the header name is preserved.
    let input = "> authorization: Bearer tok123"
    #expect(redactSensitive(input) == "> authorization: <redacted>")
}

@Test func redactsJsonSecretValue() {
    #expect(
        redactSensitive("{\"token\": \"s3cr3t\", \"ok\": true}")
            == "{\"token\": \"<redacted>\", \"ok\": true}")
}

@Test func redactsUrlQueryCredential() {
    #expect(
        redactSensitive("GET https://api/x?token=abc123&page=2")
            == "GET https://api/x?token=<redacted>&page=2")
}

@Test func leavesBenignTextUntouched() {
    let input = "rendered: /ops/launchd/x.plist → ok (42 bytes)"
    #expect(redactSensitive(input) == input)
}

// MARK: - formatting

@Test func sayFormatsTimestampedLine() {
    let (logger, captured) = makeCapturingLogger()
    logger.say("stopping mt.everest.apple-docs.web")
    #expect(captured.value == ["[2023-11-15T00:13:20+02:00] stopping mt.everest.apple-docs.web\n"])
}

@Test func warnAndErrorPrefixes() {
    let (logger, captured) = makeCapturingLogger()
    logger.warn("careful")
    logger.error("boom")
    #expect(captured.value[0] == "[2023-11-15T00:13:20+02:00] WARN: careful\n")
    #expect(captured.value[1] == "[2023-11-15T00:13:20+02:00] ERROR: boom\n")
}

@Test func runStartFormatsCommand() {
    let (logger, captured) = makeCapturingLogger()
    logger.runStart("/bin/launchctl", ["bootout", "system/foo"])
    #expect(captured.value == ["[2023-11-15T00:13:20+02:00] $ /bin/launchctl bootout system/foo\n"])
}

@Test func runOutputRedactsBeforeSink() {
    let (logger, captured) = makeCapturingLogger()
    logger.runOutput("Authorization: Bearer leak\n")
    #expect(captured.value == ["Authorization: <redacted>\n"])
}

/// A logger wired to a fixed clock (+02:00) writing into a captured buffer.
private func makeCapturingLogger() -> (OpsLogger, LineBuffer) {
    let buffer = LineBuffer()
    let logger = OpsLogger(
        logPath: nil,
        sink: { line in buffer.append(line) },
        clock: { fixedInstant },
        timeZone: TimeZone(secondsFromGMT: 7200) ?? .gmt)
    return (logger, buffer)
}

/// A thread-safe ordered line capture.
private final class LineBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    func append(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        lines.append(line)
    }
    var value: [String] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }
}
