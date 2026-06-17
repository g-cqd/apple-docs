extension Int {
  /// Overflow-checked multiply for FFI payload sizing; nil instead of a trap so
  /// the export surface fails with `.invalidInput` on adversarial counts rather
  /// than aborting the host process across the C boundary.
  public func checkedMultiplied(by other: Int) -> Int? {
    let (value, overflow) = multipliedReportingOverflow(by: other)
    return overflow ? nil : value
  }

  /// Overflow-checked add; same no-trap contract as `checkedMultiplied(by:)`.
  public func checkedAdded(_ other: Int) -> Int? {
    let (value, overflow) = addingReportingOverflow(other)
    return overflow ? nil : value
  }
}
