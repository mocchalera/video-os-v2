import Foundation

public struct ProjectPromoFinishStatus: Equatable, Sendable {
    public let projectURL: URL
    public let outputDirectoryURL: URL
    public let workDirectoryURL: URL
    public let subtitleSidecarURL: URL
    public let finishedVideoURL: URL
    public let baseVideoURL: URL
    public let adjustedTimelineURL: URL
    public let renderTimelineURL: URL
    public let subtitleSidecarExists: Bool
    public let subtitleSidecarReadable: Bool
    public let captionCount: Int
    public let finishedVideoExists: Bool
    public let baseVideoExists: Bool
    public let adjustedTimelineExists: Bool
    public let renderTimelineExists: Bool

    public var readinessLabel: String {
        if subtitleSidecarExists, !subtitleSidecarReadable { return "promo subtitles unreadable" }
        if finishedVideoExists, subtitleSidecarExists, captionCount > 0 { return "promo finish ready" }
        if finishedVideoExists, subtitleSidecarExists { return "promo finish no captions" }
        if subtitleSidecarExists { return "promo subtitles ready" }
        if finishedVideoExists { return "promo video ready" }
        if baseVideoExists || adjustedTimelineExists || renderTimelineExists { return "promo finish incomplete" }
        return "promo finish missing"
    }

    public var missingRequiredArtifacts: [String] {
        var missing: [String] = []
        if !subtitleSidecarExists {
            missing.append("09_output/promo-finish/subtitles.ass")
        }
        if !finishedVideoExists {
            missing.append("09_output/promo-finished.mp4")
        }
        return missing
    }
}

public enum ProjectPromoFinishStatusReader {
    public static func status(projectURL: URL) -> ProjectPromoFinishStatus {
        let outputDirectoryURL = projectURL.appendingPathComponent("09_output")
        let workDirectoryURL = outputDirectoryURL.appendingPathComponent("promo-finish")
        let subtitleSidecarURL = workDirectoryURL.appendingPathComponent("subtitles.ass")
        let finishedVideoURL = preferredFinishedVideoURL(outputDirectoryURL: outputDirectoryURL)
        let baseVideoURL = workDirectoryURL.appendingPathComponent("base.mp4")
        let adjustedTimelineURL = workDirectoryURL.appendingPathComponent("timeline.adjusted.json")
        let renderTimelineURL = workDirectoryURL.appendingPathComponent("timeline.render.json")
        let fileManager = FileManager.default
        let subtitleSidecarExists = fileManager.fileExists(atPath: subtitleSidecarURL.path)
        let subtitleText = subtitleSidecarExists
            ? (try? String(contentsOf: subtitleSidecarURL, encoding: .utf8))
            : nil

        return ProjectPromoFinishStatus(
            projectURL: projectURL,
            outputDirectoryURL: outputDirectoryURL,
            workDirectoryURL: workDirectoryURL,
            subtitleSidecarURL: subtitleSidecarURL,
            finishedVideoURL: finishedVideoURL,
            baseVideoURL: baseVideoURL,
            adjustedTimelineURL: adjustedTimelineURL,
            renderTimelineURL: renderTimelineURL,
            subtitleSidecarExists: subtitleSidecarExists,
            subtitleSidecarReadable: subtitleSidecarExists ? subtitleText != nil : false,
            captionCount: subtitleText.map(countDialogueLines) ?? 0,
            finishedVideoExists: fileManager.fileExists(atPath: finishedVideoURL.path),
            baseVideoExists: fileManager.fileExists(atPath: baseVideoURL.path),
            adjustedTimelineExists: fileManager.fileExists(atPath: adjustedTimelineURL.path),
            renderTimelineExists: fileManager.fileExists(atPath: renderTimelineURL.path)
        )
    }

    private static func preferredFinishedVideoURL(outputDirectoryURL: URL) -> URL {
        let defaultURL = outputDirectoryURL.appendingPathComponent("promo-finished.mp4")
        if FileManager.default.fileExists(atPath: defaultURL.path) {
            return defaultURL
        }
        let candidates = ((try? FileManager.default.contentsOfDirectory(
            at: outputDirectoryURL,
            includingPropertiesForKeys: nil
        )) ?? [])
            .filter { url in
                let name = url.lastPathComponent
                return name.hasPrefix("promo-finished") && url.pathExtension.lowercased() == "mp4"
            }
            .sorted { lhs, rhs in
                lhs.lastPathComponent.localizedStandardCompare(rhs.lastPathComponent) == .orderedAscending
            }
        return candidates.first ?? defaultURL
    }

    private static func countDialogueLines(_ text: String) -> Int {
        text.split(whereSeparator: \.isNewline).reduce(into: 0) { count, rawLine in
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.range(of: #"^Dialogue:"#, options: [.regularExpression, .caseInsensitive]) != nil {
                count += 1
            }
        }
    }
}

