import Foundation

public struct ProjectPipelineGateStatus: Equatable, Sendable {
    public let projectURL: URL
    public let stateFileExists: Bool
    public let currentState: String?
    public let lastUpdated: String?
    public let gates: [String: String]
    public let hasTimeline: Bool
    public let hasReview: Bool
    public let reviewStatus: String?
    public let reviewPatchOperationCount: Int
    public let renderCanRun: Bool
    public let renderReadinessLabel: String

    public var readinessLabel: String {
        if !stateFileExists { return "missing project state" }
        if !hasTimeline { return "needs compile" }
        if !hasReview { return "needs review" }
        if reviewStatus == "needs_revision" { return "needs revision pass" }
        if reviewStatus == "blocked" { return "review blocked" }
        if renderCanRun { return "ready to render" }
        return "waiting on gates"
    }

    public var gateSummaryLabel: String {
        let orderedKeys = [
            "analysis_gate",
            "planning_gate",
            "compile_gate",
            "timeline_gate",
            "review_gate",
            "packaging_gate"
        ]
        return orderedKeys.compactMap { key in
            gates[key].map { "\(key.replacingOccurrences(of: "_gate", with: ""))=\($0)" }
        }.joined(separator: " / ")
    }

    public var nextAction: String {
        if !stateFileExists {
            return "Run status or initialize the project so project_state.yaml exists."
        }
        if !hasTimeline {
            return "Compile the rough cut before review or render."
        }
        if !hasReview {
            return "Run Review with Codex to generate review_report.yaml and review_patch.json."
        }
        if reviewStatus == "blocked" {
            return "Resolve fatal review issues before compiling or rendering."
        }
        if reviewStatus == "needs_revision" {
            if reviewPatchOperationCount > 0 {
                return "Apply the review patch, then run Review again before render."
            }
            return "Address review weaknesses, recompile, then run Review again."
        }
        if renderCanRun {
            return "Render the final package or export the editor handoff packet."
        }
        return "Resolve gate state before render: \(renderReadinessLabel)."
    }
}

public enum ProjectPipelineGateStatusReader {
    public static func status(repositoryRoot: URL, projectURL: URL) -> ProjectPipelineGateStatus {
        let stateURL = projectURL.appendingPathComponent("project_state.yaml")
        let stateText = try? String(contentsOf: stateURL, encoding: .utf8)
        let review = ProjectReviewArtifactStatusReader.status(projectURL: projectURL)
        let renderPlan = ProjectRenderRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: projectURL)

        return ProjectPipelineGateStatus(
            projectURL: projectURL,
            stateFileExists: stateText != nil,
            currentState: stateText.flatMap { scalarValue("current_state", in: $0) },
            lastUpdated: stateText.flatMap { scalarValue("last_updated", in: $0) },
            gates: stateText.map(gates(in:)) ?? [:],
            hasTimeline: FileManager.default.fileExists(atPath: projectURL.appendingPathComponent("05_timeline/timeline.json").path),
            hasReview: review.reportExists,
            reviewStatus: review.judgmentStatus,
            reviewPatchOperationCount: review.patchOperationCount,
            renderCanRun: renderPlan.canRun,
            renderReadinessLabel: renderPlan.readinessLabel
        )
    }

    private static func scalarValue(_ key: String, in text: String) -> String? {
        let prefix = "\(key):"
        for rawLine in text.split(separator: "\n").map(String.init) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.hasPrefix(prefix) else { continue }
            return String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    private static func gates(in text: String) -> [String: String] {
        var inGates = false
        var result: [String: String] = [:]
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line == "gates:" {
                inGates = true
                continue
            }
            if inGates, !rawLine.hasPrefix(" "), line.hasSuffix(":") {
                break
            }
            guard inGates, rawLine.hasPrefix(" "), let separator = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<separator]).trimmingCharacters(in: .whitespacesAndNewlines)
            let value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty, !value.isEmpty {
                result[key] = value
            }
        }
        return result
    }
}
