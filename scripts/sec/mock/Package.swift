// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MockApp",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.3.0"),
        .package(url: "https://github.com/vapor/vapor.git", from: "4.83.0"),
    ],
    targets: [
        .executableTarget(
            name: "MockApp",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
                .product(name: "Vapor", package: "vapor"),
            ]
        ),
    ]
)
