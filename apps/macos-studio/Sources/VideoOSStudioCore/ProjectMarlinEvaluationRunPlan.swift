import AVFoundation
import Foundation

public struct ProjectMarlinEvaluationRunPlan: Equatable, Sendable {
    public let repositoryRoot: URL
    public let projectURL: URL
    public let sourceURLs: [URL]
    public let skippedSourceCount: Int
    public let scriptURL: URL
    public var sourceAssetIDsByPath: [String: String] = [:]
    public var existingMarlinItemsByAssetID: [String: MarlinAssetEvents] = [:]
    public var sourceDurationsByPath: [String: Double] = [:]

    public var sourceCount: Int {
        sourceURLs.count
    }

    public var canRun: Bool {
        !sourceURLs.isEmpty && FileManager.default.fileExists(atPath: scriptURL.path)
    }

    public var readinessLabel: String {
        if !FileManager.default.fileExists(atPath: scriptURL.path) {
            return "missing script"
        }
        if sourceURLs.isEmpty {
            return "no video sources"
        }
        return "ready"
    }

    public func selectedSourceURLs(
        skipExisting: Bool = false,
        chunkSeconds: Int? = nil,
        chunkOverlapSeconds: Int? = nil
    ) -> [URL] {
        guard skipExisting else { return sourceURLs }
        return sourceURLs.filter { sourceURL in
            shouldEvaluateSource(
                sourceURL,
                chunkSeconds: chunkSeconds,
                chunkOverlapSeconds: chunkOverlapSeconds
            )
        }
    }

    public func selectedSourceCount(
        skipExisting: Bool = false,
        chunkSeconds: Int? = nil,
        chunkOverlapSeconds: Int? = nil
    ) -> Int {
        selectedSourceURLs(
            skipExisting: skipExisting,
            chunkSeconds: chunkSeconds,
            chunkOverlapSeconds: chunkOverlapSeconds
        ).count
    }

    public func processArguments(
        mock: Bool = false,
        requestTimeoutMs: Int? = nil,
        maxSources: Int? = nil,
        skipExisting: Bool = false,
        captionOnly: Bool = false,
        chunkSeconds: Int? = nil,
        chunkOverlapSeconds: Int? = nil,
        maxChunks: Int? = nil
    ) -> [String] {
        var args = [
            "npx",
            "tsx",
            scriptURL.path,
            "--project",
            projectURL.path,
            "--repo-root",
            repositoryRoot.path,
        ]
        if mock {
            args.append("--mock")
        }
        if let requestTimeoutMs {
            args.append("--request-timeout-ms")
            args.append(String(requestTimeoutMs))
        }
        if let maxSources {
            args.append("--max-sources")
            args.append(String(maxSources))
        }
        if skipExisting {
            args.append("--skip-existing")
        }
        if captionOnly {
            args.append("--caption-only")
        }
        if let chunkSeconds {
            args.append("--chunk-seconds")
            args.append(String(chunkSeconds))
        }
        if let chunkOverlapSeconds {
            args.append("--chunk-overlap-seconds")
            args.append(String(chunkOverlapSeconds))
        }
        if let maxChunks {
            args.append("--max-chunks")
            args.append(String(maxChunks))
        }
        args.append(contentsOf: selectedSourceURLs(
            skipExisting: skipExisting,
            chunkSeconds: chunkSeconds,
            chunkOverlapSeconds: chunkOverlapSeconds
        ).map(\.path))
        return args
    }

