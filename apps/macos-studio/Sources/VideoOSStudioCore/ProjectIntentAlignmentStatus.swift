import Foundation

public struct ProjectIntentAlignmentStatus: Equatable, Sendable {
    public let projectURL: URL
    public let hasBrief: Bool
    public let hasTimeline: Bool
    public let hasReview: Bool
    public let reviewStatus: String?
    public let mustHaveCovered: [String]
    public let mustHaveMissing: [String]
    public let mustAvoidAcknowledged: [String]
    public let briefMismatchCount: Int

    public var readinessLabel: String {
        if !hasBrief { return "missing intent" }
        if !hasTimeline { return "waiting for timeline" }
        if !hasReview { return "waiting for review" }
        if briefMismatchCount > 0 { return "brief mismatch" }
        if reviewStatus == "needs_revision" { return "review needs revision" }
        if !mustHaveMissing.isEmpty { return "intent evidence incomplete" }
        return "intent aligned"
    }

    public var coverageLabel: String {
        "\(mustHaveCovered.count)/\(mustHaveCovered.count + mustHaveMissing.count) must-have cues"
    }

    public var recommendation: String {
        if !hasBrief {
            return "Create the creative brief before checking rough-cut alignment."
        }
        if !hasTimeline {
            return "Compile a timeline before checking whether the rough cut follows the brief."
        }
        if !hasReview {
            return "Run Review so mismatches_to_brief can confirm or challenge this evidence scan."
        }
        if briefMismatchCount > 0 {
            return "Resolve review mismatches to brief before editor handoff or render."
        }
        if reviewStatus == "needs_revision" {
            return "Review recommends another pass; inspect weaknesses before final handoff."
        }
        if !mustHaveMissing.isEmpty {
            return "Search or revise the cut for missing must-have cues before calling the rough cut aligned."
        }
        return "Timeline, planning, and review evidence are consistent with the current intent brief."
    }
}

public enum ProjectIntentAlignmentStatusReader {
    public static func status(projectURL: URL) -> ProjectIntentAlignmentStatus {
        let intent = ProjectIntentSummaryReader.summary(projectURL: projectURL)
        let timelineURL = projectURL.appendingPathComponent("05_timeline/timeline.json")
        let reviewURL = projectURL.appendingPathComponent("06_review/review_report.yaml")
        let evidenceText = [
            read(projectURL.appendingPathComponent("04_plan/selects_candidates.yaml")),
            read(projectURL.appendingPathComponent("04_plan/edit_blueprint.yaml")),
            read(timelineURL),
            read(reviewURL),
        ]
            .compactMap { $0 }
            .joined(separator: "\n")
        let normalizedEvidence = normalized(evidenceText)
        let covered = intent.mustHave.filter { phraseMatches($0, evidence: normalizedEvidence) }
        let missing = intent.mustHave.filter { !phraseMatches($0, evidence: normalizedEvidence) }
        let acknowledgedAvoids = intent.mustAvoid.filter { phraseLooselyMatches($0, evidence: normalizedEvidence) }
        let reviewText = read(reviewURL)

        return ProjectIntentAlignmentStatus(
            projectURL: projectURL,
            hasBrief: intent.briefExists,
            hasTimeline: FileManager.default.fileExists(atPath: timelineURL.path),
            hasReview: FileManager.default.fileExists(atPath: reviewURL.path),
            reviewStatus: reviewText.flatMap { scalarValue("status", in: $0, after: "summary_judgment:") },
            mustHaveCovered: covered,
            mustHaveMissing: missing,
            mustAvoidAcknowledged: acknowledgedAvoids,
            briefMismatchCount: reviewText.map(mismatchCount(in:)) ?? 0
        )
    }

    private static func read(_ url: URL) -> String? {
        try? String(contentsOf: url, encoding: .utf8)
    }

    private static func phraseMatches(_ phrase: String, evidence: String) -> Bool {
        let tokens = normalized(phrase)
            .split(separator: " ")
            .map(String.init)
            .filter { token in
                token.count >= 4 && !["with", "that", "this", "feel", "least", "about"].contains(token)
            }
        guard !tokens.isEmpty else { return false }
        return tokens.allSatisfy { token in
            if evidence.contains(token) { return true }
            let stem = token.hasSuffix("ing") ? String(token.dropLast(3)) : token
            return stem.count >= 4 && evidence.contains(stem)
        }
    }

    private static func phraseLooselyMatches(_ phrase: String, evidence: String) -> Bool {
        let tokens = normalized(phrase)
            .split(separator: " ")
            .map(String.init)
            .filter { $0.count >= 4 }
        guard !tokens.isEmpty else { return false }
        let matched = tokens.filter { token in
            if evidence.contains(token) { return true }
            let stem = token.hasSuffix("ing") ? String(token.dropLast(3)) : token
            return stem.count >= 4 && evidence.contains(stem)
        }
        return matched.count >= min(2, tokens.count)
    }

    private static func normalized(_ value: String) -> String {
        value.lowercased().map { character in
            character.isLetter || character.isNumber ? character : " "
        }
        .reduce(into: "") { result, character in
            if character == " ", result.last == " " { return }
            result.append(character)
        }
    }

    private static func scalarValue(_ key: String, in text: String, after section: String) -> String? {
        var inSection = false
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line == section {
                inSection = true
                continue
            }
            if inSection, !rawLine.hasPrefix(" "), line.hasSuffix(":") {
                return nil
            }
            if inSection, let value = keyedValue(line, key: key) {
                return value
            }
        }
        return nil
    }

    private static func mismatchCount(in text: String) -> Int {
        guard let range = text.range(of: "mismatches_to_brief:") else { return 0 }
        let tail = text[range.upperBound...]
        if tail.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("[]") {
            return 0
        }
        var count = 0
        for rawLine in tail.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if rawLine.hasPrefix("mismatches_to_blueprint:") { break }
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("- ") { count += 1 }
        }
        return count
    }

    private static func keyedValue(_ line: String, key: String) -> String? {
        let prefix = "\(key):"
        guard line.hasPrefix(prefix) else { return nil }
        var result = String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        if (result.hasPrefix("\"") && result.hasSuffix("\"")) ||
            (result.hasPrefix("'") && result.hasSuffix("'")) {
            result = String(result.dropFirst().dropLast())
        }
        return result
    }
}
