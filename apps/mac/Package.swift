// swift-tools-version: 6.2
// The Wind Tunnel Mac app: a native client of the local viewer API (`windtunnel view --json`).
// Build the .app with ./build.sh (or `pnpm mac:build` at the repo root).
import PackageDescription

let package = Package(
  name: "WindTunnel",
  platforms: [.macOS(.v15)],
  targets: [
    .executableTarget(
      name: "WindTunnel",
      path: "Sources/WindTunnel",
      swiftSettings: [.defaultIsolation(MainActor.self)]
    ),
  ]
)
