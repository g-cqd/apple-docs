// Codepoint stamping orchestrator — the native port of
// src/resources/apple-symbols/codepoint-stamp.js `stampSfSymbolCodepoints`. After the
// catalog is synced, walk every PUBLIC symbol through the in-process codepoint reader
// (SfSymbolCodepointReader, which reads the obfuscated catalog font via the private
// CoreGlyphsLib `Crypton` decryptor) and stamp each resolved PUA codepoint — plus the
// SF Symbols release it was resolved against — back onto the row.
//
// Idempotent (re-running against the same font rewrites the same values) and
// budget-bounded (a wall-clock cap; whatever resolved before the cap is committed, the
// rest stay NULL until the next run — partial coverage is the norm, not a failure).
// Degrades to a no-op + `warn` whenever SF Symbols.app or its private frameworks are
// unavailable, so a non-mac / bare host hosting a prebuilt snapshot keeps the column
// values that shipped in the snapshot.

import Foundation

/// The public entry point for `ad-cli resources stamp-codepoints`.
public enum SfSymbolCodepointStamp {
    /// The stamp tallies (the JS `{ stamped, total, fontPath }`): symbols that received a real
    /// codepoint, the public-catalog size walked, and the resolved font (nil when none was found).
    public struct Result: Sendable, Equatable {
        public let stamped: Int
        public let total: Int
        public let fontPath: String?
        /// The resolved app version stamped into `codepoint_version` (nil when no app was found).
        public let version: String?
    }

    /// Resolve SF Symbols.app, then stamp `sf_symbols.codepoint` + `codepoint_version` for every
    /// public catalog row the reader resolves. `db` MUST be writable. `dataDir` roots the download
    /// cache + the compiled-helper cache; `appPath` overrides discovery (tests / `--app-path`).
    /// `warn`/`info` mirror the JS `logger?.warn` / `logger?.info` sinks.
    @discardableResult
    public static func stamp(
        _ db: StorageConnection, dataDir: String?, appPath: String? = nil, wallClockMs: Int = 30_000,
        warn: ((String) -> Void)? = nil, info: ((String) -> Void)? = nil
    ) -> Result {
        guard let app = SfSymbolsAppLocator.resolve(dataDir: dataDir, explicitAppPath: appPath) else {
            warn?(
                "SF Symbols.app not available; skipping SF Symbol codepoint stamping. "
                    + "Install from https://developer.apple.com/sf-symbols/ or retry with network access.")
            return Result(stamped: 0, total: 0, fontPath: nil, version: nil)
        }

        let publicNames = db.listSfSymbolsCatalog().filter { $0.scope == "public" }.map(\.name)
        guard !publicNames.isEmpty else {
            return Result(stamped: 0, total: 0, fontPath: app.fontPath, version: app.version)
        }

        // Cold start (first-run helper compile + the font decrypt) happens inside `open`; the
        // per-symbol wall-clock budget starts only AFTER, so it never eats the startup cost (the JS
        // resets `wallClockDeadline` after the first line).
        let cacheDir = "\(dataDir ?? NSTemporaryDirectory())/cache/sf-symbols/helper"
        guard let reader = SfSymbolCodepointReader.open(app: app, cacheDir: cacheDir, warn: warn) else {
            return Result(stamped: 0, total: 0, fontPath: app.fontPath, version: app.version)
        }
        defer { reader.close() }

        let deadline = DispatchTime.now() + .milliseconds(wallClockMs)
        var stamped = 0
        var processed = 0
        for name in publicNames {
            if DispatchTime.now() > deadline {
                warn?(
                    "codepoint stamp exceeded \(wallClockMs)ms wall clock; processed \(processed) of "
                        + "\(publicNames.count)")
                break
            }
            processed += 1
            let codepoint = resolvedCodepoint(reader.lookup(name), name: name, warn: warn)
            db.updateSfSymbolCodepoint(
                scope: "public", name: name, codepoint: codepoint.map(Int64.init), version: app.version)
            if codepoint != nil { stamped += 1 }
        }

        let total = publicNames.count
        let percent = total == 0 ? "0.0" : String(format: "%.1f", Double(stamped) * 100 / Double(total))
        info?("Stamped codepoints on \(stamped) of \(total) public symbols (\(percent)% coverage)")
        return Result(stamped: stamped, total: total, fontPath: app.fontPath, version: app.version)
    }

    /// Validate a raw lookup result: keep a PUA codepoint, reject anything else to nil (the JS
    /// defensive `isPrivateUseCodepoint` reject at the dump boundary — a stale binary or font swap
    /// could in principle return a Latin codepoint we must not store).
    private static func resolvedCodepoint(_ value: UInt32?, name: String, warn: ((String) -> Void)?)
        -> UInt32?
    {
        guard let value else { return nil }
        guard SfSymbolCodepointReader.isPrivateUseCodepoint(value) else {
            warn?("codepoint stamp: rejecting non-PUA codepoint \(value) for \(name)")
            return nil
        }
        return value
    }
}
