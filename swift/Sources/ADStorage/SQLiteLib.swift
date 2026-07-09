// Runtime dlopen/dlsym binding to the system libsqlite3.
//
// Deliberately NOT a SwiftPM systemLibrary, for the same reason as
// ADArchive/Zstd.swift: a systemLibrary would make libsqlite3 a hard build
// dependency of the whole package for every contributor and CI leg. dlopen
// keeps `swift build` zero-dep and degrades gracefully — library absent (or
// built without FTS5) → open fails → the fallback implementation serves. The
// C ABI used here is the stable sqlite3 core + FTS5 is required at runtime
// (bm25 auxiliary function).

import CSQLiteShim

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

// sqlite3.h stable constants (ABI-frozen since 3.x).
enum SQLite {
    static let ok: Int32 = 0
    static let row: Int32 = 100
    static let done: Int32 = 101

    // open flags
    static let openReadOnly: Int32 = 0x0000_0001
    static let openReadWrite: Int32 = 0x0000_0002
    static let openCreate: Int32 = 0x0000_0004
    static let openURI: Int32 = 0x0000_0040
    static let openNoMutex: Int32 = 0x0000_8000

    // column types
    static let typeInteger: Int32 = 1
    static let typeFloat: Int32 = 2
    static let typeText: Int32 = 3
    static let typeBlob: Int32 = 4
    static let typeNull: Int32 = 5
}

// SQLITE_TRANSIENT — the magic destructor pointer (-1) that tells
// sqlite3_bind_text/blob to copy the bytes immediately. Passed as a raw
// pointer so the binding never needs a @convention(c) destructor type.
nonisolated(unsafe) let sqliteTransient = UnsafeRawPointer(bitPattern: -1)

struct SQLiteLib: @unchecked Sendable {
    let openV2:
        @convention(c) (
            UnsafePointer<CChar>?, UnsafeMutablePointer<OpaquePointer?>?, Int32, UnsafePointer<CChar>?
        ) -> Int32
    let closeV2: @convention(c) (OpaquePointer?) -> Int32
    let prepareV2:
        @convention(c) (
            OpaquePointer?, UnsafePointer<CChar>?, Int32, UnsafeMutablePointer<OpaquePointer?>?,
            UnsafeMutablePointer<UnsafePointer<CChar>?>?
        ) -> Int32
    let finalize: @convention(c) (OpaquePointer?) -> Int32
    let step: @convention(c) (OpaquePointer?) -> Int32
    let reset: @convention(c) (OpaquePointer?) -> Int32
    let clearBindings: @convention(c) (OpaquePointer?) -> Int32
    let bindParameterIndex: @convention(c) (OpaquePointer?, UnsafePointer<CChar>?) -> Int32
    let bindText: @convention(c) (OpaquePointer?, Int32, UnsafeRawPointer?, Int32, UnsafeRawPointer?) -> Int32
    let bindBlob: @convention(c) (OpaquePointer?, Int32, UnsafeRawPointer?, Int32, UnsafeRawPointer?) -> Int32
    let bindInt64: @convention(c) (OpaquePointer?, Int32, Int64) -> Int32
    let bindDouble: @convention(c) (OpaquePointer?, Int32, Double) -> Int32
    let bindNull: @convention(c) (OpaquePointer?, Int32) -> Int32
    let columnCount: @convention(c) (OpaquePointer?) -> Int32
    let columnName: @convention(c) (OpaquePointer?, Int32) -> UnsafePointer<CChar>?
    let columnType: @convention(c) (OpaquePointer?, Int32) -> Int32
    let columnInt64: @convention(c) (OpaquePointer?, Int32) -> Int64
    let columnDouble: @convention(c) (OpaquePointer?, Int32) -> Double
    let columnText: @convention(c) (OpaquePointer?, Int32) -> UnsafePointer<UInt8>?
    let columnBlob: @convention(c) (OpaquePointer?, Int32) -> UnsafeRawPointer?
    let columnBytes: @convention(c) (OpaquePointer?, Int32) -> Int32
    let errmsg: @convention(c) (OpaquePointer?) -> UnsafePointer<CChar>?

    func errorMessage(_ db: OpaquePointer?) -> String {
        guard let cstr = errmsg(db) else { return "sqlite error" }
        return String(cString: cstr)
    }
}

enum SQLiteLoader {
    // Darwin: prefer a full-featured Homebrew sqlite (FTS5 guaranteed), then
    // the system libsqlite3 (recent macOS ships FTS5, but not guaranteed on
    // older releases). Linux: the bare soname — Debian/Ubuntu's libsqlite3-0
    // ships SQLITE_ENABLE_FTS5.
    private static let candidates: [String] = {
        #if canImport(Darwin)
            return [
                "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
                "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
                "/usr/lib/libsqlite3.dylib",
                "libsqlite3.dylib"
            ]
        #else
            return ["libsqlite3.so.0", "libsqlite3.so"]
        #endif
    }()

