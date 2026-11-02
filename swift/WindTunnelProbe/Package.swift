// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WindTunnelProbe",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "WindTunnelProbe", targets: ["WindTunnelProbe"]),
    ],
    targets: [
        .target(name: "WindTunnelProbe"),
        .testTarget(name: "WindTunnelProbeTests", dependencies: ["WindTunnelProbe"]),
    ]
)
