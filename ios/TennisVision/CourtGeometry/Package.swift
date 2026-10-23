// swift-tools-version:5.9
// Pure-Swift geometry, line-call, and scorekeeping core shared by the iOS app, the watchOS app, and the
// XCTest suite. Foundation-only (no AVFoundation / simd / UIKit), so `swift test` also runs on Linux CI.
import PackageDescription

let package = Package(
    name: "CourtGeometry",
    platforms: [.iOS(.v17), .watchOS(.v10), .macOS(.v14)],
    products: [
        .library(name: "CourtGeometry", targets: ["CourtGeometry"]),
    ],
    targets: [
        .target(name: "CourtGeometry", path: "Sources/CourtGeometry"),
        .testTarget(
            name: "CourtGeometryTests",
            dependencies: ["CourtGeometry"],
            path: "Tests/CourtGeometryTests"
        ),
    ]
)
