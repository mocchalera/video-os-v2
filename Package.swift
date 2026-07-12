// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "VideoOSStudio",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "VideoOSStudioCore", targets: ["VideoOSStudioCore"]),
        .executable(name: "VideoOSStudio", targets: ["VideoOSStudio"]),
        .executable(name: "videoos-studio-cli", targets: ["VideoOSStudioCLI"])
    ],
    targets: [
        .target(
            name: "VideoOSStudioCore",
            path: "apps/macos-studio/Sources/VideoOSStudioCore"
        ),
        .executableTarget(
            name: "VideoOSStudio",
            dependencies: ["VideoOSStudioCore"],
            path: "apps/macos-studio/Sources/VideoOSStudio",
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("AVKit")
            ]
        ),
        .executableTarget(
            name: "VideoOSStudioCLI",
            dependencies: ["VideoOSStudioCore"],
            path: "apps/macos-studio/Sources/VideoOSStudioCLI"
        ),
        .testTarget(
            name: "VideoOSStudioCoreTests",
            dependencies: ["VideoOSStudioCore"],
            path: "apps/macos-studio/Tests/VideoOSStudioCoreTests"
        )
    ]
)
