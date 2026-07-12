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
        guard exists else { return "素材が見つかりません" }
        if isTimelinePreview { return "タイムラインプレビュー" }
        if isSyntheticPreview { return "合成プレビュー" }
        if isProxyPreview { return "プロキシプレビュー" }
        if isPlayableVideo { return "ソースプレビュー" }
        if isPlayableAudio { return "音声プレビュー" }
        return "未対応の素材"
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
            return "Viewerで直接再生できます。"
        case .proxyVideo:
            return "生成済みのプレビュープロキシで再生できます。"
        case .directAudio:
            return "音声素材があります。波形と音声モニターで直接利用できます。"
        case .needsProxy:
            return "安定したネイティブ再生にはプレビュープロキシの作成が必要です。"
        case .missing:
            return "素材を再接続するか取り込んでください。"
        }
    }

    public var isSyntheticPreview: Bool {
        url?.standardizedFileURL.path.contains("/02_media/synthetic/") == true
    }

    public var isLikelyVideoAsset: Bool {
        let ext = filenameExtension
        return playbackStatus == .directVideo
            || playbackStatus == .proxyVideo
            || ["mov", "mp4", "m4v", "mxf", "avi", "mts"].contains(ext)
    }

    public var isLikelyAudioAsset: Bool {
        let ext = filenameExtension
        return playbackStatus == .directAudio
            || ["wav", "mp3", "m4a", "aif", "aiff"].contains(ext)
    }

    public var needsSourceAction: Bool {
        !playbackStatus.isReady
    }

    public func matchesSourceBinQuery(_ query: String) -> Bool {
        let tokens = query.split(whereSeparator: \.isWhitespace)
        guard !tokens.isEmpty else { return true }
        let searchableValues = [
            assetID,
            filename,
            url?.lastPathComponent ?? "",
            url?.path ?? "",
            resolvedFrom,
            playbackStatus.rawValue,
            recommendation,
        ]
        return tokens.allSatisfy { token in
            searchableValues.contains { value in
                value.localizedCaseInsensitiveContains(String(token))
            }
        }
    }

    private var filenameExtension: String {
        URL(fileURLWithPath: filename).pathExtension.lowercased()
    }
}

public enum ProjectMediaSkimPreviewTime {
    public static let defaultPublishThresholdUS = 33_333

    public static func previewTimeUS(
        sourceInUS: Int?,
        sourceOutUS: Int?,
        fraction: Double
    ) -> Int {
        let sourceInUS = max(0, sourceInUS ?? 0)
        guard let sourceOutUS, sourceOutUS > sourceInUS else {
            return sourceInUS
        }

        let boundedFraction = fraction.isFinite ? min(1, max(0, fraction)) : 0
        let durationUS = sourceOutUS - sourceInUS
        return sourceInUS + Int((Double(durationUS) * boundedFraction).rounded())
    }

    public static func shouldPublishPreview(
        previousAssetID: String?,
        previousTimeUS: Int?,
        nextAssetID: String,
        nextTimeUS: Int,
        minimumDeltaUS: Int = defaultPublishThresholdUS
    ) -> Bool {
        guard previousAssetID == nextAssetID else { return true }
        guard let previousTimeUS else { return true }
        guard previousTimeUS != nextTimeUS else { return false }

        let thresholdUS = max(1, minimumDeltaUS)
        return abs(nextTimeUS - previousTimeUS) >= thresholdUS
    }
}

public enum ProjectMediaSourceBinFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case manual = "manual"
    case collection
    case favorites
    case used
    case unused
    case ready
    case video
    case audio
    case needsAction = "needs-action"

    public var id: String { rawValue }
}

public enum ProjectMediaSourceBinSort: String, CaseIterable, Identifiable, Sendable {
    case sourceOrder = "source-order"
    case filename
    case status
    case kind

    public var id: String { rawValue }
}

public enum ProjectMediaSourceBinGroupMode: String, CaseIterable, Identifiable, Sendable {
    case flat
    case folder
    case status
    case kind
    case usage

    public var id: String { rawValue }
}

