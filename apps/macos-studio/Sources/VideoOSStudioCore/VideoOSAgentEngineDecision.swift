import Foundation

public struct VideoOSAgentEngineDecision: Codable, Equatable, Sendable {
    public enum Action: String, Codable, Sendable {
        case runCompile = "run_compile"
        case block
    }

    public let engineAction: Action
    public let reason: String

    enum CodingKeys: String, CodingKey {
        case engineAction = "engine_action"
        case reason
    }

    public static func extract(from text: String) -> VideoOSAgentEngineDecision? {
        candidateJSONStrings(from: text).compactMap { candidate -> VideoOSAgentEngineDecision? in
            guard let data = candidate.data(using: .utf8),
                  let decision = try? JSONDecoder().decode(VideoOSAgentEngineDecision.self, from: data),
                  !decision.reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return nil
            }
            return decision
        }.first
    }

    private static func candidateJSONStrings(from text: String) -> [String] {
        var candidates: [String] = []
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{"), trimmed.hasSuffix("}") {
            candidates.append(trimmed)
        }

        let parts = text.components(separatedBy: "```")
        for index in parts.indices where index % 2 == 1 {
            var fenced = parts[index].trimmingCharacters(in: .whitespacesAndNewlines)
            if fenced.lowercased().hasPrefix("json") {
                fenced = String(fenced.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if fenced.hasPrefix("{"), fenced.hasSuffix("}") {
                candidates.append(fenced)
            }
        }

        if let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end {
            candidates.append(String(text[start...end]))
        }
        return candidates
    }
}
