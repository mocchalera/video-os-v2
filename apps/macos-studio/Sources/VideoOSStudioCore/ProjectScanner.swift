import Foundation

public struct ProjectSummary: Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let path: URL
    public let stateLabel: String
    public let hasTimeline: Bool
    public let hasReview: Bool
    public let mediaFileCount: Int

    public init(
        id: String,
        name: String,
        path: URL,
        stateLabel: String,
        hasTimeline: Bool,
        hasReview: Bool,
        mediaFileCount: Int
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.stateLabel = stateLabel
        self.hasTimeline = hasTimeline
        self.hasReview = hasReview
        self.mediaFileCount = mediaFileCount
    }
}

public enum ProjectScanner {
    public static func locateRepositoryRoot(
        startingAt start: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
        additionalCandidates: [URL] = []
    ) -> URL {
        let candidates = additionalCandidates + [start] + configuredRepositoryRootCandidates()
        for candidate in candidates {
            if let root = repositoryRoot(from: candidate) {
                return root
            }
        }
        return start.standardizedFileURL
    }

    private static func repositoryRoot(from start: URL) -> URL? {
        let fileManager = FileManager.default
        var cursor = start.standardizedFileURL

        while true {
            let packageJSON = cursor.appendingPathComponent("package.json")
            let schemas = cursor.appendingPathComponent("schemas")
            if fileManager.fileExists(atPath: packageJSON.path), fileManager.fileExists(atPath: schemas.path) {
                return cursor
            }

            let parent = cursor.deletingLastPathComponent()
            if parent.path == cursor.path {
                return nil
            }
            cursor = parent
        }
    }

    private static func configuredRepositoryRootCandidates() -> [URL] {
        var candidates: [URL] = []

        if let envRoot = ProcessInfo.processInfo.environment["VIDEO_OS_STUDIO_REPOSITORY_ROOT"], !envRoot.isEmpty {
            candidates.append(URL(fileURLWithPath: envRoot))
        }

        if let infoRoot = Bundle.main.object(forInfoDictionaryKey: "VideoOSStudioRepositoryRoot") as? String, !infoRoot.isEmpty {
            candidates.append(URL(fileURLWithPath: infoRoot))
        }

        let bundleURL = Bundle.main.bundleURL
        if bundleURL.pathExtension == "app" {
            candidates.append(bundleURL.deletingLastPathComponent().deletingLastPathComponent())
        }

        return candidates
    }

    public static func scanProjects(in repositoryRoot: URL) -> [ProjectSummary] {
        let fileManager = FileManager.default
        let projectsRoot = repositoryRoot.appendingPathComponent("projects")

        guard let entries = try? fileManager.contentsOfDirectory(
            at: projectsRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        return entries.compactMap { url in
            guard url.lastPathComponent != "_template" else { return nil }
            return summarizeProject(at: url)
        }
        .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    public static func summarizeProject(at url: URL) -> ProjectSummary? {
        let fileManager = FileManager.default
        let projectURL = url.standardizedFileURL
        guard isDirectory(projectURL) else { return nil }

        let timeline = projectURL.appendingPathComponent("05_timeline/timeline.json")
        let review = projectURL.appendingPathComponent("06_review/review_report.yaml")
        let state = projectURL.appendingPathComponent("project_state.yaml")
        let media = projectURL.appendingPathComponent("02_media/source")

        return ProjectSummary(
            id: projectURL.lastPathComponent,
            name: projectURL.lastPathComponent,
            path: projectURL,
            stateLabel: readStateLabel(from: state) ?? "未初期化",
            hasTimeline: fileManager.fileExists(atPath: timeline.path),
            hasReview: fileManager.fileExists(atPath: review.path),
            mediaFileCount: countMediaFiles(in: media)
        )
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
        return isDirectory.boolValue
    }

    private static func readStateLabel(from stateFile: URL) -> String? {
        guard let text = try? String(contentsOf: stateFile, encoding: .utf8) else {
            return nil
        }

        for line in text.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("current_state:") {
                return trimmed
                    .replacingOccurrences(of: "current_state:", with: "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return nil
    }

    private static func countMediaFiles(in mediaDirectory: URL) -> Int {
        guard let enumerator = FileManager.default.enumerator(
            at: mediaDirectory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            return 0
        }

        let mediaExtensions: Set<String> = ["aac", "aif", "aiff", "flac", "m4a", "m4v", "mov", "mp3", "mp4", "mxf", "wav"]
        var count = 0
        for case let file as URL in enumerator where mediaExtensions.contains(file.pathExtension.lowercased()) {
            count += 1
        }
        return count
    }
}