    public func commandLine(
        mock: Bool = false,
        requestTimeoutMs: Int? = nil,
        maxSources: Int? = nil,
        skipExisting: Bool = false,
        captionOnly: Bool = false,
        chunkSeconds: Int? = nil,
        chunkOverlapSeconds: Int? = nil,
        maxChunks: Int? = nil
    ) -> String {
        processArguments(
            mock: mock,
            requestTimeoutMs: requestTimeoutMs,
            maxSources: maxSources,
            skipExisting: skipExisting,
            captionOnly: captionOnly,
            chunkSeconds: chunkSeconds,
            chunkOverlapSeconds: chunkOverlapSeconds,
            maxChunks: maxChunks
        )
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

    private func shouldEvaluateSource(
        _ sourceURL: URL,
        chunkSeconds: Int?,
        chunkOverlapSeconds: Int?
    ) -> Bool {
        guard let assetID = sourceAssetIDsByPath[sourceURL.path],
              let artifactItem = existingMarlinItemsByAssetID[assetID]
        else {
            return true
        }
        guard let chunkSeconds else {
            return false
        }
        guard let durationSeconds = sourceDurationsByPath[sourceURL.path],
              durationSeconds > Double(chunkSeconds)
        else {
            return artifactItem.events.contains { $0.chunkIndex != nil }
        }

        let chunks = chunkIndices(
            durationSeconds: durationSeconds,
            chunkSeconds: chunkSeconds,
            chunkOverlapSeconds: chunkOverlapSeconds ?? 0
        )
        guard !chunks.isEmpty else { return false }
        let completed = Set(artifactItem.events.compactMap(\.chunkIndex))
        if completed.isEmpty {
            return true
        }
        return chunks.contains { !completed.contains($0) }
    }

    private func chunkIndices(
        durationSeconds: Double,
        chunkSeconds: Int,
        chunkOverlapSeconds: Int
    ) -> [Int] {
        guard durationSeconds.isFinite, durationSeconds > 0, chunkSeconds > 0 else { return [] }
        let overlap = max(0, chunkOverlapSeconds)
        guard overlap < chunkSeconds else { return [] }
        if durationSeconds <= Double(chunkSeconds) {
            return [0]
        }

        let step = Double(chunkSeconds - overlap)
        var indices: [Int] = []
        var start = 0.0
        var index = 0
        while start < durationSeconds {
            let end = min(durationSeconds, start + Double(chunkSeconds))
            indices.append(index)
            if end >= durationSeconds { break }
            start += step
            index += 1
        }
        return indices
    }
}

public struct ProjectMarlinEvaluationRunResult: Equatable, Sendable {
    public let exitCode: Int32
    public let standardOutput: String
    public let standardError: String

    public var succeeded: Bool {
        exitCode == 0
    }
}

public struct ProjectMarlinEvaluationRefreshResult: Equatable, Sendable {
    public let runResult: ProjectMarlinEvaluationRunResult
    public let indexSummary: ProjectIndexSummary?

    public var succeeded: Bool {
        runResult.succeeded
    }
}

public struct ProjectMarlinMaterializationPlan: Equatable, Sendable {
    public let repositoryRoot: URL
    public let projectURL: URL
    public let scriptURL: URL
    public let artifactURL: URL
    public let segmentsURL: URL

    public var canRun: Bool {
        let fileManager = FileManager.default
        return fileManager.fileExists(atPath: scriptURL.path)
            && fileManager.fileExists(atPath: artifactURL.path)
            && fileManager.fileExists(atPath: segmentsURL.path)
    }

    public var readinessLabel: String {
        let fileManager = FileManager.default
        if !fileManager.fileExists(atPath: scriptURL.path) {
            return "missing script"
        }
        if !fileManager.fileExists(atPath: artifactURL.path) {
            return "missing marlin artifact"
        }
        if !fileManager.fileExists(atPath: segmentsURL.path) {
            return "missing segments"
        }
        return "ready"
    }

    public func processArguments() -> [String] {
        [
            "npx",
            "tsx",
            scriptURL.path,
            "--project",
            projectURL.path,
            "--repo-root",
            repositoryRoot.path
        ]
    }

