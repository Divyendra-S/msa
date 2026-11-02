// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Recorder",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "Recorder", targets: ["Recorder"]),
    ],
    dependencies: [
        .package(path: "../../swift/WindTunnelProbe"),
    ],
    targets: [
        .target(name: "Recorder", dependencies: [.product(name: "WindTunnelProbe", package: "WindTunnelProbe")]),
        .testTarget(name: "RecorderScenarios", dependencies: ["Recorder", .product(name: "WindTunnelProbe", package: "WindTunnelProbe")]),
    ]
)
