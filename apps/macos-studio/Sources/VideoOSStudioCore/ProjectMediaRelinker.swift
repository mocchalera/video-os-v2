import Foundation

public struct ProjectMediaRelinkPlan: Equatable, Sendable {
    public let projectURL: URL
    public let sourceMapURL: URL
    public let searchRoots: [URL]
    public let missingAssetCount: Int
    public let syntheticAssetCount: Int
    public let items: [ProjectMediaRelinkItem]

    public var matchedCount: Int {
        items.filter { $0.candidateURL != nil }.count
    }

    public var unmatchedCount: Int {
        items.filter { $0.candidateURL == nil }.count
    }

    public var canApply: Bool {
        matchedCount > 0
    }

    public var statusLabel: String {
        if items.isEmpty { return "no relinks needed" }
        if matchedCount == 0 { return "no matches" }
        if unmatchedCount > 0 { return "\(matchedCount) matched / \(unmatchedCount) missing" }
        return "\(matchedCount) matched"
    }
}

public enum ProjectMediaRelinkReason: String, Equatable, Sendable {
    case missing
    case syntheticPreview = "synthetic-preview"
}

public struct ProjectMediaRelinkItem: Identifiable, Equatable, Sendable {
    public var id: String { assetID }
    public let assetID: String
    public let filename: String
    public let displayName: String?
    public let reason: ProjectMediaRelinkReason
    public let currentURL: URL?
    public let candidateURL: URL?
    public let matchedBy: String?
}

public struct ProjectMediaRelinkResult: Equatable, Sendable {
    public let sourceMapURL: URL
    public let linkedCount: Int
    public let skippedCount: Int
    public let symlinkURLs: [URL]
}

public struct ProjectMediaRelinkSearchRootSuggestion: Identifiable, Equatable, Sendable {
    public var id: String { url.path }
    public let url: URL
    public let referencedAssetCount: Int
    public let exists: Bool
}

public enum ProjectMediaRelinkError: Error, LocalizedError, Equatable {
    case noMatches
    case refusingToOverwriteNonSymlink(URL)

    public var errorDescription: String? {
        switch self {
        case .noMatches:
            return "No missing media files were matched."
        case .refusingToOverwriteNonSymlink(let url):
            return "Refusing to overwrite non-symlink media entry: \(url.path)"
        }
    }
}

public enum ProjectMediaRelinker {
    public static func suggestedSearchRoots(projectURL: URL) -> [ProjectMediaRelinkSearchRootSuggestion] {
        let document = ProjectMediaSourceMapDocument.load(from: sourceMapURL(for: projectURL))
        var countsByPath: [String: Int] = [:]

        for entry in document.items {
            for rawPath in [entry.localSourcePath, entry.sourceLocator] {
                guard let rawPath, rawPath.hasPrefix("/") else { continue }
                let directory = URL(fileURLWithPath: rawPath).deletingLastPathComponent().standardizedFileURL
                countsByPath[directory.path, default: 0] += 1
            }
        }

        return countsByPath.map { path, count in
            let url = URL(fileURLWithPath: path)
            return ProjectMediaRelinkSearchRootSuggestion(
                url: url,
                referencedAssetCount: count,
                exists: FileManager.default.fileExists(atPath: url.path)
            )
        }
        .sorted {
            if $0.exists != $1.exists { return $0.exists && !$1.exists }
            if $0.referencedAssetCount != $1.referencedAssetCount {
                return $0.referencedAssetCount > $1.referencedAssetCount
            }
            return $0.url.path < $1.url.path
        }
    }

    public static func availableSuggestedSearchRoots(projectURL: URL) -> [URL] {
        suggestedSearchRoots(projectURL: projectURL)
            .filter(\.exists)
            .map(\.url)
    }

