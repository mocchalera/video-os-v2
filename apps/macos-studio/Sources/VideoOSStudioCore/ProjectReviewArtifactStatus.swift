import Foundation

public struct ProjectReviewArtifactStatus: Equatable, Sendable {
    public let projectURL: URL
    public let timelineURL: URL
    public let reviewReportURL: URL
    public let reviewPatchURL: URL
    public let hasTimeline: Bool
    public let reportExists: Bool
    public let reportReadable: Bool
    public let patchExists: Bool
    public let patchReadable: Bool
    public let judgmentStatus: String?
    public let rationale: String?
    public let confidence: String?
    public let strengthCount: Int
    public let weaknessCount: Int
    public let fatalIssueCount: Int
    public let warningCount: Int
    public let briefMismatchCount: Int
    public let blueprintMismatchCount: Int
    public let recommendedGoal: String?
    public let recommendedActions: [String]
    public let previewPath: String?
    public let patchOperationCount: Int
    public let patchOperationKinds: [String: Int]

    public var readinessLabel: String {
        if !hasTimeline { return "waiting for timeline" }
        if reportExists, !reportReadable { return "review report unreadable" }
        if patchExists, !patchReadable { return "review patch unreadable" }
        if !reportExists { return "not reviewed" }
        if fatalIssueCount > 0 || judgmentStatus == "blocked" { return "blocked" }
        if judgmentStatus == "needs_revision" { return "needs revision" }
        if judgmentStatus == "approved" { return "approved" }
        return "review readable"
    }

    public var issueLabel: String {
        "\(fatalIssueCount) fatal / \(warningCount) warning / \(weaknessCount) weakness"
    }

    public var mismatchLabel: String {
        "\(briefMismatchCount) brief / \(blueprintMismatchCount) blueprint"
    }

    public var patchLabel: String {
        if !patchExists { return "no patch" }
        if !patchReadable { return "unreadable" }
        if patchOperationCount == 0 { return "0 operations" }
        let kinds = patchOperationKinds
            .sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
            .map { "\($0.key): \($0.value)" }
            .joined(separator: ", ")
        return kinds.isEmpty ? "\(patchOperationCount) operations" : "\(patchOperationCount) operations (\(kinds))"
    }

    public var recommendation: String {
        if !hasTimeline {
            return "Compile a rough cut before running review."
        }
        if !reportExists {
            return "Run the Codex Review job to create review_report.yaml and review_patch.json."
        }
        if !reportReadable {
            return "Fix review_report.yaml before trusting rough-cut review state."
        }
        if patchExists, !patchReadable {
            return "Fix review_patch.json before applying review changes."
        }
        if fatalIssueCount > 0 || judgmentStatus == "blocked" {
            return "Resolve blocking review issues before render or editor handoff."
        }
        if judgmentStatus == "needs_revision" {
            return recommendedGoal ?? "Apply or address review feedback, then compile another pass."
        }
        if judgmentStatus == "approved" {
            return "Review is approved; the cut is ready for render packaging or editor handoff."
        }
        return recommendedGoal ?? "Inspect review findings before advancing the project."
    }
}

