// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "KarakeepCapture",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "KarakeepCapture", targets: ["KarakeepMenuBar"])],
  targets: [
    .target(name: "CaptureCore"),
    .executableTarget(name: "KarakeepMenuBar", dependencies: ["CaptureCore"]),
    .testTarget(name: "CaptureCoreTests", dependencies: ["CaptureCore", "KarakeepMenuBar"]),
  ]
)
