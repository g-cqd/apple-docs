/// Minimum OS versions for an indexed documentation item.
///
/// Stores both display strings and packed numeric ``PlatformVersion`` companions so
/// SQL filter predicates compare numerically while responses preserve Apple's nominal text.
public struct PlatformAvailability: Hashable, Sendable, Codable {
    public let ios: String?
    public let macos: String?
    public let watchos: String?
    public let tvos: String?
    public let visionos: String?

    public init(
        ios: String? = nil,
        macos: String? = nil,
        watchos: String? = nil,
        tvos: String? = nil,
        visionos: String? = nil
    ) {
        self.ios = ios
        self.macos = macos
        self.watchos = watchos
        self.tvos = tvos
        self.visionos = visionos
    }

    public var iosNumeric: Int64? { ios.flatMap { PlatformVersion(parsing: $0)?.encoded } }
    public var macosNumeric: Int64? { macos.flatMap { PlatformVersion(parsing: $0)?.encoded } }
    public var watchosNumeric: Int64? { watchos.flatMap { PlatformVersion(parsing: $0)?.encoded } }
    public var tvosNumeric: Int64? { tvos.flatMap { PlatformVersion(parsing: $0)?.encoded } }
    public var visionosNumeric: Int64? { visionos.flatMap { PlatformVersion(parsing: $0)?.encoded } }

    public static let none = Self()
}