public struct ProjectPromoFinishRunPlan: Equatable, Sendable {
    public let repositoryRoot: URL
    public let projectURL: URL
    public let scriptURL: URL
    public let timelineURL: URL
    public let outputURL: URL
    public let workDirectoryURL: URL
    public let hasScript: Bool
    public let hasTimeline: Bool
    public let transcriptFileCount: Int

    public var canRun: Bool {
        hasScript && hasTimeline && transcriptFileCount > 0
    }

    public var readinessLabel: String {
        if !hasScript { return "missing promo finish worker" }
        if !hasTimeline { return "missing timeline" }
        if transcriptFileCount <= 0 { return "missing transcripts" }
        return "ready to promo finish"
    }

    public var commandArguments: [String] {
        [
            "npm",
            "run",
            "promo-finish",
            "--",
            "--project",
            projectURL.path,
            "--output",
            outputURL.path,
            "--work-dir",
            workDirectoryURL.path
        ]
    }

    public var commandLine: String {
        commandArguments.map(shellQuote).joined(separator: " ")
    }

    private func shellQuote(_ value: String) -> String {
        guard !value.isEmpty else { return "''" }
        if value.range(of: #"[^A-Za-z0-9_@%+=:,./-]"#, options: .regularExpression) == nil {
            return value
        }
        return "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}

public struct ProjectPromoFinishRunResult: Equatable, Sendable {
    public let plan: ProjectPromoFinishRunPlan
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String
    public let status: ProjectPromoFinishStatus

    public var succeeded: Bool {
        exitCode == 0 && status.finishedVideoExists && status.subtitleSidecarExists
    }
}

public enum ProjectPromoFinishRunError: Error, Equatable, CustomStringConvertible {
    case notReady(String)

    public var description: String {
        switch self {
        case .notReady(let message):
            return message
        }
    }
}

public enum ProjectPromoFinishRunPlanner {
    public static func plan(repositoryRoot: URL, projectURL: URL) -> ProjectPromoFinishRunPlan {
        let outputURL = projectURL.appendingPathComponent("09_output/promo-finished.mp4")
        return ProjectPromoFinishRunPlan(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            scriptURL: repositoryRoot.appendingPathComponent("scripts/render-promo-cut.ts"),
            timelineURL: projectURL.appendingPathComponent("05_timeline/timeline.json"),
            outputURL: outputURL,
            workDirectoryURL: projectURL.appendingPathComponent("09_output/promo-finish"),
            hasScript: FileManager.default.fileExists(atPath: repositoryRoot.appendingPathComponent("scripts/render-promo-cut.ts").path),
            hasTimeline: FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("05_timeline/timeline.json").path),
            transcriptFileCount: transcriptFileCount(projectURL: projectURL)
        )
    }

    private static func transcriptFileCount(projectURL: URL) -> Int {
        let transcriptDirectoryURL = projectURL.appendingPathComponent("03_analysis/transcripts")
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: transcriptDirectoryURL,
            includingPropertiesForKeys: [.isRegularFileKey]
        )) ?? []
        return urls.filter { url in
            guard url.pathExtension.lowercased() == "json" else { return false }
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey])
            return values?.isRegularFile != false
        }.count
    }
}

public enum ProjectPromoFinishRunner {
    public typealias Runner = @Sendable (_ workingDirectory: URL, _ arguments: [String]) throws -> ProjectInitializationProcessResult

    public static func run(plan: ProjectPromoFinishRunPlan) throws -> ProjectPromoFinishRunResult {
        try run(plan: plan, runner: { workingDirectory, arguments in
            try runProcess(workingDirectory: workingDirectory, arguments: arguments)
        })
    }

    public static func run(
        plan: ProjectPromoFinishRunPlan,
        runner: Runner
    ) throws -> ProjectPromoFinishRunResult {
        guard plan.canRun else {
            throw ProjectPromoFinishRunError.notReady(plan.readinessLabel)
        }
        let result = try runner(plan.repositoryRoot, plan.commandArguments)
        return ProjectPromoFinishRunResult(
            plan: plan,
            exitCode: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            status: ProjectPromoFinishStatusReader.status(projectURL: plan.projectURL)
        )
    }

    private static func runProcess(
        workingDirectory: URL,
        arguments: [String]
    ) throws -> ProjectInitializationProcessResult {
        let output = try SubprocessRunner.run(
            arguments: arguments,
            currentDirectoryURL: workingDirectory
        )
        return ProjectInitializationProcessResult(
            status: output.exitCode,
            stdout: output.stdout,
            stderr: output.stderr
        )
    }
}
