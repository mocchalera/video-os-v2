import Foundation

public struct ProjectMediaReference: Identifiable, Equatable, Sendable {
    public var id: String { assetID }
    public let assetID: String
    public let filename: String
    public let displayName: String
    public let url: URL?
    public let exists: Bool
    public let sourceInUS: Int?
    public let sourceOutUS: Int?
    public let previewTimeUS: Int?
    public let resolvedFrom: String

    public var sourceStartSeconds: Double {
        Double(previewTimeUS ?? sourceInUS ?? 0) / 1_000_000
    }

    public var sourceRangeLabel: String {
        guard let sourceInUS, let sourceOutUS else { return "-" }
        return "\(formatMicroseconds(sourceInUS))-\(formatMicroseconds(sourceOutUS))"
    }

    public var isPlayableVideo: Bool {
        guard let url else { return false }
        return ["mov", "mp4", "m4v"].contains(url.pathExtension.lowercased())
    }

    public var isPlayableAudio: Bool {
        guard let url else { return false }
        return ["wav", "mp3", "m4a", "aif", "aiff"].contains(url.pathExtension.lowercased())
    }

    public var canPlayAudio: Bool {
        isPlayableAudio || isPlayableVideo
    }

    public var isVideoPlaybackReady: Bool {
        exists && isPlayableVideo
    }

    public var isAudioPlaybackReady: Bool {
        exists && canPlayAudio
    }

    private func formatMicroseconds(_ microseconds: Int) -> String {
        let seconds = Double(microseconds) / 1_000_000
        let total = max(0, Int(seconds.rounded(.down)))
        let minutes = total / 60
        let remainder = total % 60
        return "\(minutes):\(String(format: "%02d", remainder))"
    }
}

public struct ProjectMediaPreviewStatus: Identifiable, Equatable, Sendable {
    public enum PlaybackStatus: String, Sendable {
        case directVideo = "direct-video"
        case proxyVideo = "proxy-video"
        case directAudio = "direct-audio"
        case needsProxy = "needs-proxy"
        case missing = "missing"

        public var isReady: Bool {
            switch self {
            case .directVideo, .proxyVideo, .directAudio:
                return true
            case .needsProxy, .missing:
                return false
            }
        }
    }

    public var id: String { assetID }
    public let assetID: String
    public let filename: String
    public let url: URL?
    public let exists: Bool
    public let resolvedFrom: String
    public let playbackStatus: PlaybackStatus

    public var recommendation: String {
        switch playbackStatus {
        case .directVideo:
            return "Ready for direct viewer playback."
        case .proxyVideo:
            return "Ready through generated preview proxy."
        case .directAudio:
            return "Audio source is present; waveform/audio monitor can use it directly."
        case .needsProxy:
            return "Create a preview proxy before reliable native playback."
        case .missing:
            return "Relink or ingest the source media."
        }
    }
}

public struct ProjectMediaPreviewSummary: Equatable, Sendable {
    public let items: [ProjectMediaPreviewStatus]

    public init(items: [ProjectMediaPreviewStatus]) {
        self.items = items
    }

    public var readyCount: Int {
        items.filter { $0.playbackStatus.isReady }.count
    }

    public var missingCount: Int {
        items.filter { $0.playbackStatus == .missing }.count
    }

    public var proxyNeededCount: Int {
        items.filter { $0.playbackStatus == .needsProxy }.count
    }
}

public enum ProjectMediaResolver {
    public static func resolveSelectedClip(
        projectURL: URL,
        clip: TimelineClip,
        assets: AnalysisAssetDocument?,
        previewTimeUS: Int? = nil
    ) -> ProjectMediaReference? {
        let asset = assets?.items.first { $0.id == clip.assetID }
        let filename = asset?.filename ?? "\(clip.assetID)"
        let sourceMap = MediaSourceMapDocument.load(projectURL: projectURL)
        let entry = sourceMap?.items.first { $0.assetID == clip.assetID }
        let candidates = candidateURLs(projectURL: projectURL, filename: filename, entry: entry)
        let existing = candidates.first { FileManager.default.fileExists(atPath: $0.url.path) }
        let proxy = proxyCandidate(projectURL: projectURL, assetID: clip.assetID)
        let chosen: (url: URL, source: String)?
        if let existing, isPlayableVideo(existing.url) {
            chosen = existing
        } else if FileManager.default.fileExists(atPath: proxy.url.path) {
            chosen = proxy
        } else {
            chosen = existing ?? candidates.first
        }

        return ProjectMediaReference(
            assetID: clip.assetID,
            filename: filename,
            displayName: entry?.displayName ?? asset?.roleGuess ?? filename,
            url: chosen?.url,
            exists: chosen.map { FileManager.default.fileExists(atPath: $0.url.path) } ?? false,
            sourceInUS: clip.sourceInUS,
            sourceOutUS: clip.sourceOutUS,
            previewTimeUS: previewTimeUS,
            resolvedFrom: chosen?.source ?? "unresolved"
        )
    }