    public static func plan(
        projectURL: URL,
        searchRoots: [URL],
        assets: AnalysisAssetDocument? = nil,
        includeSynthetic: Bool = false
    ) -> ProjectMediaRelinkPlan {
        let resolvedAssets = assets ?? (try? AnalysisAssetDocument.load(from: projectURL.appendingPathComponent("03_analysis/assets.json")))
        let mediaSummary = ProjectMediaResolver.previewSummary(projectURL: projectURL, assets: resolvedAssets)
        let missing = mediaSummary.items.filter { $0.playbackStatus == .missing }
        let synthetic = includeSynthetic ? mediaSummary.items.filter { $0.playbackStatus != .missing && $0.isSyntheticPreview } : []
        let index = CandidateIndex(searchRoots: searchRoots)
        let assetByID = Dictionary(uniqueKeysWithValues: (resolvedAssets?.items ?? []).map { ($0.id, $0) })

        return ProjectMediaRelinkPlan(
            projectURL: projectURL,
            sourceMapURL: sourceMapURL(for: projectURL),
            searchRoots: searchRoots,
            missingAssetCount: missing.count,
            syntheticAssetCount: synthetic.count,
            items: (missing.map { ($0, ProjectMediaRelinkReason.missing) }
                + synthetic.map { ($0, ProjectMediaRelinkReason.syntheticPreview) })
                .map { item, reason in
                let excludedPaths = Set([item.url?.standardizedFileURL.path].compactMap { $0 })
                let match = index.match(filename: item.filename, excluding: excludedPaths)
                let asset = assetByID[item.assetID]
                return ProjectMediaRelinkItem(
                    assetID: item.assetID,
                    filename: item.filename,
                    displayName: asset?.roleGuess ?? item.filename,
                    reason: reason,
                    currentURL: item.url,
                    candidateURL: match?.url,
                    matchedBy: match?.matchedBy
                )
            }
        )
    }

    @discardableResult
    public static func apply(plan: ProjectMediaRelinkPlan, generatedAt: Date = Date()) throws -> ProjectMediaRelinkResult {
        let matchedItems = plan.items.compactMap { item -> (ProjectMediaRelinkItem, URL)? in
            guard let url = item.candidateURL else { return nil }
            return (item, url)
        }
        guard !matchedItems.isEmpty else {
            throw ProjectMediaRelinkError.noMatches
        }

        let existing = ProjectMediaSourceMapDocument.load(from: plan.sourceMapURL)
        var entriesByAssetID = Dictionary(uniqueKeysWithValues: existing.items.map { ($0.assetID, $0) })
        var symlinkURLs: [URL] = []

        for (item, sourceURL) in matchedItems {
            if let previous = entriesByAssetID[item.assetID],
               let linkPath = previous.linkPath,
               linkPath.hasPrefix("02_media/relinked/") {
                let previousURL = resolve(linkPath, projectURL: plan.projectURL)
                try removeSymlinkIfPresent(previousURL)
            }

            let linkURL = relinkURL(projectURL: plan.projectURL, assetID: item.assetID, filename: item.filename)
            try ensureSymlink(linkURL: linkURL, sourceURL: sourceURL)
            symlinkURLs.append(linkURL)

            entriesByAssetID[item.assetID] = ProjectMediaSourceMapEntry(
                assetID: item.assetID,
                sourceLocator: sourceURL.path,
                localSourcePath: sourceURL.path,
                linkPath: relativePath(from: plan.projectURL, to: linkURL),
                displayName: item.displayName,
                kind: "asset",
                linkType: "symlink"
            )
        }

        let document = ProjectMediaSourceMapDocument(
            version: existing.version ?? "1",
            projectID: existing.projectID ?? plan.projectURL.lastPathComponent,
            mediaDir: existing.mediaDir ?? "02_media",
            generatedAt: ISO8601DateFormatter.videoOSSourceMap.string(from: generatedAt),
            items: entriesByAssetID.values.sorted { $0.assetID < $1.assetID }
        )
        try writeAtomicJSON(document, to: plan.sourceMapURL)

        return ProjectMediaRelinkResult(
            sourceMapURL: plan.sourceMapURL,
            linkedCount: matchedItems.count,
            skippedCount: plan.unmatchedCount,
            symlinkURLs: symlinkURLs
        )
    }

    public static func sourceMapURL(for projectURL: URL) -> URL {
        projectURL.appendingPathComponent("02_media/source_map.json")
    }

    private static func relinkURL(projectURL: URL, assetID: String, filename: String) -> URL {
        projectURL
            .appendingPathComponent("02_media/relinked")
            .appendingPathComponent("\(safeBasename(assetID))-\(URL(fileURLWithPath: filename).lastPathComponent)")
    }

