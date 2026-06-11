import Testing
@testable import ADBase

private struct Header {
  let len: UInt64
  let status: UInt32
  let formatId: UInt8
}

private func readHeader(_ ptr: UnsafeMutableRawPointer) -> Header {
  Header(
    len: UInt64(littleEndian: ptr.load(fromByteOffset: 0, as: UInt64.self)),
    status: UInt32(littleEndian: ptr.load(fromByteOffset: 8, as: UInt32.self)),
    formatId: ptr.load(fromByteOffset: 12, as: UInt8.self),
  )
}

@Test func resultBufferRoundTrip() {
  let payload: [UInt8] = [1, 2, 3, 4, 5]
  let ptr = payload.withUnsafeBufferPointer {
    ResultBuffer.make(status: .ok, format: .bytes, payload: UnsafeRawBufferPointer($0))
  }
  defer { ResultBuffer.free(ptr) }
  let header = readHeader(ptr!)
  #expect(header.len == 5)
  #expect(header.status == 0)
  #expect(header.formatId == 0)
  let bytes = [UInt8](UnsafeRawBufferPointer(start: ptr! + 16, count: 5))
  #expect(bytes == payload)
}

@Test func errorBufferCarriesUtf8Message() {
  let ptr = ResultBuffer.error(.invalidInput, "boom — bad input")
  defer { ResultBuffer.free(ptr) }
  let header = readHeader(ptr!)
  #expect(header.status == 1)
  #expect(header.formatId == 1)
  let text = String(decoding: UnsafeRawBufferPointer(start: ptr! + 16, count: Int(header.len)), as: UTF8.self)
  #expect(text == "boom — bad input")
}

@Test func allocateWritesInPlace() {
  let (base, payload) = ResultBuffer.allocate(status: .ok, format: .bytes, payloadCount: 16)!
  defer { ResultBuffer.free(base) }
  payload.storeBytes(of: Double(1.5).bitPattern.littleEndian, toByteOffset: 0, as: UInt64.self)
  let bits = base.loadUnaligned(fromByteOffset: 16, as: UInt64.self)
  #expect(Double(bitPattern: UInt64(littleEndian: bits)) == 1.5)
}

@Test func freeOfNilIsNoOp() {
  ResultBuffer.free(nil)
}

@Test func readerReadsLittleEndianAndBounds() {
  // Mutating calls are hoisted into lets: the #expect macro rewrites
  // receiver method calls onto an immutable closure parameter.
  var bytes = [UInt8]()
  bytes.append(contentsOf: [0x2A, 0, 0, 0]) // u32 42
  bytes.append(contentsOf: withUnsafeBytes(of: Double(0.5).bitPattern.littleEndian) { [UInt8]($0) })
  bytes.withUnsafeBufferPointer { raw in
    var reader = RequestReader(UnsafeRawBufferPointer(raw))
    let first = reader.u32()
    #expect(first == 42)
    let second = reader.f64()
    #expect(second == 0.5)
    #expect(reader.remaining == 0)
    let pastEndU32 = reader.u32() // past end → nil, never trap
    let pastEndF64 = reader.f64()
    let pastEndBytes = reader.bytes(1)
    #expect(pastEndU32 == nil)
    #expect(pastEndF64 == nil)
    #expect(pastEndBytes == nil)
  }
}

@Test func readerAligns8() {
  let bytes = [UInt8](repeating: 0, count: 16)
  bytes.withUnsafeBufferPointer { raw in
    var reader = RequestReader(UnsafeRawBufferPointer(raw))
    _ = reader.u32()
    #expect(reader.offset == 4)
    let aligned = reader.align8()
    #expect(aligned)
    #expect(reader.offset == 8)
    let alignedAgain = reader.align8() // already aligned → no-op
    #expect(alignedAgain)
    #expect(reader.offset == 8)
  }
}

@Test func buildInfoLooksRight() {
  let json = BuildInfo.json(abi: 1)
  #expect(json.contains(#""abi":1"#))
  #expect(json.contains(#""platform":"#))
}
