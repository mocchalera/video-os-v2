import Foundation

public struct ProjectMarlinPreferenceProjectStatus: Identifiable, Equatable, Sendable {
    public let id: String
    public let projectURL: URL
    public let readinessLabel: String
    public let mediaMissingCount: Int
    public let eventCount: Int
    public let findResultCount: Int
    public let segmentCount: Int
    public let coveredSegmentCount: Int
    public let coverageRatio: Double
    public let canPreferMarlin: Bool
    public let isMockArtifact: Bool
    public let recommendation: String
}

public struct ProjectMarlinPreferenceDecision: Equatable, Sendable {
    public let repositoryRoot: URL
    public let policyStatus: ProjectAnalysisPolicyStatus
    public let projects: [ProjectMarlinPreferenceProjectStatus]
    public let representativePlan: ProjectMarlinRepresentativePlan
    public let minimumCandidateProjectCount: Int

    public var evaluatedProjectCount: Int {
        projects.filter { !$0.isMockArtifact && ($0.eventCount + $0.findResultCount) > 0 }.count
    }

    public var candidateProjectCount: Int {
        projects.filter(\.canPreferMarlin).count
    }

    public var blockedEvaluatedProjectCount: Int {
        evaluatedProjectCount - candidateProjectCount
    }

    public var mediaBlockedEvaluatedProjects: [ProjectMarlinPreferenceProjectStatus] {
        projects.filter {
            !$0.isMockArtifact
                && !$0.canPreferMarlin
                && ($0.eventCount + $0.findResultCount) > 0
                && $0.mediaMissingCount > 0
        }
    }

    public var mediaBlockedEvaluatedProjectCount: Int {
        mediaBlockedEvaluatedProjects.count
    }

    public var totalEventCount: Int {
        projects.filter { !$0.isMockArtifact }.reduce(0) { $0 + $1.eventCount }
    }

    public var totalFindResultCount: Int {
        projects.filter { !$0.isMockArtifact }.reduce(0) { $0 + $1.findResultCount }
    }

    public var totalSegmentCount: Int {
        projects.reduce(0) { $0 + $1.segmentCount }
    }

    public var totalCoveredSegmentCount: Int {
        projects.reduce(0) { $0 + $1.coveredSegmentCount }
    }

    public var evaluatedSegmentCount: Int {
        projects
            .filter { !$0.isMockArtifact && ($0.eventCount + $0.findResultCount) > 0 }
            .reduce(0) { $0 + $1.segmentCount }
    }

    public var evaluatedCoveredSegmentCount: Int {
        projects
            .filter { !$0.isMockArtifact && ($0.eventCount + $0.findResultCount) > 0 }
            .reduce(0) { $0 + $1.coveredSegmentCount }
    }

    public var aggregateCoverageRatio: Double {
        guard evaluatedSegmentCount > 0 else { return 0 }
        return Double(evaluatedCoveredSegmentCount) / Double(evaluatedSegmentCount)
    }

    public var representativeCandidateBucketCount: Int {
        representativePlan.candidateCoveredBucketCount
    }

    public var representativeTargetBucketCount: Int {
        representativePlan.targetBucketCount
    }

    public var canPreferMarlinAsDefault: Bool {
        candidateProjectCount >= minimumCandidateProjectCount
            && representativeCandidateBucketCount == representativeTargetBucketCount
            && blockedEvaluatedProjectCount == 0
            && aggregateCoverageRatio >= 0.3
    }

    public var decisionLabel: String {
        if projects.isEmpty { return "no projects" }
        if evaluatedProjectCount == 0 { return "not evaluated" }
        if candidateProjectCount == 0 { return "not ready" }
        if candidateProjectCount < minimumCandidateProjectCount { return "needs representative coverage" }
        if representativeCandidateBucketCount < representativeTargetBucketCount { return "needs representative category evidence" }
        if blockedEvaluatedProjectCount > 0 { return "partially ready" }
        if canPreferMarlinAsDefault { return "ready for Marlin-first temporal VLM" }
        return "needs more evidence"
    }

    public var recommendation: String {
        switch decisionLabel {
        case "ready for Marlin-first temporal VLM":
            return "Marlin is affecting segment peaks across representative projects. It is reasonable to promote Marlin-first temporal semantics while keeping the existing VLM fallback."
        case "partially ready":
            if mediaBlockedEvaluatedProjectCount > 0 {
                let projectList = mediaBlockedEvaluatedProjects
                    .prefix(3)
                    .map { "\($0.id) (\($0.mediaMissingCount) missing)" }
                    .joined(separator: ", ")
                return "Some evaluated projects are blocked by missing source media: \(projectList). Relink those media roots or mount the original source volume before changing defaults."
            }
            return "Some evaluated projects are not Marlin candidates yet. Re-run materialization or evaluate why those projects lack Marlin-derived peak coverage before changing defaults."
        case "needs representative coverage":
            return "At least \(minimumCandidateProjectCount) representative projects should be Marlin candidates before changing the default temporal VLM policy."
        case "needs representative category evidence":
            return "Marlin candidates must cover interview/dialogue, music/beat-sync, and documentary/growth projects before changing the default temporal VLM policy."
        case "not ready":
            return "Marlin artifacts exist, but no evaluated project has enough Marlin-derived segment peak evidence to justify a default preference."
        case "not evaluated":
            return "Run Marlin evaluation on representative interview and music-video footage before deciding whether Marlin-2B should become preferred."
        case "no projects":
            return "Create or import projects, then run Marlin evaluation before making a default preference decision."
        default:
            return "Collect more Marlin evidence and segment peak materialization before changing defaults."
        }
    }
}

public enum ProjectMarlinPreferenceDecisionReader {
    public static func status(
        repositoryRoot: URL,
        minimumCandidateProjectCount: Int = 2
    ) -> ProjectMarlinPreferenceDecision {
        let policy = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: repositoryRoot)
        let representativePlan = ProjectMarlinRepresentativePlanReader.plan(repositoryRoot: repositoryRoot)
        let projects = ProjectScanner.scanProjects(in: repositoryRoot).map { project in
            let evidence = ProjectEvidenceStore.load(projectURL: project.path)
            let status = ProjectMarlinEvaluationStatusReader.status(projectURL: project.path, repositoryRoot: repositoryRoot)
            let media = ProjectMediaResolver.previewSummary(projectURL: project.path, assets: evidence.assets)
            return ProjectMarlinPreferenceProjectStatus(
                id: project.id,
                projectURL: project.path,
                readinessLabel: status.readinessLabel,
                mediaMissingCount: media.missingCount,
                eventCount: status.eventCount,
                findResultCount: status.findResultCount,
                segmentCount: status.segmentCount,
                coveredSegmentCount: status.segmentsWithMarlinPeakCount,
                coverageRatio: status.coverageRatio,
                canPreferMarlin: status.canPreferMarlin,
                isMockArtifact: status.isMockArtifact,
                recommendation: status.recommendation
            )
        }

        return ProjectMarlinPreferenceDecision(
            repositoryRoot: repositoryRoot,
            policyStatus: policy,
            projects: projects,
            representativePlan: representativePlan,
            minimumCandidateProjectCount: minimumCandidateProjectCount
        )
    }
}
