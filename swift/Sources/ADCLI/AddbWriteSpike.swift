// Hidden spike verb for the native ADDB crawl WRITER (the "ADSQLv0" write path):
//
//   ad-cli _addb-write-spike <tmpdir>
//
// Creates a fresh ADDB database under <tmpdir>, runs the apple-docs-representative
// `roots` + `pages` DDL through the ADDB engine, inserts a root + 2 pages (text /
// int / BLOB / NULL binds) inside one transaction capturing lastInsertRowid, and
// reads them back via the query API. NOT a shipped verb — it exists to prove the
// write path end to end and pin the ADDB writer API (see ADWrite.WriteSpike).

import ADWrite
import ArgumentParser
import Foundation

struct AddbWriteSpikeCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "_addb-write-spike",
        abstract: "Prove the native ADDB crawl-writer write path (spike).",
        shouldDisplay: false)

    @Argument(help: "An existing writable directory to create the throwaway ADDB database in.")
    var tmpdir: String

    func run() throws {
        let report: SpikeReport
        do {
            report = try WriteSpike.run(inDirectory: tmpdir)
        } catch {
            FileHandle.standardError.write(Data("ad-cli: addb-write-spike failed: \(error)\n".utf8))
            throw ExitCode(1)
        }

        print("ADDB write spike — created \(report.databasePath)")
        print("inserted root rowid:  \(report.rootRowid)")
        print("inserted page rowids: \(report.pageRowids.map(String.init).joined(separator: ", "))")
        print("committed generation: \(report.finalGeneration)")
        print("")
        print("read back roots:")
        for line in report.rootsReadBack { print("  \(line)") }
        print("read back pages:")
        for line in report.pagesReadBack { print("  \(line)") }
    }
}