public struct ProjectMediaSourceBinGroup: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let items: [ProjectMediaPreviewStatus]

    public init(id: String, label: String, items: [ProjectMediaPreviewStatus]) {
        self.id = id
        self.label = label
        self.items = items
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

    public func items(
        matching filter: ProjectMediaSourceBinFilter,
        query: String = "",
        sort: ProjectMediaSourceBinSort = .sourceOrder,
        manualAssetIDs: Set<String> = [],
        collectionAssetIDs: Set<String> = [],
        favoriteAssetIDs: Set<String> = [],
        usedAssetIDs: Set<String> = []
    ) -> [ProjectMediaPreviewStatus] {
        let filtered: [ProjectMediaPreviewStatus]
        switch filter {
        case .all:
            filtered = items
        case .manual:
            filtered = items.filter { manualAssetIDs.contains($0.assetID) }
        case .collection:
            filtered = items.filter { collectionAssetIDs.contains($0.assetID) }
        case .favorites:
            filtered = items.filter { favoriteAssetIDs.contains($0.assetID) }
        case .used:
            filtered = items.filter { usedAssetIDs.contains($0.assetID) }
        case .unused:
            filtered = items.filter { !usedAssetIDs.contains($0.assetID) }
        case .ready:
            filtered = items.filter { $0.playbackStatus.isReady }
        case .video:
            filtered = items.filter(\.isLikelyVideoAsset)
        case .audio:
            filtered = items.filter(\.isLikelyAudioAsset)
        case .needsAction:
            filtered = items.filter(\.needsSourceAction)
        }

        let searched = filtered.filter { $0.matchesSourceBinQuery(query) }
        return sortedSourceBinItems(searched, by: sort)
    }

    public func count(
        matching filter: ProjectMediaSourceBinFilter,
        query: String = "",
        manualAssetIDs: Set<String> = [],
        collectionAssetIDs: Set<String> = [],
        favoriteAssetIDs: Set<String> = [],
        usedAssetIDs: Set<String> = []
    ) -> Int {
        items(
            matching: filter,
            query: query,
            manualAssetIDs: manualAssetIDs,
            collectionAssetIDs: collectionAssetIDs,
            favoriteAssetIDs: favoriteAssetIDs,
            usedAssetIDs: usedAssetIDs
        ).count
    }

    public func groupedItems(
        matching filter: ProjectMediaSourceBinFilter,
        query: String = "",
        sort: ProjectMediaSourceBinSort = .sourceOrder,
        groupMode: ProjectMediaSourceBinGroupMode = .flat,
        manualAssetIDs: Set<String> = [],
        collectionAssetIDs: Set<String> = [],
        favoriteAssetIDs: Set<String> = [],
        usedAssetIDs: Set<String> = []
    ) -> [ProjectMediaSourceBinGroup] {
        let sourceItems = items(
            matching: filter,
            query: query,
            sort: sort,
            manualAssetIDs: manualAssetIDs,
            collectionAssetIDs: collectionAssetIDs,
            favoriteAssetIDs: favoriteAssetIDs,
            usedAssetIDs: usedAssetIDs
        )
        guard !sourceItems.isEmpty else { return [] }

        switch groupMode {
        case .flat:
            return [ProjectMediaSourceBinGroup(id: "flat", label: "All Media", items: sourceItems)]
        case .folder:
            return groupedByFolder(sourceItems)
        case .status:
            return groupedByStatus(sourceItems)
        case .kind:
            return groupedByKind(sourceItems)
        case .usage:
            return groupedByUsage(sourceItems, usedAssetIDs: usedAssetIDs)
        }
    }

    private func sortedSourceBinItems(
        _ items: [ProjectMediaPreviewStatus],
        by sort: ProjectMediaSourceBinSort
    ) -> [ProjectMediaPreviewStatus] {
        switch sort {
        case .sourceOrder:
            return items
        case .filename:
            return items.sorted(by: compareByFilenameThenAssetID)
        case .status:
            return items.sorted { lhs, rhs in
                let lhsRank = sourceBinStatusRank(lhs.playbackStatus)
                let rhsRank = sourceBinStatusRank(rhs.playbackStatus)
                if lhsRank != rhsRank { return lhsRank < rhsRank }
                return compareByFilenameThenAssetID(lhs, rhs)
            }
        case .kind:
            return items.sorted { lhs, rhs in
                let lhsRank = sourceBinKindRank(lhs)
                let rhsRank = sourceBinKindRank(rhs)
                if lhsRank != rhsRank { return lhsRank < rhsRank }
                return compareByFilenameThenAssetID(lhs, rhs)
            }
        }
    }

    private func compareByFilenameThenAssetID(
        _ lhs: ProjectMediaPreviewStatus,
        _ rhs: ProjectMediaPreviewStatus
    ) -> Bool {
        let filenameComparison = lhs.filename.localizedStandardCompare(rhs.filename)
        if filenameComparison != .orderedSame {
            return filenameComparison == .orderedAscending
        }
        return lhs.assetID.localizedStandardCompare(rhs.assetID) == .orderedAscending
    }

    private func sourceBinStatusRank(_ status: ProjectMediaPreviewStatus.PlaybackStatus) -> Int {
        switch status {
        case .directVideo:
            return 0
        case .proxyVideo:
            return 1
        case .directAudio:
            return 2
        case .needsProxy:
            return 3
        case .missing:
            return 4
        }
    }

    private func sourceBinKindRank(_ item: ProjectMediaPreviewStatus) -> Int {
        if item.isLikelyVideoAsset { return 0 }
        if item.isLikelyAudioAsset { return 1 }
        return 2
    }

    private func groupedByFolder(_ items: [ProjectMediaPreviewStatus]) -> [ProjectMediaSourceBinGroup] {
        let grouped = Dictionary(grouping: items) { item in
            sourceBinFolderKeyAndLabel(for: item).key
        }
        return grouped
            .map { key, items in
                let label = items.first.map { sourceBinFolderKeyAndLabel(for: $0).label } ?? key
                return ProjectMediaSourceBinGroup(id: key, label: label, items: items)
            }
            .sorted { lhs, rhs in
                let labelComparison = lhs.label.localizedStandardCompare(rhs.label)
                if labelComparison != .orderedSame {
                    return labelComparison == .orderedAscending
                }
                return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
            }
    }

    private func groupedByStatus(_ items: [ProjectMediaPreviewStatus]) -> [ProjectMediaSourceBinGroup] {
        let grouped = Dictionary(grouping: items, by: \.playbackStatus)
        return grouped
            .map { status, items in
                ProjectMediaSourceBinGroup(id: status.rawValue, label: status.rawValue, items: items)
            }
            .sorted { lhs, rhs in
                guard let lhsStatus = ProjectMediaPreviewStatus.PlaybackStatus(rawValue: lhs.id),
                      let rhsStatus = ProjectMediaPreviewStatus.PlaybackStatus(rawValue: rhs.id)
                else {
                    return lhs.id < rhs.id
                }
                return sourceBinStatusRank(lhsStatus) < sourceBinStatusRank(rhsStatus)
            }
    }

    private func groupedByKind(_ items: [ProjectMediaPreviewStatus]) -> [ProjectMediaSourceBinGroup] {
        let grouped = Dictionary(grouping: items) { item -> String in
            if item.isLikelyVideoAsset { return "video" }
            if item.isLikelyAudioAsset { return "audio" }
            return "other"
        }
        let labels = ["video": "Video", "audio": "Audio", "other": "Other"]
        let ranks = ["video": 0, "audio": 1, "other": 2]
        return grouped
            .map { key, items in
                ProjectMediaSourceBinGroup(id: key, label: labels[key] ?? key, items: items)
            }
            .sorted { lhs, rhs in
                (ranks[lhs.id] ?? Int.max) < (ranks[rhs.id] ?? Int.max)
            }
    }

    private func groupedByUsage(
        _ items: [ProjectMediaPreviewStatus],
        usedAssetIDs: Set<String>
    ) -> [ProjectMediaSourceBinGroup] {
        let grouped = Dictionary(grouping: items) { item in
            usedAssetIDs.contains(item.assetID) ? "used" : "unused"
        }
        let labels = ["unused": "Unused", "used": "Used"]
        let ranks = ["unused": 0, "used": 1]
        return grouped
            .map { key, items in
                ProjectMediaSourceBinGroup(id: key, label: labels[key] ?? key, items: items)
            }
            .sorted { lhs, rhs in
                (ranks[lhs.id] ?? Int.max) < (ranks[rhs.id] ?? Int.max)
            }
    }

    private func sourceBinFolderKeyAndLabel(for item: ProjectMediaPreviewStatus) -> (key: String, label: String) {
        if let url = item.url {
            let folderURL = url.deletingLastPathComponent().standardizedFileURL
            let folderName = folderURL.lastPathComponent
            if !folderName.isEmpty {
                return (folderURL.path, folderName)
            }
        }
        if !item.resolvedFrom.isEmpty {
            return ("resolved:\(item.resolvedFrom)", item.resolvedFrom)
        }
        return ("unlinked", "Unlinked")
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
                return "素材を再接続"
            case .buildPreviewProxies:
                return "プレビュー用プロキシを作成"
            case .buildPreviewMedia:
                return "プレビュー素材を作成"
            case .reviewPreviewSource:
                return "プレビュー元を確認"
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
                title: "タイムラインのクリップを選択してください",
                detail: "ビューアに表示できる素材がまだ選択されていません。",
                action: nil,
                severity: .info
            )
        }

        if previewSummary.missingCount > 0 {
            return ProjectViewerReadinessDiagnostic(
                title: "素材が見つかりません",
                detail: "\(previewSummary.missingCount)件の素材が見つかりません。素材パネルで再接続してください。",
                action: .relinkSourceMedia,
                severity: .warning
            )
        }

        if previewSummary.proxyNeededCount > 0 {
            return ProjectViewerReadinessDiagnostic(
                title: "プレビュー用プロキシが必要です",
                detail: "\(previewSummary.proxyNeededCount)件の素材はネイティブ再生用のH.264プロキシが必要です。",
                action: .buildPreviewProxies,
                severity: .warning
            )
        }

        if previewSummary.playableVideoCount == 0 {
            return ProjectViewerReadinessDiagnostic(
                title: "再生できる映像がありません",
                detail: "ソース、プロキシ、タイムラインプレビュー、レンダー済み動画のいずれもビューアで利用できません。",
                action: .buildPreviewMedia,
                severity: .warning
            )
        }

        return ProjectViewerReadinessDiagnostic(
            title: "再生位置をクリップ上に移動してください",
            detail: "再生可能な素材はありますが、現在の再生位置は映像クリップまたはタイムラインプレビューに対応していません。",
            action: nil,
            severity: .info
        )
    }

    private static func diagnose(media: ProjectMediaReference) -> ProjectViewerReadinessDiagnostic {
        if !media.exists {
            return ProjectViewerReadinessDiagnostic(
                title: "素材が見つかりません",
                detail: "\(media.url?.path ?? media.filename) が見つかりません。",
                action: .relinkSourceMedia,
                severity: .warning
            )
        }

        if media.isPlayableVideo {
            return ProjectViewerReadinessDiagnostic(
                title: "\(media.viewerModeLabel)を表示できます",
                detail: media.url?.lastPathComponent ?? media.filename,
                action: media.viewerNeedsAttention ? .reviewPreviewSource : nil,
                severity: media.viewerNeedsAttention ? .info : .ready
            )
        }

        if media.isPlayableAudio {
            return ProjectViewerReadinessDiagnostic(
                title: "音声のみの素材です",
                detail: "\(media.url?.lastPathComponent ?? media.filename) には音声がありますが、ネイティブ映像プレビューがありません。",
                action: .buildPreviewProxies,
                severity: .warning
            )
        }

        return ProjectViewerReadinessDiagnostic(
            title: "未対応の素材です",
            detail: "\(media.url?.lastPathComponent ?? media.filename) は存在しますが、このビューアでは直接再生できません。",
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

    public static func preferredViewerAudioMedia(
        programMedia: ProjectMediaReference?,
        audioMedia: ProjectMediaReference?
    ) -> ProjectMediaReference? {
        if let programMedia,
           programMedia.isTimelinePreview,
           programMedia.exists,
           programMedia.canPlayAudio {
            return programMedia
        }
        if let audioMedia,
           audioMedia.exists,
           audioMedia.canPlayAudio {
            return audioMedia
        }
        return programMedia
    }

    public static func resolveTimelinePreview(
        projectURL: URL,
        playheadSeconds: Double
    ) -> ProjectMediaReference? {
        resolveTimelinePreview(
            projectURL: projectURL,
            playheadSeconds: playheadSeconds,
            durationReader: { SafeMediaDurationReader.seconds(for: $0) }
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
                    && isTimelinePreviewContractUsable(projectURL: projectURL)
                    && isTimelinePreviewFresh($0.url, projectURL: projectURL)
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

    public static func resolvePreviewStatus(
        projectURL: URL,
        status: ProjectMediaPreviewStatus,
        assets: AnalysisAssetDocument?,
        previewTimeUS: Int? = nil
    ) -> ProjectMediaReference {
        let asset = assets?.items.first { $0.id == status.assetID }
        return ProjectMediaReference(
            assetID: status.assetID,
            filename: status.filename,
            displayName: asset?.roleGuess ?? status.filename,
            url: status.url,
            exists: status.exists,
            sourceInUS: asset?.durationUS == nil ? nil : 0,
            sourceOutUS: asset?.durationUS,
            previewTimeUS: previewTimeUS,
            resolvedFrom: status.resolvedFrom
        )
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

    private static func isTimelinePreviewFresh(_ url: URL, projectURL: URL) -> Bool {
        let timelineURL = projectURL.appendingPathComponent("05_timeline/timeline.json")
        guard let timelineDate = modificationDate(for: timelineURL),
              let previewDate = modificationDate(for: url)
        else {
            return true
        }
        return previewDate >= timelineDate.addingTimeInterval(-1)
    }

    private static func isTimelinePreviewContractUsable(projectURL: URL) -> Bool {
        ProjectPlaybackContractStatusReader.status(projectURL: projectURL).state != .stale
    }

    private static func modificationDate(for url: URL) -> Date? {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
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
                "照合済みプレビュー"
            ))
        }

        candidates.append((
            timelineDir.appendingPathComponent("preview-full.mp4"),
            "05_timeline/preview-full",
            "全体タイムラインプレビュー"
        ))

        if playheadSeconds <= 30 {
            candidates.append((
                timelineDir.appendingPathComponent("preview-first30s.mp4"),
                "05_timeline/preview-first30s",
                "冒頭30秒プレビュー"
            ))
        }

        if let legacyPreview = legacyEditorPreviewCandidate(in: timelineDir) {
            candidates.append((
                legacyPreview,
                "05_timeline/preview-editor",
                "旧エディタープレビュー"
            ))
        }

        candidates.append((
            projectURL.appendingPathComponent("09_output/rough-cut.mp4"),
            "09_output/rough-cut",
            "書き出し済み粗編集"
        ))

        candidates.append((
            projectURL.appendingPathComponent("09_output/final.mp4"),
            "09_output/final",
            "最終書き出し"
        ))

        if let latestOutput = latestRenderedOutputCandidate(
            in: projectURL.appendingPathComponent("09_output")
        ) {
            candidates.append((
                latestOutput,
                "09_output/latest",
                "最新書き出し"
            ))
        }

        candidates.append((
            projectURL.appendingPathComponent("07_package/video/final.mp4"),
            "07_package/video/final",
            "パッケージ済み最終動画"
        ))

        candidates.append((
            projectURL.appendingPathComponent("07_package/assembly.mp4"),
            "07_package/assembly",
            "パッケージ済み構成プレビュー"
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