    static let shared: SQLiteLib? = {
        for path in candidates {
            guard let handle = dlopen(path, RTLD_NOW | RTLD_LOCAL) else { continue }
            func sym<T>(_ name: String, as type: T.Type) -> T? {
                guard let raw = dlsym(handle, name) else { return nil }
                return unsafeBitCast(raw, to: T.self)
            }
            guard
                let openV2 = sym(
                    "sqlite3_open_v2",
                    as: (@convention(c) (
                        UnsafePointer<CChar>?, UnsafeMutablePointer<OpaquePointer?>?, Int32,
                        UnsafePointer<CChar>?
                    ) -> Int32)
                    .self),
                let closeV2 = sym("sqlite3_close_v2", as: (@convention(c) (OpaquePointer?) -> Int32).self),
                let prepareV2 = sym(
                    "sqlite3_prepare_v2",
                    as: (@convention(c) (
                        OpaquePointer?, UnsafePointer<CChar>?, Int32, UnsafeMutablePointer<OpaquePointer?>?,
                        UnsafeMutablePointer<UnsafePointer<CChar>?>?
                    ) -> Int32)
                    .self),
                let finalize = sym("sqlite3_finalize", as: (@convention(c) (OpaquePointer?) -> Int32).self),
                let step = sym("sqlite3_step", as: (@convention(c) (OpaquePointer?) -> Int32).self),
                let reset = sym("sqlite3_reset", as: (@convention(c) (OpaquePointer?) -> Int32).self),
                let clearBindings = sym(
                    "sqlite3_clear_bindings", as: (@convention(c) (OpaquePointer?) -> Int32).self),
                let bindParameterIndex = sym(
                    "sqlite3_bind_parameter_index",
                    as: (@convention(c) (OpaquePointer?, UnsafePointer<CChar>?) -> Int32).self),
                let bindText = sym(
                    "sqlite3_bind_text",
                    as: (@convention(c) (OpaquePointer?, Int32, UnsafeRawPointer?, Int32, UnsafeRawPointer?)
                        -> Int32)
                        .self),
                let bindBlob = sym(
                    "sqlite3_bind_blob",
                    as: (@convention(c) (OpaquePointer?, Int32, UnsafeRawPointer?, Int32, UnsafeRawPointer?)
                        -> Int32)
                        .self),
                let bindInt64 = sym(
                    "sqlite3_bind_int64", as: (@convention(c) (OpaquePointer?, Int32, Int64) -> Int32).self),
                let bindDouble = sym(
                    "sqlite3_bind_double", as: (@convention(c) (OpaquePointer?, Int32, Double) -> Int32).self),
                let bindNull = sym(
                    "sqlite3_bind_null", as: (@convention(c) (OpaquePointer?, Int32) -> Int32).self),
                let columnCount = sym(
                    "sqlite3_column_count", as: (@convention(c) (OpaquePointer?) -> Int32).self),
                let columnName = sym(
                    "sqlite3_column_name",
                    as: (@convention(c) (OpaquePointer?, Int32) -> UnsafePointer<CChar>?).self),
                let columnType = sym(
                    "sqlite3_column_type", as: (@convention(c) (OpaquePointer?, Int32) -> Int32).self),
                let columnInt64 = sym(
                    "sqlite3_column_int64", as: (@convention(c) (OpaquePointer?, Int32) -> Int64).self),
                let columnDouble = sym(
                    "sqlite3_column_double", as: (@convention(c) (OpaquePointer?, Int32) -> Double).self),
                let columnText = sym(
                    "sqlite3_column_text",
                    as: (@convention(c) (OpaquePointer?, Int32) -> UnsafePointer<UInt8>?).self),
                let columnBlob = sym(
                    "sqlite3_column_blob",
                    as: (@convention(c) (OpaquePointer?, Int32) -> UnsafeRawPointer?).self),
                let columnBytes = sym(
                    "sqlite3_column_bytes", as: (@convention(c) (OpaquePointer?, Int32) -> Int32).self),
                let errmsg = sym(
                    "sqlite3_errmsg",
                    as: (@convention(c) (OpaquePointer?) -> UnsafePointer<CChar>?).self)
            else { continue }
            // Disable SQLite memory statistics BEFORE the first open — removes a
            // global allocator mutex that otherwise serializes every malloc/free
            // across all reader connections (profiling showed concurrent FTS readers
            // ~90% blocked in that one mutex via sqlite3Malloc, not executing SQL →
            // ~6× throughput at c=16 on an alloc-bound corpus). Via a C shim because
            // sqlite3_config is variadic; benign SQLITE_MISUSE if SQLite is already
            // initialized.
            _ = ad_sqlite_config_memstatus_off(dlsym(handle, "sqlite3_config"))
            return SQLiteLib(
                openV2: openV2, closeV2: closeV2, prepareV2: prepareV2, finalize: finalize, step: step,
                reset: reset, clearBindings: clearBindings, bindParameterIndex: bindParameterIndex,
                bindText: bindText, bindBlob: bindBlob, bindInt64: bindInt64, bindDouble: bindDouble,
                bindNull: bindNull,
                columnCount: columnCount, columnName: columnName, columnType: columnType,
                columnInt64: columnInt64, columnDouble: columnDouble, columnText: columnText,
                columnBlob: columnBlob, columnBytes: columnBytes, errmsg: errmsg)
        }
        return nil
    }()
}
