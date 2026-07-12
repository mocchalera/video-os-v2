import CryptoKit
import Foundation

public struct ProjectArtifactSnapshot: Equatable, Sendable {
    public let projectURL: URL
    public let files: [String: ProjectArtifactFileState]

    public static let canonicalRoots = [
        "01_intent",
        "03_analysis",
        "04_plan",
        "05_timeline",
        "06_review",
        "07_handoff",
        "project_state.yaml"
    ]

    public static func capture(projectURL: URL) throws -> ProjectArtifactSnapshot {
        var files: [String: ProjectArtifactFileState] = [:]
        let fileManager = FileManager.default

        for root in canonicalRoots {
            let url = projectURL.appendingPathComponent(root)
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) else { continue }

            if isDirectory.boolValue {
                guard let enumerator = fileManager.enumerator(
                    at: url,
                    includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
                    options: [.skipsHiddenFiles]
                ) else { continue }

                for case let fileURL as URL in enumerator {
                    let relativePath = Self.relativePath(for: fileURL, projectURL: projectURL)
                    if Self.shouldSkip(relativePath: relativePath) {
                        enumerator.skipDescendants()
                        continue
                    }
                    let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                    guard values.isRegularFile == true else { continue }
                    files[relativePath] = try ProjectArtifactFileState(url: fileURL, relativePath: relativePath, fileSize: values.fileSize)
                }
            } else {
                let relativePath = Self.relativePath(for: url, projectURL: projectURL)
                if !Self.shouldSkip(relativePath: relativePath) {
                    let values = try url.resourceValues(forKeys: [.fileSizeKey])
                    files[relativePath] = try ProjectArtifactFileState(url: url, relativePath: relativePath, fileSize: values.fileSize)
                }
            }
        }

        return ProjectArtifactSnapshot(projectURL: projectURL, files: files)
    }

    public func diff(to after: ProjectArtifactSnapshot) -> [ProjectArtifactDiff] {
        let paths = Set(files.keys).union(after.files.keys)
        return paths.compactMap { path in
            let before = files[path]
            let after = after.files[path]
            let kind: ProjectArtifactDiff.Kind

            switch (before, after) {
            case (nil, .some):
                kind = .added
            case (.some, nil):
                kind = .removed
            case (.some(let before), .some(let after)):
                guard before.digest != after.digest else { return nil }
                kind = .modified
            case (nil, nil):
                return nil
            }

            return ProjectArtifactDiff(
                relativePath: path,
                kind: kind,
                before: before,
                after: after
            )
        }
        .sorted {
            if $0.kind.sortOrder == $1.kind.sortOrder {
                return $0.relativePath < $1.relativePath
            }
            return $0.kind.sortOrder < $1.kind.sortOrder
        }
    }

    private static func relativePath(for url: URL, projectURL: URL) -> String {
        let root = projectURL.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        if path.hasPrefix(root + "/") {
            return String(path.dropFirst(root.count + 1))
        }
        return url.lastPathComponent
    }

    private static func shouldSkip(relativePath: String) -> Bool {
        relativePath.hasPrefix("03_analysis/search/")
    }
}

public struct ProjectArtifactFileState: Equatable, Sendable {
    public let relativePath: String
    public let byteCount: Int
    public let digest: String
    public let contentKind: ProjectArtifactContentKind
    public let previewLines: [String]

    init(url: URL, relativePath: String, fileSize: Int?) throws {
        self.relativePath = relativePath
        byteCount = fileSize ?? 0
        let data = try Data(contentsOf: url)
        digest = SHA256.hash(data: data)
            .compactMap { String(format: "%02x", $0) }
            .joined()
        contentKind = ProjectArtifactContentKind(relativePath: relativePath)
        previewLines = Self.makePreviewLines(data: data, contentKind: contentKind)
    }

    private static func makePreviewLines(data: Data, contentKind: ProjectArtifactContentKind) -> [String] {
        guard contentKind != .other, data.count <= 128_000 else { return [] }
        let text: String?
        switch contentKind {
        case .json:
            if let object = try? JSONSerialization.jsonObject(with: data),
               let prettyData = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) {
                text = String(data: prettyData, encoding: .utf8)
            } else {
                text = String(data: data, encoding: .utf8)
            }
        case .yaml:
            text = String(data: data, encoding: .utf8)
        case .other:
            text = nil
        }

        return (text ?? "")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .prefix(120)
            .map { line in
                let line = String(line)
                if line.count <= 140 { return line }
                return String(line.prefix(137)) + "..."
            }
    }
}

public enum ProjectArtifactContentKind: String, Sendable {
    case json
    case yaml
    case other

    init(relativePath: String) {
        let ext = URL(fileURLWithPath: relativePath).pathExtension.lowercased()
        switch ext {
        case "json":
            self = .json
        case "yaml", "yml":
            self = .yaml
        default:
            self = .other
        }
    }
}

public struct ProjectArtifactDiff: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case added
        case modified
        case removed

        var sortOrder: Int {
            switch self {
            case .added: return 0
            case .modified: return 1
            case .removed: return 2
            }
        }
    }

    public var id: String { "\(kind.rawValue):\(relativePath)" }
    public let relativePath: String
    public let kind: Kind
    public let before: ProjectArtifactFileState?
    public let after: ProjectArtifactFileState?

    public var byteDelta: Int {
        (after?.byteCount ?? 0) - (before?.byteCount ?? 0)
    }

    public var detailLines: [String] {
        let kind = after?.contentKind ?? before?.contentKind ?? .other
        guard kind != .other else { return [] }

        switch self.kind {
        case .added:
            return (after?.previewLines ?? []).prefix(4).map { "+ \($0)" }
        case .removed:
            return (before?.previewLines ?? []).prefix(4).map { "- \($0)" }
        case .modified:
            return firstChangedLines(
                before: before?.previewLines ?? [],
                after: after?.previewLines ?? []
            )
        }
    }

    private func firstChangedLines(before: [String], after: [String]) -> [String] {
        let count = max(before.count, after.count)
        guard let index = (0..<count).first(where: { line(at: $0, in: before) != line(at: $0, in: after) }) else {
            return []
        }

        var lines: [String] = []
        if index > 0, let context = line(at: index - 1, in: after) {
            lines.append("  \(context)")
        }
        if let removed = line(at: index, in: before) {
            lines.append("- \(removed)")
        }
        if let added = line(at: index, in: after) {
            lines.append("+ \(added)")
        }
        for offset in 1...2 {
            if let context = line(at: index + offset, in: after), line(at: index + offset, in: before) == context {
                lines.append("  \(context)")
            }
        }
        return lines
    }

    private func line(at index: Int, in lines: [String]) -> String? {
        guard index >= 0, index < lines.count else { return nil }
        return lines[index]
    }
}
