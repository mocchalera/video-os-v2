import Foundation

public struct ProjectAnalysisPolicyStatus: Equatable, Sendable {
    public let repositoryRoot: URL
    public let policyURL: URL
    public let policyExists: Bool
    public let policyReadable: Bool
    public let vlmModelAlias: String?
    public let vlmInputMode: String?
    public let vlmPromptTemplateID: String?
    public let marlinEnabled: Bool?
    public let marlinMode: String?
    public let marlinRole: String?
    public let marlinModelAlias: String?
    public let marlinConnectorVersion: String?
    public let marlinWorkerPath: String?
    public let marlinMock: Bool?
    public let marlinOutputArtifact: String?

    public var readinessLabel: String {
        if !policyExists { return "missing policy" }
        if !policyReadable { return "policy unreadable" }
        if marlinEnabled == true { return "marlin enabled" }
        if marlinMode == "hybrid" { return "hybrid opt-in" }
        return "configured"
    }

    public var vlmPolicyLabel: String {
        [
            vlmModelAlias ?? "unknown model",
            vlmInputMode,
            vlmPromptTemplateID
        ]
            .compactMap { $0 }
            .joined(separator: " / ")
    }

    public var marlinPolicyLabel: String {
        let enabled = marlinEnabled.map { $0 ? "enabled" : "disabled" } ?? "unknown"
        let mode = marlinMode ?? "unknown"
        let mock = marlinMock == true ? "mock" : "live"
        return "\(enabled) / \(mode) / \(mock)"
    }

    public var preferredVLMRule: String {
        "Prefer Marlin only after marlin_events.json is readable, segment peak coverage is at least 30%, and Marlin-derived peak_analysis is present."
    }
}

public enum ProjectAnalysisPolicyStatusReader {
    public static func status(repositoryRoot: URL) -> ProjectAnalysisPolicyStatus {
        let policyURL = repositoryRoot.appendingPathComponent("runtime/analysis-defaults.yaml")
        let fileManager = FileManager.default
        let policyExists = fileManager.fileExists(atPath: policyURL.path)
        let text = try? String(contentsOf: policyURL, encoding: .utf8)
        let sections = text.map(parseSections(_:)) ?? [:]
        let vlm = sections["vlm"] ?? [:]
        let marlin = sections["marlin"] ?? [:]

        return ProjectAnalysisPolicyStatus(
            repositoryRoot: repositoryRoot,
            policyURL: policyURL,
            policyExists: policyExists,
            policyReadable: text != nil,
            vlmModelAlias: vlm["model_alias"],
            vlmInputMode: vlm["input_mode"],
            vlmPromptTemplateID: vlm["prompt_template_id"],
            marlinEnabled: parseBool(marlin["enabled"]),
            marlinMode: marlin["mode"],
            marlinRole: marlin["role"],
            marlinModelAlias: marlin["model_alias"],
            marlinConnectorVersion: marlin["connector_version"],
            marlinWorkerPath: marlin["worker_path"],
            marlinMock: parseBool(marlin["mock"]),
            marlinOutputArtifact: marlin["output_artifact"]
        )
    }

    private static func parseSections(_ text: String) -> [String: [String: String]] {
        var sections: [String: [String: String]] = [:]
        var currentSection: String?

        for rawLine in text.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }

            if !rawLine.hasPrefix(" "), !rawLine.hasPrefix("\t"), line.hasSuffix(":") {
                currentSection = String(line.dropLast())
                sections[currentSection ?? ""] = [:]
                continue
            }

            guard let currentSection, rawLine.hasPrefix(" "), let separator = line.firstIndex(of: ":") else {
                continue
            }

            let key = String(line[..<separator])
            let rawValue = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
            guard !rawValue.isEmpty, !rawValue.hasPrefix("[") else { continue }
            sections[currentSection]?[key] = rawValue.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        }

        return sections
    }

    private static func parseBool(_ value: String?) -> Bool? {
        guard let value else { return nil }
        switch value.lowercased() {
        case "true": return true
        case "false": return false
        default: return nil
        }
    }
}
