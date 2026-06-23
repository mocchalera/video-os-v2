import AVFoundation
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

    public var viewerStartSeconds: Double {
        isSyntheticPreview ? 0 : sourceStartSeconds
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

    public var isSyntheticPreview: Bool {
        url?.standardizedFileURL.path.contains("/02_media/synthetic/") == true
    }

    public var isProxyPreview: Bool {
        resolvedFrom == "02_media/proxy"
            || url?.standardizedFileURL.path.contains("/02_media/proxy/") == true
    }

    public var isTimelinePreview: Bool {
        resolvedFrom == "05_timeline/previews"
            || resolvedFrom == "05_timeline/preview-full"
            || resolvedFrom == "05_timeline/preview-first30s"
            || resolvedFrom == "05_timeline/preview-editor"
            || resolvedFrom == "09_output/rough-cut"
            || resolvedFrom == "09_output/final"
            || resolvedFrom == "09_output/latest"
            || resolvedFrom == "07_package/video/final"
            || resolvedFrom == "07_package/assembly"
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

    public var viewerModeLabel: String {
        guard exists else { return "Missing media" }
        if isTimelinePreview { return "Timeline preview" }
        if isSyntheticPreview { return "Synthetic preview" }
        if isProxyPreview { return "Proxy preview" }
        if isPlayableVideo { return "Source preview" }
        if isPlayableAudio { return "Audio preview" }
        return "Unsupported media"
    }

    public var viewerNeedsAttention: Bool {
        !exists || isSyntheticPreview || isProxyPreview || (!isTimelinePreview && !isPlayableVideo && !isPlayableAudio)
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

    public var isSyntheticPreview: Bool {
        url?.standardizedFileURL.path.contains("/02_media/synthetic/") == true
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

    public var syntheticPreviewCount: Int {
        items.filter(\.isSyntheticPreview).count
    }

    public var playableVideoCount: Int {
        items.filter { item in
            item.playbackStatus == .directVideo || item.playbackStatus == .proxyVideo
        }.count
    }

    public var isViewerVideoReady: Bool {
        playableVideoCount > 0 && missingCount == 0 && proxyNeededCount == 0
    }
}

public struct ProjectViewerReadinessDiagnostic: Equatable, Sendable {
    public enum Severity: String, Sendable {
        case ready
        case info
        case warning
    }

    public enum Action: String, Sendable {
        case relinkSourceMedia
        case buildPreviewProxies
        case buildPreviewMedia
        case reviewPreviewSource

        public var label: String {
            switch self {
            case .relinkSourceMedia:
                return "Relink source media"
            case .buildPreviewProxies:
                return "Build preview proxies"
            case .buildPreviewMedia:
                return "Build preview media"
            case .reviewPreviewSource:
                return "Review preview source"
            }
        }
    }

    public let title: String
    public let detail: String
    public let action: Action?
    public let severity: Severity

    public var actionLabel: String? {
        action?.label
    }

    private init(
        title: String,
        detail: String,
        action: Action?,
        severity: Severity
    ) {
        self.title = title
        self.detail = detail
        self.action = action
        self.severity = severity
    }

    public static func diagnose(
        media: ProjectMediaReference?,
        previewSummary: ProjectMediaPreviewSummary
    ) -> ProjectViewerReadinessDiagnostic {
        if let media {
            return diagnose(media: media)
        }

        if previewSummary.items.isEmpty {
            return ProjectViewerReadinessDiagnostic(
                title: "Select a timeline clip",
                detail: "No media is currently resolved for the viewer.",
                action: nil,
                severity: .info
            )
        }

        if previewSummary.missingCount > 0 {
            return ProjectViewerReadinessDiagnostic(
                title: "Source media unavailable",
                detail: "\(previewSummary.missingCount) asset(s) are missing. Relink source media in the Media panel.",
                action: .relinkSourceMedia,
                severity: .warning
            )
        }

        if previewSummary.proxyNeededCount > 0 {
            return ProjectViewerReadinessDiagnostic(
                title: "Preview proxies needed",
                detail: "\(previewSummary.proxyNeededCount) asset(s) need H.264 preview proxies for native playback.",
                action: .buildPreviewProxies,
                severity: .warning
            )
        }

        if previewSummary.playableVideoCount == 0 {
            return ProjectViewerReadinessDiagnostic(
                title: "No playable video",
                detail: "No source, proxy, timeline preview, or rendered video is available to the viewer.",
                action: .buildPreviewMedia,
                severity: .warning
            )
        }

        return ProjectViewerReadinessDiagnostic(
            title: "Move playhead onto a clip",
            detail: "Playable media exists, but the current playhead position does not resolve to a video clip or timeline preview.",
            action: nil,
            severity: .info
        )
    }

    private static func diagnose(media: ProjectMediaReference) -> ProjectViewerReadinessDiagnostic {
        if !media.exists {
            return ProjectViewerReadinessDiagnostic(
                title: "Source media unavailable",
                detail: "Cannot find \(media.url?.path ?? media.filename).",
                action: .relinkSourceMedia,
                severity: .warning
            )
        }

        if media.isPlayableVideo {
            return ProjectViewerReadinessDiagnostic(
                title: "\(media.viewerModeLabel) ready",
                detail: media.url?.lastPathComponent ?? media.filename,
                action: media.viewerNeedsAttention ? .reviewPreviewSource : nil,
                severity: media.viewerNeedsAttention ? .info : .ready
            )
        }

        if media.isPlayableAudio {
            return ProjectViewerReadinessDiagnostic(
                title: "Audio-only source",
                detail: "\(media.url?.lastPathComponent ?? media.filename) has audio but no native video preview.",
                action: .buildPreviewProxies,
                severity: .warning
            )
        }

        return ProjectViewerReadinessDiagnostic(
            title: "Unsupported media",
            detail: "\(media.url?.lastPathComponent ?? media.filename) is present but cannot be played directly.",
            action: .buildPreviewProxies,
            severity: .warning
        )
    }
}

public enum ProjectMediaResolver {
    public static func preferredProgramMedia(
        timelinePreview: ProjectMediaReference?,
        source: ProjectMediaReference?
    ) -> ProjectMediaReference? {
        if let timelinePreview, timelinePreview.isVideoPlaybackReady {
            return timelinePreview
        }
        return source ?? timelinePreview
    }

    public static func resolveTimelinePreview(
        projectURL: URL,
        playheadSeconds: Double
    ) -> ProjectMediaReference? {
        resolveTimelinePreview(
            projectURL: projectURL,
            playheadSeconds: playheadSeconds,
            durationReader: mediaDurationSeconds
        )
    }

    static func resolveTimelinePreview(
        projectURL: URL,
        playheadSeconds: Double,
        durationReader: (URL) -> Double?
    ) -> ProjectMediaReference? {
        guard let chosen = timelinePreviewCandidates(projectURL: projectURL, playheadSeconds: playheadSeconds)
            .first(where: {
                FileManager.default.fileExists(atPath: $0.url.path)
                    && isTimelinePreviewUsable($0.url, playheadSeconds: playheadSeconds, durationReader: durationReader)
            })
        else {
            return nil
        }

        let clampedSeconds = max(0, playheadSeconds)
        return ProjectMediaReference(
            assetID: "timeline-preview",
            filename: chosen.url.lastPathComponent,
            displayName: chosen.displayName,
            url: chosen.url,
            exists: true,
            sourceInUS: nil,
            sourceOutUS: nil,
            previewTimeUS: Int((clampedSeconds * 1_000_000).rounded()),
            resolvedFrom: chosen.source
        )
    }

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

    private static func isTimelinePreviewUsable(
        _ url: URL,
        playheadSeconds: Double,
        durationReader: (URL) -> Double?
    ) -> Bool {
        let normalizedPlayhead = max(0, playheadSeconds.isFinite ? playheadSeconds : 0)
        guard let duration = durationReader(url),
              duration.isFinite,
              duration > 0
        else {
            return true
        }
        return normalizedPlayhead <= duration + 0.25
    }

    private static func mediaDurationSeconds(_ url: URL) -> Double? {
        let asset = AVURLAsset(url: url)
        let seconds = CMTimeGetSeconds(asset.duration)
        return seconds.isFinite && seconds > 0 ? seconds : nil
    }

    private static func timelinePreviewCandidates(
        projectURL: URL,
        playheadSeconds: Double
    ) -> [(url: URL, source: String, displayName: String)] {
        var candidates: [(url: URL, source: String, displayName: String)] = []
        let timelineDir = projectURL.appendingPathComponent("05_timeline")
        let previewsDir = timelineDir.appendingPathComponent("previews")

        if let meta = PreviewArtifactMeta.load(from: previewsDir.appendingPathComponent("preview.json")),
           meta.status == "ready",
           let videoPath = meta.videoPath,
           !videoPath.isEmpty,
           !videoPath.contains("/"),
           !videoPath.contains("..") {
            candidates.append((
                previewsDir.appendingPathComponent(videoPath),
                "05_timeline/previews",
                "Exact preview"
            ))
        }

        candidates.append((
            timelineDir.appendingPathComponent("preview-full.mp4"),
            "05_timeline/preview-full",
            "Full timeline preview"
        ))

        if playheadSeconds <= 30 {
            candidates.append((
                timelineDir.appendingPathComponent("preview-first30s.mp4"),
                "05_timeline/preview-first30s",
                "First 30 seconds preview"
            ))
        }

        if let legacyPreview = legacyEditorPreviewCandidate(in: timelineDir) {
            candidates.append((
                legacyPreview,
                "05_timeline/preview-editor",
                "Legacy editor preview"
            ))
        }

        candidates.append((
            projectURL.appendingPathComponent("09_output/rough-cut.mp4"),
            "09_output/rough-cut",
            "Rendered rough cut"
        ))

        candidates.append((
            projectURL.appendingPathComponent("09_output/final.mp4"),
            "09_output/final",
            "Final render"
        ))

        if let latestOutput = latestRenderedOutputCandidate(
            in: projectURL.appendingPathComponent("09_output")
        ) {
            candidates.append((
                latestOutput,
                "09_output/latest",
                "Latest rendered output"
            ))
        }

        candidates.append((
            projectURL.appendingPathComponent("07_package/video/final.mp4"),
            "07_package/video/final",
            "Packaged final render"
        ))

        candidates.append((
            projectURL.appendingPathComponent("07_package/assembly.mp4"),
            "07_package/assembly",
            "Packaged assembly preview"
        ))

        return candidates
    }

    private static func legacyEditorPreviewCandidate(in timelineDir: URL) -> URL? {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: timelineDir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else {
            return nil
        }

        return files
            .filter { file in
                let name = file.lastPathComponent
                return name.hasPrefix("preview-editor-") && name.hasSuffix(".mp4")
            }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
            .last
    }

    private static func latestRenderedOutputCandidate(in outputDir: URL) -> URL? {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: outputDir,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            return nil
        }

        return files
            .compactMap { file -> (url: URL, modifiedAt: Date)? in
                let name = file.lastPathComponent
                guard file.pathExtension.lowercased() == "mp4",
                      !name.hasSuffix(".raw.mp4"),
                      name != "rough-cut.mp4",
                      name != "final.mp4" else {
                    return nil
                }
                guard let values = try? file.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey]),
                      values.isRegularFile != false else {
                    return nil
                }
                return (file, values.contentModificationDate ?? Date.distantPast)
            }
            .sorted { lhs, rhs in
                if lhs.modifiedAt != rhs.modifiedAt {
                    return lhs.modifiedAt > rhs.modifiedAt
                }
                return lhs.url.lastPathComponent.localizedStandardCompare(rhs.url.lastPathComponent) == .orderedDescending
            }
            .first?
            .url
    }
}

private struct PreviewArtifactMeta: Decodable {
    let status: String
    let videoPath: String?

    enum CodingKeys: String, CodingKey {
        case status
        case videoPath
    }

    static func load(from url: URL) -> PreviewArtifactMeta? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(PreviewArtifactMeta.self, from: data)
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