    public static func previewSummary(projectURL: URL, assets: AnalysisAssetDocument?) -> ProjectMediaPreviewSummary {
        let resolvedAssets = assets ?? (try? AnalysisAssetDocument.load(from: projectURL.appendingPathComponent("03_analysis/assets.json")))
        let sourceMap = MediaSourceMapDocument.load(projectURL: projectURL)
        let items = (resolvedAssets?.items ?? []).map { asset in
            previewStatus(projectURL: projectURL, asset: asset, sourceMap: sourceMap)
        }
        return ProjectMediaPreviewSummary(items: items)
    }

    private static func previewStatus(
        projectURL: URL,
        asset: AnalysisAsset,
        sourceMap: MediaSourceMapDocument?
    ) -> ProjectMediaPreviewStatus {
        let entry = sourceMap?.items.first { $0.assetID == asset.id }
        let candidates = candidateURLs(projectURL: projectURL, filename: asset.filename, entry: entry)
        let existing = candidates.first { FileManager.default.fileExists(atPath: $0.url.path) }
        let proxy = proxyCandidate(projectURL: projectURL, assetID: asset.id)
        let proxyExists = FileManager.default.fileExists(atPath: proxy.url.path)
        let chosen: (url: URL, source: String)?
        let status: ProjectMediaPreviewStatus.PlaybackStatus
        if let existing {
            let sourceStatus = playbackStatus(for: existing.url, exists: true)
            if sourceStatus == .needsProxy, proxyExists {
                chosen = proxy
                status = .proxyVideo
            } else {
                chosen = existing
                status = sourceStatus
            }
        } else if proxyExists {
            chosen = proxy
            status = .proxyVideo
        } else {
            chosen = candidates.first
            status = .missing
        }
        return ProjectMediaPreviewStatus(
            assetID: asset.id,
            filename: asset.filename,
            url: chosen?.url,
            exists: chosen.map { FileManager.default.fileExists(atPath: $0.url.path) } ?? false,
            resolvedFrom: chosen?.source ?? "unresolved",
            playbackStatus: status
        )
    }

    private static func candidateURLs(
        projectURL: URL,
        filename: String,
        entry: MediaSourceMapEntry?
    ) -> [(url: URL, source: String)] {
        var candidates: [(URL, String)] = []
        if let entry {
            candidates.append(contentsOf: [
                (resolve(entry.localSourcePath, projectURL: projectURL), "source_map.local_source_path"),
                (resolve(entry.linkPath, projectURL: projectURL), "source_map.link_path"),
                (resolve(entry.sourceLocator, projectURL: projectURL), "source_map.source_locator")
            ].compactMap { url, source in url.map { ($0, source) } })
        }

        candidates.append((projectURL.appendingPathComponent("02_media/source/\(filename)"), "02_media/source"))
        candidates.append((projectURL.appendingPathComponent("02_media/\(filename)"), "02_media"))

        var seen = Set<String>()
        return candidates.filter { candidate in
            let key = candidate.0.standardizedFileURL.path
            guard !seen.contains(key) else { return false }
            seen.insert(key)
            return true
        }
    }

    private static func resolve(_ path: String?, projectURL: URL) -> URL? {
        guard let path, !path.isEmpty else { return nil }
        if path.hasPrefix("/") {
            return URL(fileURLWithPath: path)
        }
        return projectURL.appendingPathComponent(path)
    }

    static func proxyURL(projectURL: URL, assetID: String) -> URL {
        proxyCandidate(projectURL: projectURL, assetID: assetID).url
    }

    private static func proxyCandidate(projectURL: URL, assetID: String) -> (url: URL, source: String) {
        (
            projectURL
                .appendingPathComponent("02_media/proxy")
                .appendingPathComponent("\(safeProxyBasename(assetID)).mp4"),
            "02_media/proxy"
        )
    }

    private static func safeProxyBasename(_ assetID: String) -> String {
        let scalars = assetID.unicodeScalars.map { scalar -> Character in
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

    private static func playbackStatus(for url: URL?, exists: Bool) -> ProjectMediaPreviewStatus.PlaybackStatus {
        guard exists, let url else { return .missing }
        let ext = url.pathExtension.lowercased()
        if ["mov", "mp4", "m4v"].contains(ext) {
            return .directVideo
        }
        if ["wav", "mp3", "m4a", "aif", "aiff"].contains(ext) {
            return .directAudio
        }
        return .needsProxy
    }

    private static func isPlayableVideo(_ url: URL) -> Bool {
        ["mov", "mp4", "m4v"].contains(url.pathExtension.lowercased())
    }
}

private struct MediaSourceMapDocument: Decodable {
    let items: [MediaSourceMapEntry]

    static func load(projectURL: URL) -> MediaSourceMapDocument? {
        let url = projectURL.appendingPathComponent("02_media/source_map.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(MediaSourceMapDocument.self, from: data)
    }
}

private struct MediaSourceMapEntry: Decodable {
    let assetID: String
    let sourceLocator: String?
    let localSourcePath: String?
    let linkPath: String?
    let displayName: String?

    enum CodingKeys: String, CodingKey {
        case assetID = "asset_id"
        case sourceLocator = "source_locator"
        case localSourcePath = "local_source_path"
        case linkPath = "link_path"
        case displayName = "display_name"
    }
}
