import Foundation

public struct ProjectMediaProxyPlanItem: Identifiable, Equatable, Sendable {
    public var id: String { assetID }
    public let assetID: String
    public let filename: String
    public let sourceURL: URL
    public let outputURL: URL
    public let outputExists: Bool
    public let ffmpegArguments: [String]

    public var commandLine: String {
        (["ffmpeg"] + ffmpegArguments)
            .map(shellQuote)
            .joined(separator: " ")
    }

    public var outputPath: String {
        outputURL.path
    }

    private func shellQuote(_ value: String) -> String {
        guard !value.isEmpty else { return "''" }
        let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+-=/:.,")
        if value.unicodeScalars.allSatisfy({ safe.contains($0) }) {
            return value
        }
        return "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

public struct ProjectMediaProxyPlan: Equatable, Sendable {
    public let items: [ProjectMediaProxyPlanItem]

    public init(items: [ProjectMediaProxyPlanItem]) {
        self.items = items
    }

    public var totalCount: Int {
        items.count
    }

    public var pendingCount: Int {
        items.filter { !$0.outputExists }.count
    }
}

public struct ProjectMediaProxyBuildFailure: Equatable, Sendable {
    public let item: ProjectMediaProxyPlanItem
    public let message: String
}

public struct ProjectMediaProxyBuildResult: Equatable, Sendable {
    public let plan: ProjectMediaProxyPlan
    public let builtItems: [ProjectMediaProxyPlanItem]
    public let skippedItems: [ProjectMediaProxyPlanItem]
    public let failures: [ProjectMediaProxyBuildFailure]

    public var builtCount: Int {
        builtItems.count
    }

    public var skippedCount: Int {
        skippedItems.count
    }

    public var failureCount: Int {
        failures.count
    }
}

public enum ProjectMediaProxyPlanner {
    public static func plan(
        projectURL: URL,
        assets: AnalysisAssetDocument? = nil
    ) -> ProjectMediaProxyPlan {
        let summary = ProjectMediaResolver.previewSummary(projectURL: projectURL, assets: assets)
        let items = summary.items.compactMap { status -> ProjectMediaProxyPlanItem? in
            guard status.playbackStatus == .needsProxy, status.exists, let sourceURL = status.url else {
                return nil
            }
            let outputURL = ProjectMediaResolver.proxyURL(projectURL: projectURL, assetID: status.assetID)
            return ProjectMediaProxyPlanItem(
                assetID: status.assetID,
                filename: status.filename,
                sourceURL: sourceURL,
                outputURL: outputURL,
                outputExists: FileManager.default.fileExists(atPath: outputURL.path),
                ffmpegArguments: ffmpegArguments(sourceURL: sourceURL, outputURL: outputURL)
            )
        }
        return ProjectMediaProxyPlan(items: items)
    }

    private static func ffmpegArguments(sourceURL: URL, outputURL: URL) -> [String] {
        [
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-i", sourceURL.path,
            "-map", "0:v:0",
            "-map", "0:a?",
            "-vf", "scale='min(1280,iw)':-2",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-c:a", "aac",
            "-b:a", "160k",
            "-movflags", "+faststart",
            outputURL.path
        ]
    }
}

public enum ProjectMediaProxyBuilder {
    public typealias Runner = ([String]) throws -> Void

    public static func build(
        projectURL: URL,
        assets: AnalysisAssetDocument? = nil
    ) -> ProjectMediaProxyBuildResult {
        build(projectURL: projectURL, assets: assets, runner: runFfmpeg)
    }

    public static func build(
        projectURL: URL,
        assets: AnalysisAssetDocument? = nil,
        runner: Runner
    ) -> ProjectMediaProxyBuildResult {
        let plan = ProjectMediaProxyPlanner.plan(projectURL: projectURL, assets: assets)
        var builtItems: [ProjectMediaProxyPlanItem] = []
        var skippedItems: [ProjectMediaProxyPlanItem] = []
        var failures: [ProjectMediaProxyBuildFailure] = []

        for item in plan.items {
            if item.outputExists {
                skippedItems.append(item)
                continue
            }

            do {
                try FileManager.default.createDirectory(
                    at: item.outputURL.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try runner(item.ffmpegArguments)
                builtItems.append(item)
            } catch {
                failures.append(ProjectMediaProxyBuildFailure(item: item, message: String(describing: error)))
            }
        }

        return ProjectMediaProxyBuildResult(
            plan: plan,
            builtItems: builtItems,
            skippedItems: skippedItems,
            failures: failures
        )
    }

    private static func runFfmpeg(_ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["ffmpeg"] + arguments
        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw ProxyBuildError.ffmpegFailed("ffmpeg exited with status \(process.terminationStatus)")
        }
    }
}

private enum ProxyBuildError: Error, CustomStringConvertible {
    case ffmpegFailed(String)

    var description: String {
        switch self {
        case .ffmpegFailed(let message):
            return message
        }
    }
}
