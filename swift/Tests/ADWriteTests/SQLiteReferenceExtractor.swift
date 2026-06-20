// Builds the JS-migrated SQLite reference catalog and projects it into the
// engine-agnostic ``CatalogModel`` for the parity gate.
//
// Per the deliverable: run a fresh `DocsDatabase` (which replays the JS
// migrations v1…v27) against a throwaway file from the apple-docs root, then read
// its `sqlite_master` / `PRAGMA table_info`. We do that by shelling out to `bun`
// with a small inline script that emits a DETERMINISTIC, line-based manifest of
// the schema to stdout; this Swift side parses the manifest into the model. A
// line-based manifest (not JSON) keeps parsing dependency-free and the diff
// human-readable.

import Foundation

enum SQLiteReferenceError: Error, CustomStringConvertible {
    case appleDocsRootNotFound(triedFrom: String)
    case bunNotFound
    case bunFailed(status: Int32, stderr: String)
    case manifestParse(String)

    var description: String {
        switch self {
            case .appleDocsRootNotFound(let from):
                return "could not locate the apple-docs root (with src/storage/database.js) walking up from \(from)"
            case .bunNotFound:
                return "`bun` was not found on PATH or at common locations; the parity gate needs it to build the SQLite reference"
            case .bunFailed(let status, let stderr):
                return "bun exited \(status) building the SQLite reference:\n\(stderr)"
            case .manifestParse(let detail):
                return "could not parse the SQLite schema manifest: \(detail)"
        }
    }
}

enum SQLiteReferenceExtractor {
    /// Sentinel emitted for a column with no default (so an absent default is
    /// distinguishable from a real one). No real apple-docs default equals it.
    static let noDefaultSentinel = "__NO_DEFAULT__"

    /// The inline bun script. Creates a fresh JS-migrated SQLite DB at argv[2],
    /// then prints a stable manifest read from sqlite_master / PRAGMA table_info.
    ///
    /// Manifest grammar (one record per line, fields `|`-separated):
    ///   T|<table>                                  table header
    ///   C|<table>|<cid>|<name>|<type>|<notnull0|1>|<dfltOrSentinel>|<pk>
    ///   I|<name>|<table>|<unique0|1>|<col,col,…>   explicit OR implied index
    ///   F|<name>|<col,col,…>|<tokenize>|<contentSpec>
    ///   G|<name>|<base64 sql>                       trigger (sql base64 to survive newlines)
    /// The Swift side ignores FTS shadow tables + sqlite_sequence (it has the same
    /// exclusion list); the script already drops shadow tables to keep output lean.
    private static let manifestScript = #"""
    import { DocsDatabase } from "./src/storage/database.js";
    import { Database } from "bun:sqlite";

    // `bun -e <script> <dbPath>` exposes argv as [bunPath, dbPath] (the inline
    // script is NOT in argv, and bun strips a leading `--`), so the DB path is
    // argv[1].
    const path = process.argv[1];
    new DocsDatabase(path).close();
    const db = new Database(path, { readonly: true });

    const out = [];
    const objs = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();

    const ftsBases = new Set(
      objs.filter(o => o.type === "table" && o.sql && /USING\s+fts5/i.test(o.sql)).map(o => o.name)
    );

    function parseFTS(name, sql) {
      const m = sql.match(/USING\s+fts5\s*\(([\s\S]*)\)/i);
      const body = m ? m[1] : "";
      const parts = body.split(",").map(s => s.trim()).filter(Boolean);
      const cols = [];
      let tokenize = "unicode61";
      let contentTable = null, contentRowid = "rowid", contentless = false, deleteEnabled = false;
      for (const p of parts) {
        const eq = p.indexOf("=");
        if (eq === -1) { cols.push(p); continue; }
        const key = p.slice(0, eq).trim().toLowerCase();
        let val = p.slice(eq + 1).trim();
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        if (key === "tokenize") tokenize = val;
        else if (key === "content") { if (val === "") contentless = true; else contentTable = val; }
        else if (key === "content_rowid") contentRowid = val;
        else if (key === "contentless_delete") deleteEnabled = val === "1";
      }
      let contentSpec;
      if (contentless) contentSpec = `contentless:${deleteEnabled ? 1 : 0}`;
      else if (contentTable) contentSpec = `external:${contentTable}:${contentRowid}`;
      else contentSpec = "self";
      return { cols, tokenize, contentSpec };
    }

    function isShadow(name) {
      for (const b of ftsBases) {
        for (const suf of ["_data", "_idx", "_docsize", "_config", "_content"]) {
          if (name === b + suf) return true;
        }
      }
      return false;
    }