    private static func ensureSymlink(linkURL: URL, sourceURL: URL) throws {
        try FileManager.default.createDirectory(at: linkURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try removeSymlinkIfPresent(linkURL)
        try FileManager.default.createSymbolicLink(at: linkURL, withDestinationURL: sourceURL)
    }

    private static func removeSymlinkIfPresent(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        if (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) == nil {
            throw ProjectMediaRelinkError.refusingToOverwriteNonSymlink(url)
        }
        try FileManager.default.removeItem(at: url)
    }

    private static func resolve(_ path: String, projectURL: URL) -> URL {
        if path.hasPrefix("/") {
            return URL(fileURLWithPath: path)
        }
        return projectURL.appendingPathComponent(path)
    }

    private static func relativePath(from base: URL, to target: URL) -> String {
        let basePath = base.standardizedFileURL.path
        let targetPath = target.standardizedFileURL.path
        if targetPath.hasPrefix(basePath + "/") {
            return String(targetPath.dropFirst(basePath.count + 1))
        }
        return targetPath
    }

    private static func safeBasename(_ value: String) -> String {
        let scalars = value.unicodeScalars.map { scalar -> Character in
            if CharacterSet.alphanumerics.contains(scalar) || scalar.value == 95 || scalar.value == 45 {
                return Character(scalar)
            }
            return "-"
        }
        let collapsed = String(scalars)
            .split(separator: "-", omittingEmptySubsequences: true)
            .joined(separator: "-")
        return collapsed.isEmpty ? "asset" : collapsed
    }

    private static func writeAtomicJSON<T: Encodable>(_ value: T, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(value)
        try data.write(to: url, options: .atomic)
    }
}

private struct CandidateIndex {
    private let candidatesByLowercaseFilename: [String: [URL]]

    init(searchRoots: [URL]) {
        var candidates: [String: [URL]] = [:]
        for root in searchRoots {
            for url in Self.fileURLs(under: root) {
                candidates[url.lastPathComponent.lowercased(), default: []].append(url)
            }
        }
        candidatesByLowercaseFilename = candidates.mapValues { urls in
            urls.sorted { $0.standardizedFileURL.path < $1.standardizedFileURL.path }
        }
    }

    func match(filename: String, excluding excludedPaths: Set<String> = []) -> (url: URL, matchedBy: String)? {
        let key = URL(fileURLWithPath: filename).lastPathComponent.lowercased()
        guard let url = candidatesByLowercaseFilename[key]?.first(where: { !excludedPaths.contains($0.standardizedFileURL.path) }) else {
            return nil
        }
        return (url, "filename")
    }

    private static func fileURLs(under root: URL) -> [URL] {
        let fileManager = FileManager.default
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: root.path, isDirectory: &isDirectory) else { return [] }
        if !isDirectory.boolValue { return [root] }

        let keys: [URLResourceKey] = [.isRegularFileKey, .isDirectoryKey]
        let enumerator = fileManager.enumerator(
            at: root,
            includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        )
        return (enumerator?.compactMap { element -> URL? in
            guard let url = element as? URL else { return nil }
            let values = try? url.resourceValues(forKeys: Set(keys))
            return values?.isRegularFile == true ? url : nil
        } ?? [])
    }
}

private struct ProjectMediaSourceMapDocument: Codable, Equatable {
    let version: String?
    let projectID: String?
    let mediaDir: String?
    let generatedAt: String?
    let items: [ProjectMediaSourceMapEntry]

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case mediaDir = "media_dir"
        case generatedAt = "generated_at"
        case items
    }

    static func load(from url: URL) -> ProjectMediaSourceMapDocument {
        guard let data = try? Data(contentsOf: url),
              let document = try? JSONDecoder().decode(ProjectMediaSourceMapDocument.self, from: data)
        else {
            return ProjectMediaSourceMapDocument(version: nil, projectID: nil, mediaDir: nil, generatedAt: nil, items: [])
        }
        return document
    }
}

private struct ProjectMediaSourceMapEntry: Codable, Equatable {
    let assetID: String
    let sourceLocator: String?
    let localSourcePath: String?
    let linkPath: String?
    let displayName: String?
    let kind: String?
    let linkType: String?

    enum CodingKeys: String, CodingKey {
        case assetID = "asset_id"
        case sourceLocator = "source_locator"
        case localSourcePath = "local_source_path"
        case linkPath = "link_path"
        case displayName = "display_name"
        case kind
        case linkType = "link_type"
    }
}

private extension ISO8601DateFormatter {
    static let videoOSSourceMap: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
