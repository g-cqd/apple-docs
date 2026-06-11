/// ABI contract v0 status codes (rfcs/0001-swift-native-transition/p0/ffi-bridge.md §2).
public enum ADStatus: UInt32, Sendable {
  case ok = 0
  case invalidInput = 1
  case internalError = 2
}

/// Payload format identifier carried in the result header.
public enum ADFormat: UInt8, Sendable {
  case bytes = 0
  case utf8 = 1
  case json = 2
}
