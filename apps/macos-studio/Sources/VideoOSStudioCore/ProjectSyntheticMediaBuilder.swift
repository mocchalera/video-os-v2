import Foundation

public struct ProjectSyntheticMediaPlanItem: Identifiable, Equatable, Sendable {
    public var id: String { assetID }
    public let assetID: String
    public let filename: String
    public let outputURL: URL
    public let outputExists: Bool
    public let ffmpegArguments: [String]

    public var commandLine: String {
        (["ffmpeg"] + ffmpegArguments)
            .map(shellQuote)
            .joined(separator: " ")
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

public struct ProjectSyntheticMediaPlan: Equatable, Sendable {
    public let projectURL: URL
    public let outputDirectory: URL
    public let durationSeconds: Double
    public let items: [ProjectSyntheticMediaPlanItem]

    public var totalCount: Int {
        items.count
    }

    public var pendingCount: Int {
        items.filter { !$0.outputExists }.count
    }

    public var statusLabel: String {
        if items.isEmpty { return "no analyzed assets" }
        if pendingCount == 0 { return "synthetic media ready" }
        return "\(pendingCount) synthetic media files pending"
    }
}

public struct ProjectSyntheticMediaBuildFailure: Equatable, Sendable {
    public let item: ProjectSyntheticMediaPlanItem
    public let message: String
}

public struct ProjectSyntheticMediaBuildResult: Equatable, Sendable {
    public let plan: ProjectSyntheticMediaPlan
    public let builtItems: [ProjectSyntheticMediaPlanItem]
    public let skippedItems: [ProjectSyntheticMediaPlanItem]
    public let failures: [ProjectSyntheticMediaBuildFailure]
    public let sourceMapURL: URL?
    public let mappedCount: Int

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

public enum ProjectSyntheticMediaPlanner {
    public static func plan(
        projectURL: URL,
        assets: AnalysisAssetDocument? = nil,
        durationSeconds: Double = 5
    ) -> ProjectSyntheticMediaPlan {
        let resolvedAssets = assets ?? (try? AnalysisAssetDocument.load(from: projectURL.appendingPathComponent("03_analysis/assets.json")))
        let outputDirectory = projectURL.appendingPathComponent("02_media/synthetic")
        let items = (resolvedAssets?.items ?? []).enumerated().map { index, asset in
            let outputURL = outputDirectory.appendingPathComponent(outputFilename(for: asset))
            return ProjectSyntheticMediaPlanItem(
                assetID: asset.id,
                filename: asset.filename,
                outputURL: outputURL,
                outputExists: FileManager.default.fileExists(atPath: outputURL.path),
                ffmpegArguments: ffmpegArguments(
                    outputURL: outputURL,
                    index: index,
                    durationSeconds: max(1, min(durationSeconds, 60))
                )
            )
        }
        return ProjectSyntheticMediaPlan(
            projectURL: projectURL,
            outputDirectory: outputDirectory,
            durationSeconds: max(1, min(durationSeconds, 60)),
            items: items
        )
    }

    private static func outputFilename(for asset: AnalysisAsset) -> String {
        let filename = URL(fileURLWithPath: asset.filename).lastPathComponent
        let ext = URL(fileURLWithPath: filename).pathExtension.lowercased()
        if ["mov", "mp4", "m4v"].contains(ext) {
            return filename
        }
        let stem = URL(fileURLWithPath: filename).deletingPathExtension().lastPathComponent
        return "\(stem.isEmpty ? asset.id : stem).mp4"
    }

    private static func ffmpegArguments(outputURL: URL, index: Int, durationSeconds: Double) -> [String] {
        let colors = ["0x1f77b4", "0x2ca02c", "0xd62728", "0xff7f0e", "0x9467bd", "0x17becf"]
        let color = colors[index % colors.count]
        let frequency = 330 + (index % 8) * 55
        let duration = String(format: "%.2f", durationSeconds)
        return [
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-f", "lavfi",
            "-i", "color=c=\(color):s=1280x720:r=24:d=\(duration)",
            "-f", "lavfi",
            "-i", "sine=frequency=\(frequency):duration=\(duration)",
            "-shortest",
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-af", "loudnorm=I=-16:LRA=11:TP=-1.5",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            outputURL.path
        ]
    }
}

public enum ProjectSyntheticMediaBuilder {
    public typealias Runner = ([String]) throws -> Void

    public static func build(
        projectURL: URL,
        assets: AnalysisAssetDocument? = nil,
        durationSeconds: Double = 5,
        force: Bool = false
    ) -> ProjectSyntheticMediaBuildResult {
        build(projectURL: projectURL, assets: assets, durationSeconds: durationSeconds, force: force, runner: runFfmpeg)
    }

    public static func build(
        projectURL: URL,
        assets: AnalysisAssetDocument? = nil,
        durationSeconds: Double = 5,
        force: Bool = false,
        runner: Runner
    ) -> ProjectSyntheticMediaBuildResult {
        let plan = ProjectSyntheticMediaPlanner.plan(projectURL: projectURL, assets: assets, durationSeconds: durationSeconds)
        var builtItems: [ProjectSyntheticMediaPlanItem] = []
        var skippedItems: [ProjectSyntheticMediaPlanItem] = []
        var failures: [ProjectSyntheticMediaBuildFailure] = []

        for item in plan.items {
            if item.outputExists, !force {
                skippedItems.append(item)
                continue
            }
            do {
                try FileManager.default.createDirectory(at: item.outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try runner(item.ffmpegArguments)
                builtItems.append(item)
            } catch {
                failures.append(ProjectSyntheticMediaBuildFailure(item: item, message: String(describing: error)))
            }
        }

        let sourceMapURL: URL?
        let mappedCount: Int
        if failures.isEmpty, !plan.items.isEmpty {
            sourceMapURL = try? writeSourceMap(plan: plan)
            mappedCount = sourceMapURL == nil ? 0 : plan.items.count
        } else {
            sourceMapURL = nil
            mappedCount = 0
        }

        return ProjectSyntheticMediaBuildResult(
            plan: plan,
            builtItems: builtItems,
            skippedItems: skippedItems,
            failures: failures,
            sourceMapURL: sourceMapURL,
            mappedCount: mappedCount
        )
    }

    private static func writeSourceMap(plan: ProjectSyntheticMediaPlan) throws -> URL {
        let sourceMapURL = plan.projectURL.appendingPathComponent("02_media/source_map.json")
        try FileManager.default.createDirectory(at: sourceMapURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let items = plan.items.map { item in
            [
                "asset_id": item.assetID,
                "source_locator": relativePath(from: plan.projectURL, to: item.outputURL),
                "local_source_path": item.outputURL.path,
                "link_path": relativePath(from: plan.projectURL, to: item.outputURL),
                "display_name": item.filename,
                "kind": "asset"
            ]
        }
        let document: [String: Any] = [
            "version": "1",
            "project_id": plan.projectURL.lastPathComponent,
            "media_dir": "02_media",
            "generated_at": ISO8601DateFormatter().string(from: Date()),
            "items": items
        ]
        let data = try JSONSerialization.data(withJSONObject: document, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: sourceMapURL, options: .atomic)
        return sourceMapURL
    }

    private static func relativePath(from base: URL, to target: URL) -> String {
        let basePath = base.standardizedFileURL.path
        let targetPath = target.standardizedFileURL.path
        if targetPath.hasPrefix(basePath + "/") {
            return String(targetPath.dropFirst(basePath.count + 1))
        }
        return targetPath
    }

    private static func runFfmpeg(_ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["ffmpeg"] + arguments
        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw SyntheticMediaBuildError.ffmpegFailed("ffmpeg exited with status \(process.terminationStatus)")
        }
    }
}

private enum SyntheticMediaBuildError: Error, CustomStringConvertible {
    case ffmpegFailed(String)

    var description: String {
        switch self {
        case .ffmpegFailed(let message):
            return message
        }
    }
}
