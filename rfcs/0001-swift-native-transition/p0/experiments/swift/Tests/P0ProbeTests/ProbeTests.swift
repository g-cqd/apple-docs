// Native-side contract checks for ABI contract v0 — the Swift mirror of the
// correctness phase in ../../bench.js. These pin the header layout, status
// codes, and the no-trap rule without crossing the FFI boundary.

import Testing
@testable import P0Probe

private struct Result {
  let status: UInt32
  let formatId: UInt8
  let payload: [UInt8]
}

/// Parses a contract-v0 buffer and frees it exactly once.
private func parseResult(_ ptr: UnsafeMutableRawPointer?) -> Result? {
  guard let ptr else { return nil }
  defer { adFree(ptr) }
  let len = Int(UInt64(littleEndian: ptr.load(fromByteOffset: 0, as: UInt64.self)))
  let status = UInt32(littleEndian: ptr.load(fromByteOffset: 8, as: UInt32.self))
  let formatId = ptr.load(fromByteOffset: 12, as: UInt8.self)
  let payload = [UInt8](UnsafeRawBufferPointer(start: ptr + 16, count: len))
  return Result(status: status, formatId: formatId, payload: payload)
}

private func call(_ input: [UInt8], _ fn: (UnsafePointer<UInt8>?, Int) -> UnsafeMutableRawPointer?) -> Result? {
  parseResult(input.withUnsafeBufferPointer { fn($0.baseAddress, $0.count) })
}

@Test func abiVersionIsOne() {
  #expect(adAbiVersion() == 1)
}

@Test func echoRoundTripsBytes() {
  let blob = (0..<1024).map { _ in UInt8.random(in: .min ... .max) }
  let result = call(blob, adEcho)
  #expect(result?.status == 0)
  #expect(result?.formatId == 0)
  #expect(result?.payload == blob)
}

@Test func echoEmptyIsOk() {
  let result = call([], adEcho)
  #expect(result?.status == 0)
  #expect(result?.payload.isEmpty == true)
}

@Test func negativeLengthReturnsStatusNotTrap() {
  let result = parseResult(adEcho(nil, -1))
  #expect(result?.status == 1)
  // Hoisted: the #expect macro rewrites optional-chained receivers
  // (`result?.payload`) into an ill-typed `$0?.contains($1)` expansion.
  let message = String(decoding: result?.payload ?? [], as: UTF8.self)
  #expect(message.contains("invalid length"))
}

@Test func fnv1aMatchesCanonicalVectors() {
  // Canonical FNV-1a 64 test vectors.
  #expect(adFnv1a(nil, 0) == 0xcbf2_9ce4_8422_2325)
  let a: [UInt8] = Array("a".utf8)
  #expect(a.withUnsafeBufferPointer { adFnv1a($0.baseAddress, $0.count) } == 0xaf63_dc4c_8601_ec8c)
}

@Test func buildInfoIsJsonWithAbi() {
  let result = parseResult(adBuildInfo())
  #expect(result?.status == 0)
  #expect(result?.formatId == 2)
  let text = String(decoding: result?.payload ?? [], as: UTF8.self)
  #expect(text.contains(#""abi":1"#))
}

@Test func jsonRoundTripPreservesStructure() {
  let input = Array(#"{"query":"NavigationStack","ids":[1,2,3]}"#.utf8)
  let result = call(input, adJsonRoundtrip)
  #expect(result?.status == 0)
  #expect(result?.formatId == 2)
  let text = String(decoding: result?.payload ?? [], as: UTF8.self)
  #expect(text.contains("NavigationStack"))
}

@Test func malformedJsonReturnsStatusNotTrap() {
  let result = call(Array("{nope".utf8), adJsonRoundtrip)
  #expect(result?.status == 1)
}

@Test func freeOfNullIsNoOp() {
  adFree(nil)
}