    public func commandLine() -> String {
        processArguments()
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

public enum ProjectMarlinMaterializationPlanner {
    public static func plan(repositoryRoot: URL, projectURL: URL) -> ProjectMarlinMaterializationPlan {
        ProjectMarlinMaterializationPlan(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            scriptURL: repositoryRoot.appendingPathComponent("scripts/marlin-materialize.ts"),
            artifactURL: projectURL.appendingPathComponent("03_analysis/marlin_events.json"),
            segmentsURL: projectURL.appendingPathComponent("03_analysis/segments.json")
        )
    }
}

public enum ProjectMarlinMaterializationRunner {
    public typealias Runner = (URL, [String]) throws -> ProjectMarlinEvaluationRunResult

    public static func run(
        plan: ProjectMarlinMaterializationPlan,
        runner: Runner? = nil
    ) throws -> ProjectMarlinEvaluationRunResult {
        try (runner ?? runProcess)(plan.repositoryRoot, plan.processArguments())
    }

    public static func runAndRefreshIndex(
        plan: ProjectMarlinMaterializationPlan,
        runner: Runner? = nil
    ) throws -> ProjectMarlinEvaluationRefreshResult {
        let runResult = try run(plan: plan, runner: runner)
        let indexSummary = runResult.succeeded
            ? try ProjectSQLiteIndex.rebuild(projectURL: plan.projectURL)
            : nil
        return ProjectMarlinEvaluationRefreshResult(
            runResult: runResult,
            indexSummary: indexSummary
        )
    }

    private static func runProcess(cwd: URL, arguments: [String]) throws -> ProjectMarlinEvaluationRunResult {
        let output = try SubprocessRunner.run(
            arguments: arguments,
            currentDirectoryURL: cwd
        )
        return ProjectMarlinEvaluationRunResult(
            exitCode: output.exitCode,
            standardOutput: output.stdout,
            standardError: output.stderr
        )
    }
}

public struct ProjectMarlinEvaluationNextPlan: Equatable, Sendable {
    public let queue: ProjectMarlinEvaluationQueue
    public let item: ProjectMarlinEvaluationQueueItem?
    public let runPlan: ProjectMarlinEvaluationRunPlan?

    public var canRun: Bool {
        runPlan?.canRun == true
    }

    public var readinessLabel: String {
        guard let item, let runPlan else {
            return queue.readinessLabel
        }
        if runPlan.canRun { return "ready" }
        return item.priorityLabel
    }

    public var recommendation: String {
        item?.recommendation ?? queue.nextAction
    }
}

public enum ProjectMarlinEvaluationRunPlanner {
    public static func plan(
        repositoryRoot: URL,
        projectURL: URL,
        assets: AnalysisAssetDocument? = nil,
        durationReader: ((URL) -> Double?)? = nil
    ) -> ProjectMarlinEvaluationRunPlan {
        let summary = ProjectMediaResolver.previewSummary(projectURL: projectURL, assets: assets)
        var sourceAssetIDsByPath: [String: String] = [:]
        var sourceDurationsByPath: [String: Double] = [:]
        let sourceURLs = summary.items.compactMap { item -> URL? in
            guard item.exists, item.playbackStatus != .directAudio else { return nil }
            guard let url = item.url else { return nil }
            sourceAssetIDsByPath[url.path] = item.assetID
            if let durationReader, let duration = durationReader(url) {
                sourceDurationsByPath[url.path] = duration
            }
            return url
        }
        let skipped = summary.items.count - sourceURLs.count
        let artifact = try? MarlinEventDocument.load(
            from: projectURL.appendingPathComponent("03_analysis/marlin_events.json")
        )
        let existingItemsByAssetID = Dictionary(
            uniqueKeysWithValues: (artifact?.items ?? []).map { ($0.assetID, $0) }
        )

        return ProjectMarlinEvaluationRunPlan(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            sourceURLs: sourceURLs,
            skippedSourceCount: skipped,
            scriptURL: repositoryRoot.appendingPathComponent("scripts/marlin-evaluate.ts"),
            sourceAssetIDsByPath: sourceAssetIDsByPath,
            existingMarlinItemsByAssetID: existingItemsByAssetID,
            sourceDurationsByPath: sourceDurationsByPath
        )
    }
}

public enum ProjectMarlinEvaluationNextPlanner {
    public static func plan(
        repositoryRoot: URL,
        skipExisting: Bool = false,
        chunkSeconds: Int? = nil,
        chunkOverlapSeconds: Int? = nil
    ) -> ProjectMarlinEvaluationNextPlan {
        let queue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: repositoryRoot)
        for item in queue.items where item.canRunEvaluation && !item.canPreferMarlin && !item.needsSegmentMaterialization {
            let assets = try? AnalysisAssetDocument.load(from: item.projectURL.appendingPathComponent("03_analysis/assets.json"))
            let runPlan = ProjectMarlinEvaluationRunPlanner.plan(
                repositoryRoot: repositoryRoot,
                projectURL: item.projectURL,
                assets: assets
            )
            if runPlan.selectedSourceCount(
                skipExisting: skipExisting,
                chunkSeconds: chunkSeconds,
                chunkOverlapSeconds: chunkOverlapSeconds
            ) > 0 {
                return ProjectMarlinEvaluationNextPlan(queue: queue, item: item, runPlan: runPlan)
            }
        }
        return ProjectMarlinEvaluationNextPlan(queue: queue, item: nil, runPlan: nil)
    }
}

public enum ProjectMarlinEvaluationRunner {
    public typealias Runner = (URL, [String]) throws -> ProjectMarlinEvaluationRunResult

