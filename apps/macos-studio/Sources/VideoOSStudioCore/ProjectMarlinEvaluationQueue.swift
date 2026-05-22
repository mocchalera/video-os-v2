import Foundation

public struct ProjectMarlinEvaluationQueueItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let projectURL: URL
    public let evaluationReadinessLabel: String
    public let sourceMapReadinessLabel: String
    public let mediaMissingCount: Int
    public let proxyNeededCount: Int
    public let sourceCount: Int
    public let skippedSourceCount: Int
    public let eventCount: Int
    public let findResultCount: Int
    public let segmentCount: Int
    public let coveredSegmentCount: Int
    public let coverageRatio: Double
    public let canRunEvaluation: Bool
    public let canPreferMarlin: Bool

    public var priorityLabel: String {
        if canPreferMarlin { return "candidate" }
        if eventCount + findResultCount > 0 { return "materialize peaks" }
        if canRunEvaluation { return "ready to evaluate" }
        if mediaMissingCount > 0 { return "relink media" }
        if sourceCount == 0 { return "no video sources" }
        return evaluationReadinessLabel
    }

    public var recommendation: String {
        if canPreferMarlin {
            return "Already a Marlin preference candidate; keep this project in the representative set."
        }
        if eventCount + findResultCount > 0 {
            return "Marlin artifacts exist; re-run materialization through analysis/triage so segment peaks carry Marlin provenance."
        }
        if canRunEvaluation {
            return "Run marlin-eval-run \(id) to collect temporal semantic evidence for this project."
        }
        if mediaMissingCount > 0 {
            return "Relink source media or build synthetic media before running Marlin evaluation."
        }
        if sourceCount == 0 {
            return "Add or link at least one video source; audio-only sources are skipped for Marlin."
        }
        return "Restore the Marlin evaluation script or project analysis artifacts before evaluation."
    }
}

public struct ProjectMarlinEvaluationQueue: Equatable, Sendable {
    public let repositoryRoot: URL
    public let items: [ProjectMarlinEvaluationQueueItem]

    public var projectCount: Int {
        items.count
    }

    public var runnableProjectCount: Int {
        items.filter(\.canRunEvaluation).count
    }

    public var candidateProjectCount: Int {
        items.filter(\.canPreferMarlin).count
    }

    public var evaluatedProjectCount: Int {
        items.filter { $0.eventCount + $0.findResultCount > 0 }.count
    }

    public var mediaBlockedProjectCount: Int {
        items.filter { !$0.canRunEvaluation && $0.mediaMissingCount > 0 }.count
    }

    public var readinessLabel: String {
        if projectCount == 0 { return "no projects" }
        if candidateProjectCount > 0 { return "candidate evidence exists" }
        if runnableProjectCount > 0 { return "ready to evaluate" }
        if mediaBlockedProjectCount > 0 { return "media relink required" }
        return "no runnable evaluation"
    }

    public var nextAction: String {
        if let runnable = items.first(where: { $0.canRunEvaluation && !$0.canPreferMarlin }) {
            return "Run marlin-eval-run \(runnable.id) to start representative Marlin evaluation."
        }
        if let blocked = items.first(where: { $0.mediaMissingCount > 0 }) {
            return "Relink media for \(blocked.id) so Marlin can evaluate real footage."
        }
        if let candidate = items.first(where: \.canPreferMarlin) {
            return "\(candidate.id) is a candidate; evaluate another representative project before changing defaults."
        }
        return "Import or analyze video projects before Marlin preference evaluation."
    }
}

public enum ProjectMarlinEvaluationQueueReader {
    public static func queue(repositoryRoot: URL) -> ProjectMarlinEvaluationQueue {
        let items = ProjectScanner.scanProjects(in: repositoryRoot).map { project in
            item(repositoryRoot: repositoryRoot, project: project)
        }
        .sorted { lhs, rhs in
            let leftRank = rank(lhs)
            let rightRank = rank(rhs)
            if leftRank != rightRank { return leftRank < rightRank }
            if lhs.sourceCount != rhs.sourceCount { return lhs.sourceCount > rhs.sourceCount }
            return lhs.id < rhs.id
        }

        return ProjectMarlinEvaluationQueue(repositoryRoot: repositoryRoot, items: items)
    }

    private static func item(repositoryRoot: URL, project: ProjectSummary) -> ProjectMarlinEvaluationQueueItem {
        let evidence = ProjectEvidenceStore.load(projectURL: project.path)
        let evaluation = ProjectMarlinEvaluationStatusReader.status(projectURL: project.path, repositoryRoot: repositoryRoot)
        let plan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: project.path, assets: evidence.assets)
        let media = ProjectMediaResolver.previewSummary(projectURL: project.path, assets: evidence.assets)
        let sourceMap = ProjectMediaSourceMapStatusReader.status(projectURL: project.path, assets: evidence.assets)

        return ProjectMarlinEvaluationQueueItem(
            id: project.id,
            projectURL: project.path,
            evaluationReadinessLabel: evaluation.readinessLabel,
            sourceMapReadinessLabel: sourceMap.readinessLabel,
            mediaMissingCount: media.missingCount,
            proxyNeededCount: media.proxyNeededCount,
            sourceCount: plan.sourceCount,
            skippedSourceCount: plan.skippedSourceCount,
            eventCount: evaluation.eventCount,
            findResultCount: evaluation.findResultCount,
            segmentCount: evaluation.segmentCount,
            coveredSegmentCount: evaluation.segmentsWithMarlinPeakCount,
            coverageRatio: evaluation.coverageRatio,
            canRunEvaluation: plan.canRun,
            canPreferMarlin: evaluation.canPreferMarlin
        )
    }

    private static func rank(_ item: ProjectMarlinEvaluationQueueItem) -> Int {
        switch item.priorityLabel {
        case "candidate": return 0
        case "ready to evaluate": return 1
        case "materialize peaks": return 2
        case "relink media": return 3
        case "no video sources": return 4
        default: return 5
        }
    }
}
