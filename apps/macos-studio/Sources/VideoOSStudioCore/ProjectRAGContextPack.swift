import Foundation

public struct ProjectRAGContextPack: Equatable, Sendable {
    public let query: String
    public let items: [ProjectRAGContextItem]

    public init(query: String, items: [ProjectRAGContextItem]) {
        self.query = query
        self.items = items
    }

    public var isEmpty: Bool {
        items.isEmpty
    }

    public var promptText: String {
        guard !items.isEmpty else {
            return "Material RAG context for query `\(query)`: no indexed evidence found."
        }

        var lines = [
            "Material RAG context for query `\(query)`:",
            "Use these indexed evidence citations when reasoning. Cite document IDs, asset IDs, segment IDs, and source time ranges instead of making uncited claims."
        ]
        lines.append(contentsOf: items.map(\.promptLine))
        return lines.joined(separator: "\n")
    }

    public static func build(projectURL: URL, query: String, limit: Int = 8) throws -> ProjectRAGContextPack {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return ProjectRAGContextPack(query: "", items: [])
        }
        let results = try ProjectSQLiteIndex.search(projectURL: projectURL, query: trimmed, limit: limit)
        return ProjectRAGContextPack(query: trimmed, items: results.map(ProjectRAGContextItem.init(result:)))
    }

    public static func build(query: String, results: [ProjectSearchResult]) -> ProjectRAGContextPack {
        ProjectRAGContextPack(query: query, items: results.map(ProjectRAGContextItem.init(result:)))
    }
}

public struct ProjectRAGContextItem: Identifiable, Equatable, Sendable {
    public let documentID: String
    public let kind: String
    public let assetID: String?
    public let segmentID: String?
    public let startUS: Int?
    public let endUS: Int?
    public let title: String
    public let text: String
    public let tags: String

    public var id: String { documentID }

    public init(result: ProjectSearchResult) {
        self.documentID = result.documentID
        self.kind = result.kind
        self.assetID = Self.nonEmpty(result.assetID)
        self.segmentID = Self.nonEmpty(result.segmentID)
        self.startUS = result.startUS
        self.endUS = result.endUS
        self.title = result.title
        self.text = result.text
        self.tags = result.tags
    }

    public var citationLabel: String {
        var parts = ["doc=\(documentID)", "kind=\(kind)"]
        if let assetID {
            parts.append("asset=\(assetID)")
        }
        if let segmentID {
            parts.append("segment=\(segmentID)")
        }
        if let rangeLabel {
            parts.append("time=\(rangeLabel)")
        }
        return parts.joined(separator: " ")
    }

    public var rangeLabel: String? {
        switch (startUS, endUS) {
        case (.some(let start), .some(let end)) where start != end:
            return "\(Self.formatMicroseconds(start))-\(Self.formatMicroseconds(end))"
        case (.some(let start), _):
            return Self.formatMicroseconds(start)
        case (_, .some(let end)):
            return Self.formatMicroseconds(end)
        default:
            return nil
        }
    }

    public var promptLine: String {
        let titleText = Self.singleLine(title, limit: 120)
        let bodyText = Self.singleLine(text, limit: 220)
        let tagText = tags.trimmingCharacters(in: .whitespacesAndNewlines)
        var line = "- [\(citationLabel)] title=\"\(titleText)\""
        if !bodyText.isEmpty {
            line += " evidence=\"\(bodyText)\""
        }
        if !tagText.isEmpty {
            line += " tags=\"\(Self.singleLine(tagText, limit: 100))\""
        }
        return line
    }

    private static func singleLine(_ value: String, limit: Int) -> String {
        let normalized = value
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized.count > limit else { return normalized }
        return "\(normalized.prefix(max(0, limit - 1)))..."
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func formatMicroseconds(_ value: Int) -> String {
        let totalMilliseconds = max(0, value) / 1_000
        let milliseconds = totalMilliseconds % 1_000
        let totalSeconds = totalMilliseconds / 1_000
        let seconds = totalSeconds % 60
        let minutes = (totalSeconds / 60) % 60
        let hours = totalSeconds / 3_600
        if hours > 0 {
            return String(format: "%d:%02d:%02d.%03d", hours, minutes, seconds, milliseconds)
        }
        return String(format: "%02d:%02d.%03d", minutes, seconds, milliseconds)
    }
}