    for (const o of objs) {
      if (o.type === "table") {
        if (o.name.startsWith("sqlite_")) continue;
        if (ftsBases.has(o.name)) {
          const f = parseFTS(o.name, o.sql);
          out.push(`F|${o.name}|${f.cols.join(",")}|${f.tokenize}|${f.contentSpec}`);
          continue;
        }
        if (isShadow(o.name)) continue;
        out.push(`T|${o.name}`);
        const cols = db.query(`PRAGMA table_info(${o.name})`).all();
        for (const c of cols) {
          const dflt = c.dflt_value === null ? "__NO_DEFAULT__" : String(c.dflt_value);
          out.push(`C|${o.name}|${c.cid}|${c.name}|${c.type}|${c.notnull}|${dflt}|${c.pk}`);
        }
      } else if (o.type === "index") {
        if (ftsBases.has(o.tbl_name)) continue;
        const info = db.query(`PRAGMA index_info(${o.name})`).all();
        const cols = info.map(r => r.name);
        const xinfo = db.query(`PRAGMA index_list(${o.tbl_name})`).all();
        const meta = xinfo.find(r => r.name === o.name);
        const unique = meta ? meta.unique : 0;
        out.push(`I|${o.name}|${o.tbl_name}|${unique}|${cols.join(",")}`);
      } else if (o.type === "trigger") {
        const b64 = Buffer.from(o.sql, "utf8").toString("base64");
        out.push(`G|${o.name}|${b64}`);
      }
    }
    process.stdout.write(out.join("\n"));
    """#

    /// Walks up from this source file to find the apple-docs root (the directory
    /// that contains `src/storage/database.js`). The test file lives at
    /// `<root>/swift/Tests/ADWriteTests/SQLiteReferenceExtractor.swift`.
    static func locateAppleDocsRoot(fromFile file: String = #filePath) throws -> String {
        var dir = URL(fileURLWithPath: file).deletingLastPathComponent()
        for _ in 0..<8 {
            let marker = dir.appendingPathComponent("src/storage/database.js")
            if FileManager.default.fileExists(atPath: marker.path) {
                return dir.path
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        throw SQLiteReferenceError.appleDocsRootNotFound(triedFrom: file)
    }

    /// Resolve a `bun` executable: PATH first, then common install locations.
    static func locateBun() throws -> String {
        let candidates = [
            "/opt/homebrew/bin/bun", "/usr/local/bin/bun",
            (NSHomeDirectory() as NSString).appendingPathComponent(".bun/bin/bun")
        ]
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        which.arguments = ["which", "bun"]
        let pipe = Pipe()
        which.standardOutput = pipe
        which.standardError = Pipe()
        try? which.run()
        which.waitUntilExit()
        if which.terminationStatus == 0,
            let data = try? pipe.fileHandleForReading.readToEnd(),
            let path = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
            !path.isEmpty, FileManager.default.isExecutableFile(atPath: path)
        {
            return path
        }
        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        throw SQLiteReferenceError.bunNotFound
    }

    /// Build the SQLite reference and return its normalized ``CatalogModel``.
    static func build() throws -> CatalogModel {
        let root = try locateAppleDocsRoot()
        let bun = try locateBun()

        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("addb-parity-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }
        let dbFile = tmpDir.appendingPathComponent("reference.db").path

        let process = Process()
        process.executableURL = URL(fileURLWithPath: bun)
        process.arguments = ["-e", manifestScript, dbFile]
        process.currentDirectoryURL = URL(fileURLWithPath: root)
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        let outData = (try? stdout.fileHandleForReading.readToEnd()) ?? Data()
        let errData = (try? stderr.fileHandleForReading.readToEnd()) ?? Data()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw SQLiteReferenceError.bunFailed(
                status: process.terminationStatus,
                stderr: String(data: errData, encoding: .utf8) ?? "<non-utf8 stderr>")
        }

        let manifest = String(data: outData, encoding: .utf8) ?? ""
        return try parse(manifest)
    }

    /// Parse the line-based manifest into a normalized ``CatalogModel``.
    static func parse(_ manifest: String) throws -> CatalogModel {
        var tableColumns: [String: [(cid: Int, col: ColumnModel, pk: Int, type: String)]] = [:]
        var indexes: [String: IndexModel] = [:]
        var fts: [String: FTSModel] = [:]
        var triggers: [String: TriggerModel] = [:]

        for rawLine in manifest.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = String(rawLine)
            let fields = line.components(separatedBy: "|")
            guard let kind = fields.first else { continue }
            switch kind {
                case "T":
                    guard fields.count >= 2 else { throw SQLiteReferenceError.manifestParse(line) }
                    let name = fields[1]
                    if tableColumns[name] == nil { tableColumns[name] = [] }
                case "C":
                    guard fields.count >= 8 else { throw SQLiteReferenceError.manifestParse(line) }
                    let table = fields[1]
                    guard let cid = Int(fields[2]), let pk = Int(fields[7]) else {
                        throw SQLiteReferenceError.manifestParse(line)
                    }
                    let name = fields[3]
                    let declaredType = fields[4]
                    let notNull = fields[5] == "1"
                    let dfltRaw = fields[6]
                    let dflt = (dfltRaw == noDefaultSentinel) ? nil : normalizeSQLiteDefault(dfltRaw)
                    let column = ColumnModel(
                        name: name, type: declaredType.uppercased(), notNull: notNull,
                        defaultValue: dflt)
                    tableColumns[table, default: []].append(
                        (cid: cid, col: column, pk: pk, type: declaredType.uppercased()))
                case "I":
                    guard fields.count >= 5 else { throw SQLiteReferenceError.manifestParse(line) }
                    let name = fields[1]
                    let table = fields[2]
                    let unique = fields[3] == "1"
                    let cols = fields[4].isEmpty ? [] : fields[4].components(separatedBy: ",")
                    indexes[name] = IndexModel(name: name, table: table, columns: cols, unique: unique)
                case "F":
                    guard fields.count >= 5 else { throw SQLiteReferenceError.manifestParse(line) }
                    let name = fields[1]
                    let cols = fields[2].isEmpty ? [] : fields[2].components(separatedBy: ",")
                    let tokenize = fields[3]
                    let content = fields[4]
                    fts[name] = FTSModel(name: name, columns: cols, tokenize: tokenize, content: content)
                case "G":
                    guard fields.count >= 3 else { throw SQLiteReferenceError.manifestParse(line) }
                    let name = fields[1]
                    guard let data = Data(base64Encoded: fields[2]),
                        let sql = String(data: data, encoding: .utf8)
                    else { throw SQLiteReferenceError.manifestParse("bad base64 trigger \(name)") }
                    triggers[name] = TriggerModel(
                        name: name, normalizedSQL: SchemaNormalize.normalizeTriggerSQL(sql))
                default:
                    continue
            }
        }

        var tables: [String: TableModel] = [:]
        for (name, entries) in tableColumns {
            if SchemaNormalize.engineBookkeepingTables.contains(name) { continue }
            let sorted = entries.sorted { $0.cid < $1.cid }
            // Rowid alias: exactly one PK column AND it is INTEGER-typed.
            let pkCols = sorted.filter { $0.pk > 0 }.sorted { $0.pk < $1.pk }
            let rowidAlias: String? = (pkCols.count == 1 && pkCols[0].type == "INTEGER")
                ? pkCols[0].col.name
                : nil

            // PK-implies-NOT-NULL normalization. SQLite's `table_info` reports
            // `notnull=0` for a non-INTEGER PRIMARY KEY column (a long-standing
            // SQLite quirk: it does not enforce NOT NULL on a TEXT/composite PK),
            // whereas ADDB marks every non-rowid-alias PK column NOT NULL (stricter,
            // and the logically-correct "a primary key cannot be NULL"). A primary
            // key column IS logically NOT NULL, so we normalize the reference to
            // match ADDB for PK columns that are NOT the rowid alias. (The rowid
            // alias / INTEGER PK keeps SQLite's `notnull=0`, which ADDB also reports,
            // so it is left untouched and still compared faithfully.)
            let pkColumnNames = Set(pkCols.map { $0.col.name })
            let columns: [ColumnModel] = sorted.map { entry in
                var column = entry.col
                if pkColumnNames.contains(column.name), column.name != rowidAlias {
                    column.notNull = true
                }
                return column
            }
            tables[name] = TableModel(name: name, columns: columns, rowidAlias: rowidAlias)
        }

        return CatalogModel(tables: tables, indexes: indexes, fts: fts, triggers: triggers)
    }

    /// Normalize a SQLite `PRAGMA table_info.dflt_value` to the canonical rendering
    /// the ADDB side uses. SQLite already returns text defaults single-quoted
    /// (`'available'`), integers bare (`0`), and the parenthesized now-default as
    /// `datetime('now')`. We canonicalize the now-default's internal spacing.
    static func normalizeSQLiteDefault(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        let lowered = trimmed.lowercased()
        if lowered.hasPrefix("datetime(") {
            return lowered.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined()
        }
        return trimmed
    }
}
