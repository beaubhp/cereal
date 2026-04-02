// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "transcriber-helper",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "transcriber_helper",
            targets: ["transcriber_helper"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/argmaxinc/WhisperKit.git", from: "0.9.0")
    ],
    targets: [
        .executableTarget(
            name: "transcriber_helper",
            dependencies: [
                "WhisperKit"
            ],
            path: "Sources/TranscriberHelper"
        )
    ]
)