public enum ProjectReviewArtifactStatusReader {
    public static func status(projectURL: URL) -> ProjectReviewArtifactStatus {
        let timelineURL = projectURL.appendingPathComponent("05_timeline/timeline.json")
        let reportURL = projectURL.appendingPathComponent("06_review/review_report.yaml")
        let patchURL = projectURL.appendingPathComponent("06_review/review_patch.json")
        let reportText = read(reportURL)
        let patch = readPatch(patchURL)
        let reportExists = FileManager.default.fileExists(atPath: reportURL.path)
        let patchExists = FileManager.default.fileExists(atPath: patchURL.path)

        return ProjectReviewArtifactStatus(
            projectURL: projectURL,
            timelineURL: timelineURL,
            reviewReportURL: reportURL,
            reviewPatchURL: patchURL,
            hasTimeline: FileManager.default.fileExists(atPath: timelineURL.path),
            reportExists: reportExists,
            reportReadable: reportExists ? reportText != nil : false,
            patchExists: patchExists,
            patchReadable: patchExists ? patch != nil : false,
            judgmentStatus: reportText.flatMap { scalarValue("status", in: $0, after: "summary_judgment:") },
            rationale: reportText.flatMap { scalarValue("rationale", in: $0, after: "summary_judgment:") },
            confidence: reportText.flatMap { scalarValue("confidence", in: $0, after: "summary_judgment:") },
            strengthCount: reportText.map { itemCount(in: $0, after: "strengths:") } ?? 0,
            weaknessCount: reportText.map { itemCount(in: $0, after: "weaknesses:") } ?? 0,
            fatalIssueCount: reportText.map { itemCount(in: $0, after: "fatal_issues:") } ?? 0,
            warningCount: reportText.map { itemCount(in: $0, after: "warnings:") } ?? 0,
            briefMismatchCount: reportText.map { itemCount(in: $0, after: "mismatches_to_brief:") } ?? 0,
            blueprintMismatchCount: reportText.map { itemCount(in: $0, after: "mismatches_to_blueprint:") } ?? 0,
            recommendedGoal: reportText.flatMap { scalarValue("goal", in: $0, after: "recommended_next_pass:") },
            recommendedActions: reportText.map { stringList("actions", in: $0, after: "recommended_next_pass:") } ?? [],
            previewPath: reportText.flatMap { topLevelScalarValue("preview_path", in: $0) },
            patchOperationCount: patch?.operations.count ?? 0,
            patchOperationKinds: patch?.operationKinds ?? [:]
        )
    }

    private static func read(_ url: URL) -> String? {
        try? String(contentsOf: url, encoding: .utf8)
    }

    private static func readPatch(_ url: URL) -> ParsedPatch? {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let operations = object["operations"] as? [[String: Any]] else {
            return nil
        }
        var kinds: [String: Int] = [:]
        for operation in operations {
            guard let op = operation["op"] as? String else { continue }
            kinds[op, default: 0] += 1
        }
        return ParsedPatch(operations: operations, operationKinds: kinds)
    }

    private static func scalarValue(_ key: String, in text: String, after section: String) -> String? {
        var inSection = false
        for rawLine in lines(text) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line == section {
                inSection = true
                continue
            }
            if inSection, isTopLevelSection(rawLine) {
                return nil
            }
            if inSection, let value = keyedValue(line, key: key) {
                return value
            }
        }
        return nil
    }

    private static func topLevelScalarValue(_ key: String, in text: String) -> String? {
        for rawLine in lines(text) where !rawLine.hasPrefix(" ") {
            if let value = keyedValue(rawLine.trimmingCharacters(in: .whitespacesAndNewlines), key: key) {
                return value
            }
        }
        return nil
    }

    private static func itemCount(in text: String, after section: String) -> Int {
        var inSection = false
        var count = 0
        for rawLine in lines(text) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line == section {
                inSection = true
                continue
            }
            if inSection, isTopLevelSection(rawLine) {
                break
            }
            if inSection {
                if line == "[]" { return 0 }
                if line.hasPrefix("- ") { count += 1 }
            }
        }
        return count
    }

    private static func stringList(_ key: String, in text: String, after section: String) -> [String] {
        var inSection = false
        var inList = false
        var values: [String] = []
        for rawLine in lines(text) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line == section {
                inSection = true
                continue
            }
            if inSection, isTopLevelSection(rawLine) {
                break
            }
            if inSection, let value = keyedValue(line, key: key) {
                if value == "[]" { return [] }
                inList = true
                continue
            }
            if inSection, inList {
                if line.hasPrefix("- ") {
                    values.append(unquote(String(line.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines)))
                } else if !line.isEmpty, !rawLine.hasPrefix(" ") {
                    break
                }
            }
        }
        return values
    }

    private static func keyedValue(_ line: String, key: String) -> String? {
        let prefix = "\(key):"
        guard line.hasPrefix(prefix) else { return nil }
        return unquote(String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func unquote(_ value: String) -> String {
        var result = value
        if (result.hasPrefix("\"") && result.hasSuffix("\"")) ||
            (result.hasPrefix("'") && result.hasSuffix("'")) {
            result = String(result.dropFirst().dropLast())
        }
        return result
    }

    private static func lines(_ text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    private static func isTopLevelSection(_ rawLine: String) -> Bool {
        let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
        return !rawLine.hasPrefix(" ") && line.hasSuffix(":")
    }
}

private struct ParsedPatch {
    let operations: [[String: Any]]
    let operationKinds: [String: Int]
}
