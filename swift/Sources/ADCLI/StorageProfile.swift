// `ad-cli storage profile [<name>] [--json]` — get or set the storage profile
// (the headline install choice: disk vs serving speed). Ports src/storage/profiles.js
// + the maintenance.js `storage profile` dispatch: with a <name> positional it SETS
// snapshot_meta.storage_profile (writable connection), then prints the active
// profile + its config as `{ profile, ...config }`.

import ADJSONCore
import ADStorage
import ArgumentParser
import Foundation

/// The three storage profiles and their config, verbatim from `profiles.js`.
enum StorageProfile {
    struct Config {
        let persistMarkdown: Bool
        let persistHtml: Bool
        let cacheOnRead: Bool
        let cacheMaxAge: Int
        let description: String
    }

    /// Insertion order pinned to `profiles.js` (compact, balanced, prebuilt).
    static let names = ["compact", "balanced", "prebuilt"]
    static let defaultProfile = "balanced"

    static let all: [String: Config] = [
        "compact": Config(
            persistMarkdown: false, persistHtml: false, cacheOnRead: false, cacheMaxAge: 0,
            description:
                "Smallest disk. Fully compacted at install (compressed sections, contentless body index, "
                + "raw payloads dropped). Renders on demand."),
        "balanced": Config(
            persistMarkdown: false, persistHtml: false, cacheOnRead: true, cacheMaxAge: 7 * 24 * 60 * 60 * 1000,
            description:
                "Default. Ships the snapshot as-is and caches rendered Markdown on first read, evicting after 7 days."),
        "prebuilt": Config(
            persistMarkdown: true, persistHtml: true, cacheOnRead: false, cacheMaxAge: 0,
            description: "Fastest. Materializes Markdown + HTML at install. Largest disk.")
    ]

    /// The active profile: `snapshot_meta.storage_profile` when it names a known
    /// profile, else the default (JS `getProfile`).
    static func active(_ connection: StorageConnection) -> String {
        guard let stored = connection.getSnapshotMeta("storage_profile"), all[stored] != nil else {
            return defaultProfile
        }
        return stored
    }

    /// `{ profile, persistMarkdown, persistHtml, cacheOnRead, cacheMaxAge, description }`
    /// — the JS `{ profile: active, ...getProfileConfig(active) }` shape + key order.
    static func json(profile: String, config: Config) -> JSONValue {
        .obj([
            ("profile", .string(profile)),
            ("persistMarkdown", .bool(config.persistMarkdown)),
            ("persistHtml", .bool(config.persistHtml)),
            ("cacheOnRead", .bool(config.cacheOnRead)),
            ("cacheMaxAge", .int(Int64(config.cacheMaxAge))),
            ("description", .string(config.description))
        ])
    }
}

/// `ad-cli storage profile [<name>] [--json]`.
struct StorageProfileCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "profile", abstract: "Get or set the storage profile (compact/balanced/prebuilt).")

    @OptionGroup var corpus: CorpusOptions

    @Argument(help: "Profile to set: compact, balanced, or prebuilt. Omit to show the active profile.")
    var name: String?

    @Flag(name: .long, help: "Emit JSON instead of the summary line.")
    var json = false

    func run() throws {
        // Setting requires a writable connection; JS throws NotFoundError on an
        // unknown name BEFORE opening for write, so validate first.
        if let name {
            guard StorageProfile.all[name] != nil else {
                let valid = StorageProfile.names.joined(separator: ", ")
                FileHandle.standardError.write(
                    Data("Error: Unknown storage profile: \"\(name)\". Valid profiles: \(valid)\n".utf8))
                throw ExitCode(1)
            }
            guard let writer = StorageConnection(path: corpus.path, writable: true) else {
                FileHandle.standardError.write(Data("ad-cli: cannot open \(corpus.path) for writing\n".utf8))
                throw ExitCode(1)
            }
            _ = writer.setSnapshotMeta("storage_profile", name)
        }

        guard let connection = StorageConnection(path: corpus.path) else {
            FileHandle.standardError.write(Data("ad-cli: cannot open \(corpus.path)\n".utf8))
            throw ExitCode(1)
        }
        let active = StorageProfile.active(connection)
        // `active` is always a known key (set-path validated it; the getter floors
        // to the default), so the fallback is never taken.
        let config = StorageProfile.all[active] ?? StorageProfile.all[StorageProfile.defaultProfile]!
        let value = StorageProfile.json(profile: active, config: config)
        print(json ? stringifyPretty(value) : "storage profile: \(stringifyCompact(value))")
    }
}
