import Foundation

public struct ProjectMediaSourceMapStatus: Equatable, Sendable {
    public let projectURL: URL
    public let sourceMapURL: URL
    public let exists: Bool
    public let assetCount: Int
    public let entryCount: Int
    public let coveredAssetCount: Int
    public let readyAssetCount: Int
    public let missingAssetIDs: [String]
    public let brokenEntries: [ProjectMediaSourceMapBrokenEntry]
    public let relinkedSymlinkCount: Int
    public let absoluteLocalPathCount: Int
    public let generatedAt: String?

    public var coverageLabel: String {
        "\(coveredAssetCount) / \(assetCount)"
    }

    public var readinessLabel: String {
        if assetCount == 0 { return "no analyzed assets" }
        if !exists { return "source map missing" }
        if coveredAssetCount < assetCount { return "source map incomplete" }
        if !brokenEntries.isEmpty { return "source map has broken paths" }
        return "source map ready"
    }

    public var recommendation: String {
        if assetCount == 0 {
            return "Run analysis before source-map management."
        }
        if !exists {
            return "Relink missing media to create a durable source_map.json for preview, render, and editor handoff."
        }
        if coveredAssetCount < assetCount {
            return "Relink the missing assets so every analyzed asset has a source-map entry."
        }
        if !brokenEntries.isEmpty {
            return "Fix or relink broken source-map entries before render or editor handoff."
        }
        return "Source map covers every analyzed asset and all mapped sources are reachable."
    }
}

public struct ProjectMediaSourceMapBrokenEntry: Identifiable, Equatable, Sendable {
    public var id: String { assetID }
    public let assetID: String
    public let filename: String?
    public let checkedPaths: [String]
}

public enum ProjectMediaSourceMapStatusReader {
    public static func status(projectURL: URL, assets: AnalysisAssetDocument? = nil) -> ProjectMediaSourceMapStatus {
        let resolvedAssets = assets ?? (try? AnalysisAssetDocument.load(from: projectURL.appendingPathComponent("03_analysis/assets.json")))
        let sourceMapURL = projectURL.appendingPathComponent("02_media/source_map.json")
        let document = SourceMapDocument.load(from: sourceMapURL)
        let entriesByAssetID = Dictionary(uniqueKeysWithValues: document.items.map { ($0.assetID, $0) })
        let assetItems = resolvedAssets?.items ?? []
        let assetIDs = Set(assetItems.map(\.id))
        let coveredAssetIDs = Set(document.items.map(\.assetID)).intersection(assetIDs)
        let missingAssetIDs = assetItems.map(\.id).filter { !coveredAssetIDs.contains($0) }
        let filenameByAssetID = Dictionary(uniqueKeysWithValues: assetItems.map { ($0.id, $0.filename) })
        var readyAssetCount = 0
        var brokenEntries: [ProjectMediaSourceMapBrokenEntry] = []
        var relinkedSymlinkCount = 0
        var absoluteLocalPathCount = 0

        for asset in assetItems {
            guard let entry = entriesByAssetID[asset.id] else { continue }
            let paths = entry.candidatePaths(projectURL: projectURL)
            if paths.contains(where: { FileManager.default.fileExists(atPath: $0.path) }) {
                readyAssetCount += 1
            } else {
                brokenEntries.append(ProjectMediaSourceMapBrokenEntry(
                    assetID: asset.id,
                    filename: filenameByAssetID[asset.id],
                    checkedPaths: paths.map(\.path)
                ))
            }
            if let linkPath = entry.linkPath, linkPath.hasPrefix("02_media/relinked/") {
                let linkURL = resolve(linkPath, projectURL: projectURL)
                if (try? FileManager.default.destinationOfSymbolicLink(atPath: linkURL.path)) != nil {
                    relinkedSymlinkCount += 1
                }
            }
            if let localSourcePath = entry.localSourcePath, localSourcePath.hasPrefix("/") {
                absoluteLocalPathCount += 1
            }
        }

        return ProjectMediaSourceMapStatus(
            projectURL: projectURL,
            sourceMapURL: sourceMapURL,
            exists: document.exists,
            assetCount: assetItems.count,
            entryCount: document.items.count,
            coveredAssetCount: coveredAssetIDs.count,
            readyAssetCount: readyAssetCount,
            missingAssetIDs: missingAssetIDs,
            brokenEntries: brokenEntries,
            relinkedSymlinkCount: relinkedSymlinkCount,
            absoluteLocalPathCount: absoluteLocalPathCount,
            generatedAt: document.generatedAt
        )
    }

    private static func resolve(_ path: String, projectURL: URL) -> URL {
        if path.hasPrefix("/") {
            return URL(fileURLWithPath: path)
        }
        return projectURL.appendingPathComponent(path)
    }
}

private struct SourceMapDocument: Decodable {
    let exists: Bool
    let generatedAt: String?
    let items: [SourceMapEntry]

    enum CodingKeys: String, CodingKey {
        case generatedAt = "generated_at"
        case items
    }

    init(exists: Bool, generatedAt: String?, items: [SourceMapEntry]) {
        self.exists = exists
        self.generatedAt = generatedAt
        self.items = items
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        exists = true
        generatedAt = try container.decodeIfPresent(String.self, forKey: .generatedAt)
        items = try container.decodeIfPresent([SourceMapEntry].self, forKey: .items) ?? []
    }

    static func load(from url: URL) -> SourceMapDocument {
        guard let data = try? Data(contentsOf: url),
              let document = try? JSONDecoder().decode(SourceMapDocument.self, from: data)
        else {
            return SourceMapDocument(exists: false, generatedAt: nil, items: [])
        }
        return document
    }
}

private struct SourceMapEntry: Decodable {
    let assetID: String
    let sourceLocator: String?
    let localSourcePath: String?
    let linkPath: String?

    enum CodingKeys: String, CodingKey {
        case assetID = "asset_id"
        case sourceLocator = "source_locator"
        case localSourcePath = "local_source_path"
        case linkPath = "link_path"
    }

    func candidatePaths(projectURL: URL) -> [URL] {
        [localSourcePath, linkPath, sourceLocator]
            .compactMap { value -> URL? in
                guard let value, !value.isEmpty else { return nil }
                if value.hasPrefix("/") {
                    return URL(fileURLWithPath: value)
                }
                return projectURL.appendingPathComponent(value)
            }
    }
}
