/// Configuration options applied when opening a ``SQLiteConnection``.
public struct SQLiteOpenOptions: Hashable, Sendable {
    /// Access mode for the database file.
    public enum AccessMode: Hashable, Sendable {
        case readOnly
        case readOnlyImmutable
        case readWriteCreate
    }

    public let mode: AccessMode
    public let busyTimeoutMilliseconds: Int32
    public let enableWAL: Bool
    public let enableForeignKeys: Bool
    public let cacheSizeKiB: Int32
    public let mmapSizeBytes: Int64

    public init(
        mode: AccessMode = .readWriteCreate,
        busyTimeoutMilliseconds: Int32 = 5_000,
        enableWAL: Bool = true,
        enableForeignKeys: Bool = true,
        cacheSizeKiB: Int32 = 64_000,
        mmapSizeBytes: Int64 = 10_737_418_240
    ) {
        self.mode = mode
        self.busyTimeoutMilliseconds = busyTimeoutMilliseconds
        self.enableWAL = enableWAL
        self.enableForeignKeys = enableForeignKeys
        self.cacheSizeKiB = cacheSizeKiB
        self.mmapSizeBytes = mmapSizeBytes
    }

    /// Standard read-write configuration matching production WAL + mmap pragmas.
    public static let readWrite = Self(mode: .readWriteCreate)

    /// Read-only configuration for concurrent reader pool connections and legacy imports.
    public static let readOnly = Self(mode: .readOnly, enableWAL: false, enableForeignKeys: false)

    /// Immutable read-only URI open (`file:<path>?immutable=1`, `SQLITE_OPEN_READONLY | SQLITE_OPEN_URI`):
    /// never touches `-wal` / `-shm` under `/System`.
    public static let readOnlyImmutable = Self(
        mode: .readOnlyImmutable,
        enableWAL: false,
        enableForeignKeys: false,
        mmapSizeBytes: 0
    )
}
