import Foundation

public struct QADashboardDocument: Codable, Equatable, Sendable {
    public let index: QAImprovementIndexDocument?
    public let iterations: [QAIterationReport]

    public init(index: QAImprovementIndexDocument?, iterations: [QAIterationReport]) {
        self.index = index
        self.iterations = iterations
    }

    public static func load(projectURL: URL) -> QADashboardDocument {
        if let index = loadIndex(projectURL: projectURL) {
            let reports = index.iterations.compactMap { ref in
                loadReport(projectURL: projectURL, relativePath: ref.path)
            }
            return QADashboardDocument(index: index, iterations: reports)
        }

        return QADashboardDocument(
            index: nil,
            iterations: legacyReportURLs(projectURL: projectURL).compactMap(loadReport)
        )
    }

    public var latestScore: Int? {
        iterations.last?.overall_qa_score
    }

    public var baselineScore: Int? {
        iterations.first?.overall_qa_score
    }

    public var scoreImprovement: Int? {
        guard let latestScore, let baselineScore else { return nil }
        return latestScore - baselineScore
    }

    public var totalFixesApplied: Int {
        iterations.reduce(0) { total, report in
            total + (report.fixes?.count ?? 0)
        }
    }

    public var convergenceReason: String? {
        index?.convergence_reason
    }

    public var latestIssuesByClipID: [String: [QAIssueItem]] {
        guard let issues = iterations.last?.issues else { return [:] }
        let grouped = Dictionary(grouping: issues.compactMap { issue -> (String, QAIssueItem)? in
            guard let clipID = issue.clip_id, !clipID.isEmpty else { return nil }
            return (clipID, issue)
        }, by: \.0)
        return grouped.mapValues { pairs in
            pairs
                .map(\.1)
                .sorted { lhs, rhs in
                    if lhs.severity == rhs.severity {
                        return lhs.issue_id < rhs.issue_id
                    }
                    return lhs.severity > rhs.severity
                }
        }
    }

    private static func loadIndex(projectURL: URL) -> QAImprovementIndexDocument? {
        let url = projectURL.appendingPathComponent("06_review/qa-improvement-index.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(QAImprovementIndexDocument.self, from: data)
    }

    private static func loadReport(projectURL: URL, relativePath: String) -> QAIterationReport? {
        loadReport(url: reportURL(projectURL: projectURL, path: relativePath))
    }

    private static func loadReport(url: URL) -> QAIterationReport? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(QAIterationReport.self, from: data)
    }

    private static func reportURL(projectURL: URL, path: String) -> URL {
        if path.hasPrefix("/") {
            return URL(fileURLWithPath: path)
        }
        return projectURL.appendingPathComponent(path)
    }

    private static func legacyReportURLs(projectURL: URL) -> [URL] {
        let reviewURL = projectURL.appendingPathComponent("06_review")
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: reviewURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []

        return urls
            .filter { iterationNumber(from: $0.lastPathComponent) != nil }
            .sorted {
                let lhs = iterationNumber(from: $0.lastPathComponent) ?? 0
                let rhs = iterationNumber(from: $1.lastPathComponent) ?? 0
                if lhs == rhs {
                    return $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending
                }
                return lhs < rhs
            }
    }

    private static func iterationNumber(from filename: String) -> Int? {
        let prefix = "qa-improvement-report-iter"
        let suffix = ".json"
        guard filename.hasPrefix(prefix), filename.hasSuffix(suffix) else { return nil }
        let start = filename.index(filename.startIndex, offsetBy: prefix.count)
        let end = filename.index(filename.endIndex, offsetBy: -suffix.count)
        return Int(filename[start..<end])
    }
}

public struct QAImprovementIndexDocument: Codable, Equatable, Sendable {
    public let version: String
    public let project_id: String
    public let run_id: String
    public let base_timeline_hash: String
    public let result_timeline_hash: String
    public let convergence_reason: String
    public let iterations: [QAIterationRef]
}

