// swift-tools-version: 6.1
// P0 probe: zero-dependency dynamic library validating ABI contract v0
// (see ../../ffi-bridge.md). Build: swift build -c release
// (+ --static-swift-stdlib on Linux).
import PackageDescription

let package = Package(
  name: "P0Probe",
  products: [
    .library(name: "P0Probe", type: .dynamic, targets: ["P0Probe"])
  ],
  targets: [
    .target(name: "P0Probe")
  ]
)