    public static func run(
        plan: ProjectMarlinEvaluationRunPlan,
        mock: Bool = false,
        requestTimeoutMs: Int? = nil,
        maxSources: Int? = nil,
        skipExisting: Bool = false,
        captionOnly: Bool = false,
        chunkSeconds: Int? = nil,
        chunkOverlapSeconds: Int? = nil,
        maxChunks: Int? = nil,
        runtimeStatus: ProjectMarlinRuntimeStatus? = nil,
        modelAccessStatus: ProjectMarlinModelAccessStatus? = nil,
        runner: Runner? = nil
    ) throws -> ProjectMarlinEvaluationRunResult {
        guard !plan.selectedSourceURLs(
            skipExisting: skipExisting,
            chunkSeconds: chunkSeconds,
            chunkOverlapSeconds: chunkOverlapSeconds
        ).isEmpty else {
            return ProjectMarlinEvaluationRunResult(
                exitCode: 1,
                standardOutput: "",
                standardError: "No selected Marlin source files remain after applying skip-existing."
            )
        }
        if !mock, runner == nil {
            let runtime = runtimeStatus ?? ProjectMarlinRuntimeStatusReader.status(repositoryRoot: plan.repositoryRoot)
            guard runtime.isReadyForLiveMarlin else {
                return ProjectMarlinEvaluationRunResult(
                    exitCode: 1,
                    standardOutput: "",
                    standardError: "Marlin runtime is not ready: \(runtime.readinessLabel). \(runtime.recommendation) Setup: \(runtime.setupCommand)"
                )
            }
            let modelAccess = modelAccessStatus ?? ProjectMarlinModelAccessStatusReader.status(
                repositoryRoot: plan.repositoryRoot,
                pythonBinary: runtime.pythonBinary
            )
            guard modelAccess.isReadyForLiveMarlin else {
                return ProjectMarlinEvaluationRunResult(
                    exitCode: 1,
                    standardOutput: "",
                    standardError: "Marlin model access is not ready: \(modelAccess.readinessLabel). \(modelAccess.recommendation)"
                )
            }
        }
        return try (runner ?? runProcess)(plan.repositoryRoot, plan.processArguments(
            mock: mock,
            requestTimeoutMs: requestTimeoutMs,
            maxSources: maxSources,
            skipExisting: skipExisting,
            captionOnly: captionOnly,
            chunkSeconds: chunkSeconds,
            chunkOverlapSeconds: chunkOverlapSeconds,
            maxChunks: maxChunks
        ))
    }

    public static func runAndRefreshIndex(
        plan: ProjectMarlinEvaluationRunPlan,
        mock: Bool = false,
        requestTimeoutMs: Int? = nil,
        maxSources: Int? = nil,
        skipExisting: Bool = false,
        captionOnly: Bool = false,
        chunkSeconds: Int? = nil,
        chunkOverlapSeconds: Int? = nil,
        maxChunks: Int? = nil,
        runtimeStatus: ProjectMarlinRuntimeStatus? = nil,
        modelAccessStatus: ProjectMarlinModelAccessStatus? = nil,
        runner: Runner? = nil
    ) throws -> ProjectMarlinEvaluationRefreshResult {
        let runResult = try run(
            plan: plan,
            mock: mock,
            requestTimeoutMs: requestTimeoutMs,
            maxSources: maxSources,
            skipExisting: skipExisting,
            captionOnly: captionOnly,
            chunkSeconds: chunkSeconds,
            chunkOverlapSeconds: chunkOverlapSeconds,
            maxChunks: maxChunks,
            runtimeStatus: runtimeStatus,
            modelAccessStatus: modelAccessStatus,
            runner: runner
        )
        let indexSummary = runResult.succeeded
            ? try ProjectSQLiteIndex.rebuild(projectURL: plan.projectURL)
            : nil
        return ProjectMarlinEvaluationRefreshResult(
            runResult: runResult,
            indexSummary: indexSummary
        )
    }

    private static func runProcess(cwd: URL, arguments: [String]) throws -> ProjectMarlinEvaluationRunResult {
        let output = try SubprocessRunner.run(
            arguments: arguments,
            currentDirectoryURL: cwd
        )
        return ProjectMarlinEvaluationRunResult(
            exitCode: output.exitCode,
            standardOutput: output.stdout,
            standardError: output.stderr
        )
    }
}