public struct QAIterationRef: Codable, Equatable, Sendable {
    public let path: String
    public let iteration: Int
}

public struct QAIterationReport: Codable, Equatable, Sendable {
    public let iteration: Int
    public let total_issues: Int
    public let fixable_issues: Int
    public let overall_qa_score: Int?
    public let brief_alignment_scores: [String: Double]?
    public let issues: [QAIssueItem]?
    public let fixes: [QAFixItem]?
    public let timestamp: String?

    enum CodingKeys: String, CodingKey {
        case iteration
        case total_issues
        case fixable_issues
        case overall_qa_score
        case brief_alignment_scores
        case issues
        case fixes
        case timestamp
    }

    public init(
        iteration: Int,
        total_issues: Int,
        fixable_issues: Int,
        overall_qa_score: Int?,
        brief_alignment_scores: [String: Double]?,
        issues: [QAIssueItem]?,
        fixes: [QAFixItem]?,
        timestamp: String?
    ) {
        self.iteration = iteration
        self.total_issues = total_issues
        self.fixable_issues = fixable_issues
        self.overall_qa_score = overall_qa_score
        self.brief_alignment_scores = brief_alignment_scores
        self.issues = issues
        self.fixes = fixes
        self.timestamp = timestamp
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        iteration = try container.decode(Int.self, forKey: .iteration)
        total_issues = try container.decode(Int.self, forKey: .total_issues)
        fixable_issues = try container.decode(Int.self, forKey: .fixable_issues)
        overall_qa_score = try Self.decodeScore(container, forKey: .overall_qa_score)
        brief_alignment_scores = try container.decodeIfPresent([String: Double].self, forKey: .brief_alignment_scores)
        issues = try container.decodeIfPresent([QAIssueItem].self, forKey: .issues)
        fixes = try container.decodeIfPresent([QAFixItem].self, forKey: .fixes)
        timestamp = try container.decodeIfPresent(String.self, forKey: .timestamp)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(iteration, forKey: .iteration)
        try container.encode(total_issues, forKey: .total_issues)
        try container.encode(fixable_issues, forKey: .fixable_issues)
        try container.encodeIfPresent(overall_qa_score, forKey: .overall_qa_score)
        try container.encodeIfPresent(brief_alignment_scores, forKey: .brief_alignment_scores)
        try container.encodeIfPresent(issues, forKey: .issues)
        try container.encodeIfPresent(fixes, forKey: .fixes)
        try container.encodeIfPresent(timestamp, forKey: .timestamp)
    }

    private static func decodeScore(
        _ container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) throws -> Int? {
        if let value = try? container.decode(Int.self, forKey: key) {
            return value
        }
        guard let value = try? container.decode(Double.self, forKey: key) else {
            return nil
        }
        let normalized = value >= 0 && value <= 1 ? value * 100 : value
        return Int(normalized.rounded())
    }
}

public struct QAIssueItem: Codable, Equatable, Identifiable, Sendable {
    public var id: String { issue_id }

    public let issue_id: String
    public let type: String
    public let severity: Double
    public let timestamp_sec: Double
    public let clip_id: String?
    public let beat_id: String?
    public let description: String
    public let fixable: Bool?
    public let suggested_fix_type: String?
    public let source: String?
    public let source_category: String?
    public let source_axis: String?
    public let search_query: String?
    public let non_fixable_reason: String?
}

public struct QAFixItem: Codable, Equatable, Identifiable, Sendable {
    public var id: String { "\(issue_id):\(fix_type):\(target_clip_id)" }

    public let issue_id: String
    public let issue: QAIssueItem?
    public let fix_type: String
    public let target_clip_id: String
    public let target_beat_id: String
    public let replacement: QAFixReplacement?
    public let expected_improvement: Double?
    public let risk: String?
}

public struct QAFixReplacement: Codable, Equatable, Sendable {
    public let segment_id: String
    public let search_mode: String?
    public let search_score: Double?
    public let matched_frame_path: String?
    public let reason: String?
}
