import Foundation

public struct ProjectIntentSummary: Equatable, Sendable {
    public let projectURL: URL
    public let briefExists: Bool
    public let blockersExists: Bool
    public let title: String?
    public let strategy: String?
    public let format: String?
    public let runtimeTargetSeconds: String?
    public let primaryMessage: String?
    public let primaryAudience: String?
    public let emotionCurve: [String]
    public let mustHave: [String]
    public let mustAvoid: [String]
    public let autonomyMode: String?
    public let mayDecideCount: Int
    public let mustAsk: [String]
    public let blockerCount: Int
    public let softBlockerCount: Int
    public let openBlockerQuestions: [String]

    public var readinessLabel: String {
        if !briefExists { return "missing creative brief" }
        if !blockersExists { return "missing blockers artifact" }
        if blockerCount > 0 { return "intent blocked" }
        if softBlockerCount > 0 { return "intent has soft blockers" }
        return "intent ready"
    }

    public var displayTitle: String {
        title ?? projectURL.lastPathComponent
    }

    public var autonomyLabel: String {
        if let autonomyMode {
            return autonomyMode
        }
        return mustAsk.isEmpty ? "full inferred" : "collaborative inferred"
    }

    public var recommendation: String {
        if !briefExists {
            return "Run the Intent Codex job or create 01_intent/creative_brief.yaml before planning edits."
        }
        if !blockersExists {
            return "Run the Intent Codex job to create unresolved_blockers.yaml before Blueprint."
        }
        if blockerCount > 0 {
            return "Resolve blocker questions before compiling or handing off a rough cut."
        }
        if primaryMessage == nil {
            return "Brief exists, but the primary message is missing or unreadable."
        }
        return "Intent is readable; use it to guide triage, blueprint, review, and handoff decisions."
    }
}

public enum ProjectIntentSummaryReader {
    public static func summary(projectURL: URL) -> ProjectIntentSummary {
        let briefURL = projectURL.appendingPathComponent("01_intent/creative_brief.yaml")
        let blockersURL = projectURL.appendingPathComponent("01_intent/unresolved_blockers.yaml")
        let briefText = try? String(contentsOf: briefURL, encoding: .utf8)
        let blockersText = try? String(contentsOf: blockersURL, encoding: .utf8)
        let brief = briefText.map(YAMLSummaryReader.init(text:))
        let blockers = blockersText.map(BlockerSummaryReader.init(text:))

        return ProjectIntentSummary(
            projectURL: projectURL,
            briefExists: briefText != nil,
            blockersExists: blockersText != nil,
            title: brief?.scalar("project.title"),
            strategy: brief?.scalar("project.strategy"),
            format: brief?.scalar("project.format"),
            runtimeTargetSeconds: brief?.scalar("project.runtime_target_sec"),
            primaryMessage: brief?.scalar("message.primary"),
            primaryAudience: brief?.scalar("audience.primary"),
            emotionCurve: brief?.array("emotion_curve") ?? [],
            mustHave: brief?.array("must_have") ?? [],
            mustAvoid: brief?.array("must_avoid") ?? [],
            autonomyMode: brief?.scalar("autonomy.mode"),
            mayDecideCount: brief?.array("autonomy.may_decide").count ?? 0,
            mustAsk: brief?.array("autonomy.must_ask") ?? [],
            blockerCount: blockers?.count(status: "blocker") ?? 0,
            softBlockerCount: blockers?.count(status: "soft") ?? 0,
            openBlockerQuestions: blockers?.openQuestions ?? []
        )
    }
}

private struct YAMLSummaryReader {
    private let scalars: [String: String]
    private let arrays: [String: [String]]

    init(text: String) {
        var scalars: [String: String] = [:]
        var arrays: [String: [String]] = [:]
        var stack: [String] = []

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            let indent = rawLine.prefix { $0 == " " }.count
            let level = max(0, indent / 2)

            if line.hasPrefix("- ") {
                let value = cleanScalar(String(line.dropFirst(2)))
                let keyPath = stack.prefix(level).joined(separator: ".")
                if !keyPath.isEmpty {
                    arrays[keyPath, default: []].append(value)
                }
                continue
            }

            guard let separator = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<separator]).trimmingCharacters(in: .whitespacesAndNewlines)
            let rawValue = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { continue }
            stack = Array(stack.prefix(level))
            stack.append(key)

            if !rawValue.isEmpty {
                scalars[stack.joined(separator: ".")] = cleanScalar(rawValue)
            }
        }

        self.scalars = scalars
        self.arrays = arrays
    }

    func scalar(_ key: String) -> String? {
        scalars[key].flatMap { $0.isEmpty ? nil : $0 }
    }

    func array(_ key: String) -> [String] {
        arrays[key] ?? []
    }
}

private struct BlockerSummaryReader {
    private let statuses: [String]
    let openQuestions: [String]

    init(text: String) {
        var statuses: [String] = []
        var questions: [String] = []
        var currentQuestion: String?
        var currentStatus: String?
        var inBlockers = false

        func flush() {
            guard currentQuestion != nil || currentStatus != nil else { return }
            let status = currentStatus ?? "unknown"
            statuses.append(status)
            if status == "blocker" || status == "soft" {
                if let currentQuestion, !currentQuestion.isEmpty {
                    questions.append(currentQuestion)
                }
            }
            currentQuestion = nil
            currentStatus = nil
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty, !line.hasPrefix("#") else { continue }
            if line == "blockers:" {
                inBlockers = true
                continue
            }
            guard inBlockers else { continue }

            if line.hasPrefix("- ") {
                flush()
                let item = String(line.dropFirst(2))
                if let value = keyedValue(item, key: "question") {
                    currentQuestion = value
                }
                if let value = keyedValue(item, key: "status") {
                    currentStatus = value
                }
                continue
            }
            if let value = keyedValue(line, key: "question") {
                currentQuestion = value
            } else if let value = keyedValue(line, key: "status") {
                currentStatus = value
            }
        }
        flush()

        self.statuses = statuses
        self.openQuestions = questions
    }

    func count(status: String) -> Int {
        statuses.filter { $0 == status }.count
    }
}

private func keyedValue(_ line: String, key: String) -> String? {
    let prefix = "\(key):"
    guard line.hasPrefix(prefix) else { return nil }
    return cleanScalar(String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines))
}

private func cleanScalar(_ value: String) -> String {
    var result = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if (result.hasPrefix("\"") && result.hasSuffix("\"")) ||
        (result.hasPrefix("'") && result.hasSuffix("'")) {
        result = String(result.dropFirst().dropLast())
    }
    return result
}
