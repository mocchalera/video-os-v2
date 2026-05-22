import Foundation

public struct ProjectMarlinRepresentativeProject: Identifiable, Equatable, Sendable {
    public let id: String
    public let projectURL: URL
    public let tags: [String]
    public let title: String
    public let format: String
    public let canRunEvaluation: Bool
    public let canPreferMarlin: Bool
    public let mediaMissingCount: Int
    public let sourceCount: Int
    public let recommendation: String

    public var tagLabel: String {
        tags.isEmpty ? "general-footage" : tags.joined(separator: ", ")
    }

    public var readinessLabel: String {
        if canPreferMarlin { return "candidate" }
        if canRunEvaluation { return "ready to evaluate" }
        if mediaMissingCount > 0 { return "relink media" }
        if sourceCount == 0 { return "no video sources" }
        return "not ready"
    }
}

public struct ProjectMarlinRepresentativeBucket: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let rationale: String
    public let projectCount: Int
    public let runnableProjectCount: Int
    public let candidateProjectCount: Int
    public let blockedProjectCount: Int

    public var isCovered: Bool {
        runnableProjectCount > 0 || candidateProjectCount > 0
    }

    public var hasCandidateEvidence: Bool {
        candidateProjectCount > 0
    }

    public var readinessLabel: String {
        if candidateProjectCount > 0 { return "candidate evidence" }
        if runnableProjectCount > 0 { return "ready to evaluate" }
        if blockedProjectCount > 0 { return "blocked by media" }
        return "missing representative project"
    }
}

public struct ProjectMarlinRepresentativePlan: Equatable, Sendable {
    public let repositoryRoot: URL
    public let buckets: [ProjectMarlinRepresentativeBucket]
    public let projects: [ProjectMarlinRepresentativeProject]

    public var coveredBucketCount: Int {
        buckets.filter(\.isCovered).count
    }

    public var candidateCoveredBucketCount: Int {
        buckets.filter(\.hasCandidateEvidence).count
    }

    public var targetBucketCount: Int {
        buckets.count
    }

    public var readinessLabel: String {
        if projects.isEmpty { return "no projects" }
        if coveredBucketCount == targetBucketCount { return "representative evaluation ready" }
        if coveredBucketCount > 0 { return "partial representative coverage" }
        return "missing representative coverage"
    }

    public var nextAction: String {
        if let bucket = buckets.first(where: { !$0.isCovered }) {
            return "Import or relink a \(bucket.label) project before promoting Marlin-2B."
        }
        if let runnable = projects.first(where: { $0.canRunEvaluation && !$0.canPreferMarlin }) {
            return "Run marlin-eval-run \(runnable.id) to collect evidence for \(runnable.tagLabel)."
        }
        return "Review marlin-preference-status before changing the VLM default."
    }
}

public enum ProjectMarlinRepresentativePlanReader {
    private static let targetBuckets: [(id: String, label: String, rationale: String)] = [
        (
            "interview-dialogue",
            "Interview / dialogue",
            "Tests whether temporal semantics help testimonial, interview, and speaker-driven edits."
        ),
        (
            "music-beat",
            "Music / beat-sync",
            "Tests whether Marlin moments can support MV-like action, BGM, and beat-synced rough cuts."
        ),
        (
            "documentary-growth",
            "Documentary / growth story",
            "Tests whether Marlin improves chronological, emotional, and observational story arcs."
        ),
    ]

    public static func plan(repositoryRoot: URL) -> ProjectMarlinRepresentativePlan {
        let queue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: repositoryRoot)
        let projects = queue.items.map { item in
            let intent = ProjectIntentSummaryReader.summary(projectURL: item.projectURL)
            let tags = representativeTags(intent: intent, projectID: item.id)
            return ProjectMarlinRepresentativeProject(
                id: item.id,
                projectURL: item.projectURL,
                tags: tags,
                title: intent.displayTitle,
                format: intent.format ?? "-",
                canRunEvaluation: item.canRunEvaluation,
                canPreferMarlin: item.canPreferMarlin,
                mediaMissingCount: item.mediaMissingCount,
                sourceCount: item.sourceCount,
                recommendation: item.recommendation
            )
        }

        let buckets = targetBuckets.map { bucket in
            let matches = projects.filter { $0.tags.contains(bucket.id) }
            return ProjectMarlinRepresentativeBucket(
                id: bucket.id,
                label: bucket.label,
                rationale: bucket.rationale,
                projectCount: matches.count,
                runnableProjectCount: matches.filter(\.canRunEvaluation).count,
                candidateProjectCount: matches.filter(\.canPreferMarlin).count,
                blockedProjectCount: matches.filter { !$0.canRunEvaluation && !$0.canPreferMarlin }.count
            )
        }

        return ProjectMarlinRepresentativePlan(
            repositoryRoot: repositoryRoot,
            buckets: buckets,
            projects: projects.sorted(by: projectSort)
        )
    }

    private static func projectSort(_ lhs: ProjectMarlinRepresentativeProject, _ rhs: ProjectMarlinRepresentativeProject) -> Bool {
        let leftRank = lhs.canPreferMarlin ? 0 : (lhs.canRunEvaluation ? 1 : 2)
        let rightRank = rhs.canPreferMarlin ? 0 : (rhs.canRunEvaluation ? 1 : 2)
        if leftRank != rightRank { return leftRank < rightRank }
        if lhs.tags.count != rhs.tags.count { return lhs.tags.count > rhs.tags.count }
        return lhs.id < rhs.id
    }

    private static func representativeTags(intent: ProjectIntentSummary, projectID: String) -> [String] {
        let text = ([
            projectID,
            intent.displayTitle,
            intent.strategy,
            intent.format,
            intent.primaryMessage,
            intent.primaryAudience,
        ].compactMap { $0 } + intent.mustHave + intent.emotionCurve)
            .joined(separator: " ")
            .lowercased()

        var tags: [String] = []
        if containsAny(text, ["interview", "testimonial", "dialogue", "speaker", "participant", "インタビュー", "参加者", "対話"]) {
            tags.append("interview-dialogue")
        }
        if containsAny(text, ["music", "mv", "bgm", "beat", "sync", "song", "full-song", "曲", "歌", "リズム", "ビート", "名前のない坂"]) {
            tags.append("music-beat")
        }
        if containsAny(text, ["documentary", "growth", "keepsake", "family", "chronological", "成長", "記録", "家族", "時系列", "余韻"]) {
            tags.append("documentary-growth")
        }
        return tags.isEmpty ? ["general-footage"] : tags
    }

    private static func containsAny(_ text: String, _ needles: [String]) -> Bool {
        needles.contains { text.contains($0) }
    }
}
