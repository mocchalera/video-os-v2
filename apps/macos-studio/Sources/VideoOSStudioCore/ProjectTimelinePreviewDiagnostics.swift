import Foundation

public struct ProjectTimelinePreviewDiagnostics: Equatable, Sendable {
    public let hasTimeline: Bool
    public let videoClipCount: Int
    public let audioClipCount: Int
    public let v1AssetIDs: [String]
    public let a1AssetIDs: [String]
    public let selectedCandidateAssetIDs: [String]
    public let selectedCandidateCount: Int
    public let transitionTypeCounts: [String: Int]
    public let sameAssetAdjacentPairCount: Int
    public let sameAudioAssetAdjacentPairCount: Int
    public let timelineDurationSeconds: Double
    public let previewMediaFilename: String?
    public let previewResolvedFrom: String?
    public let previewDurationSeconds: Double?
    public let previewHasAudioStream: Bool?
    public let previewExpectedRenderedSeconds: Double?
    public let previewCollapsedGapSeconds: Double?
    public let previewCollapsedGapCount: Int?
    public let previewRenderParityPass: Bool?

    public static let empty = ProjectTimelinePreviewDiagnostics(
        hasTimeline: false,
        videoClipCount: 0,
        audioClipCount: 0,
        v1AssetIDs: [],
        a1AssetIDs: [],
        selectedCandidateAssetIDs: [],
        selectedCandidateCount: 0,
        transitionTypeCounts: [:],
        sameAssetAdjacentPairCount: 0,
        sameAudioAssetAdjacentPairCount: 0,
        timelineDurationSeconds: 0,
        previewMediaFilename: nil,
        previewResolvedFrom: nil,
        previewDurationSeconds: nil,
        previewHasAudioStream: nil,
        previewExpectedRenderedSeconds: nil,
        previewCollapsedGapSeconds: nil,
        previewCollapsedGapCount: nil,
        previewRenderParityPass: nil
    )

    public var trackCompositionLabel: String {
        guard hasTimeline else { return "-" }
        return "V1 \(v1AssetIDs.count)素材/\(videoClipCount)クリップ・A1 \(a1AssetIDs.count)素材/\(audioClipCount)クリップ"
    }

    public var candidatePoolLabel: String {
        guard selectedCandidateCount > 0 else { return "候補なし" }
        return "\(selectedCandidateAssetIDs.count)素材/\(selectedCandidateCount)候補"
    }

    public var transitionLabel: String {
        guard hasTimeline else { return "-" }
        let total = transitionTypeCounts.values.reduce(0, +)
        guard total > 0 else { return "なし" }
        if hasOnlyCutTransitions {
            return "カットのみ \(total)件"
        }
        return transitionTypeCounts
            .sorted { left, right in
                if left.value != right.value { return left.value > right.value }
                return left.key < right.key
            }
            .map { "\(Self.localizedTransitionType($0.key)) \($0.value)件" }
            .joined(separator: " / ")
    }

    public var previewCoverageLabel: String {
        guard hasTimeline else { return "-" }
        guard let previewMediaFilename else { return "プレビュー動画なし" }
        guard let previewDurationSeconds else {
            return "プレビュー尺未確認: \(previewMediaFilename)"
        }
        if let previewExpectedRenderedSeconds,
           previewUsesCollapsedGapContract {
            if previewCoverageNeedsAttention {
                return "プレビュー不足 \(Self.formatSeconds(previewDurationSeconds))/期待\(Self.formatSeconds(previewExpectedRenderedSeconds))"
            }
            let gap = previewCollapsedGapSeconds ?? 0
            return "空白詰めプレビュー \(Self.formatSeconds(previewDurationSeconds))/期待\(Self.formatSeconds(previewExpectedRenderedSeconds))（空白\(Self.formatSeconds(gap))詰め）"
        }
        if previewCoverageNeedsAttention {
            let target = previewCoverageTargetSeconds
            return "プレビュー不足 \(Self.formatSeconds(previewDurationSeconds))/\(Self.formatSeconds(target))"
        }
        return "プレビュー全尺 \(Self.formatSeconds(previewDurationSeconds))/\(Self.formatSeconds(timelineDurationSeconds))"
    }

    public var previewAudioLabel: String {
        guard hasTimeline else { return "-" }
        guard audioClipCount > 0 else { return "A1なし" }
        guard previewMediaFilename != nil else { return "プレビュー音声なし" }
        guard let previewHasAudioStream else { return "音声ストリーム未確認" }
        return previewHasAudioStream ? "プレビュー音声あり" : "プレビュー音声なし"
    }

    public var previewSourceLabel: String {
        guard hasTimeline else { return "-" }
        guard let previewMediaFilename else { return "ソース確認にフォールバック" }
        let source = previewResolvedFrom.map(Self.localizedPreviewSource) ?? "出力元不明"
        return "\(source): \(previewMediaFilename)"
    }

    public var previewCoverageNeedsAttention: Bool {
        guard hasTimeline else { return false }
        guard let previewDurationSeconds else { return previewMediaFilename == nil }
        if previewRenderParityPass == false { return true }
        return previewDurationSeconds + 0.25 < previewCoverageTargetSeconds
    }

    public var previewUsesCollapsedGapContract: Bool {
        guard let previewExpectedRenderedSeconds else { return false }
        let gap = previewCollapsedGapSeconds ?? max(0, timelineDurationSeconds - previewExpectedRenderedSeconds)
        return gap > 0.25 && previewExpectedRenderedSeconds + 0.25 < timelineDurationSeconds
    }

    public var previewAudioNeedsAttention: Bool {
        hasTimeline && audioClipCount > 0 && previewHasAudioStream == false
    }

    public var repeatRiskLabel: String {
        guard hasTimeline else { return "-" }
        if sameAssetAdjacentPairCount > 0 || sameAudioAssetAdjacentPairCount > 0 {
            var parts: [String] = []
            if sameAssetAdjacentPairCount > 0 {
                parts.append("V1 \(sameAssetAdjacentPairCount)件")
            }
            if sameAudioAssetAdjacentPairCount > 0 {
                parts.append("A1 \(sameAudioAssetAdjacentPairCount)件")
            }
            return "同一素材連続 " + parts.joined(separator: " / ")
        }
        let videoReuse = videoClipCount > v1AssetIDs.count
        let audioReuse = audioClipCount > a1AssetIDs.count
        guard videoReuse || audioReuse else { return "素材再利用なし" }
        return "素材再利用 V1 \(v1AssetIDs.count)/\(videoClipCount)・A1 \(a1AssetIDs.count)/\(audioClipCount)"
    }

    public var editorialStructureNeedsAttention: Bool {
        guard hasTimeline else { return false }
        return hasOnlyCutTransitions
            || sameAssetAdjacentPairCount > 0
            || sameAudioAssetAdjacentPairCount > 0
            || videoClipCount > v1AssetIDs.count
            || audioClipCount > a1AssetIDs.count
    }

    public var editorialStructureLabel: String {
        guard editorialStructureNeedsAttention else { return "構成注意なし" }
        var parts: [String] = []
        if hasOnlyCutTransitions {
            parts.append("カットのみ")
        }
        if sameAssetAdjacentPairCount > 0 || sameAudioAssetAdjacentPairCount > 0 {
            parts.append(repeatRiskLabel)
        } else if videoClipCount > v1AssetIDs.count || audioClipCount > a1AssetIDs.count {
            parts.append(repeatRiskLabel)
        }
        return "構成注意: " + parts.joined(separator: " / ")
    }

    public var recommendation: String {
        guard hasTimeline else {
            return "timeline.json がありません。先に粗編集を生成してください。"
        }
        if previewMediaFilename == nil {
            return "timeline.json はありますが、現行タイムライン由来のプレビュー動画がありません。Viewerは元素材確認にフォールバックするため、トランジションや完成音声は再現されません。タイムラインプレビューを生成してください。"
        }
        if previewAudioNeedsAttention {
            return "timeline.json にはA1音声クリップがありますが、プレビュー動画に音声ストリームがありません。完成音声を確認できないため、タイムラインプレビューを再生成してください。"
        }
        if previewCoverageNeedsAttention {
            if previewExpectedRenderedSeconds != nil {
                return "プレビュー動画がrough-cutの期待尺より短いか、render-reportの尺照合に失敗しています。トランジションや完成音声の承認前にタイムラインプレビューを再生成してください。"
            }
            return "プレビュー動画がタイムライン全尺より短いため、後半は元素材確認にフォールバックします。フォールバック中はトランジションや完成音声を正しく確認できません。タイムラインプレビューを再生成してください。"
        }
        if previewUsesCollapsedGapContract {
            let gap = previewCollapsedGapSeconds.map(Self.formatSeconds) ?? "timeline空白"
            return "このrough-cutはtimeline上の空白\(gap)を詰めた確認用プレビューです。映像がtimeline spanより短いのはrenderer契約どおりです。黒尺込みの尺確認が必要な場合は全尺プレビューを書き出してください。"
        }
        let hasReuse = videoClipCount > v1AssetIDs.count || audioClipCount > a1AssetIDs.count
        let isCutOnly = hasOnlyCutTransitions
        let hasAdjacentReuse = sameAssetAdjacentPairCount > 0 || sameAudioAssetAdjacentPairCount > 0
        if hasAdjacentReuse && selectedCandidateAssetIDs.count <= 1 {
            return "候補が1素材に偏っているため、繰り返し感はプレビュー再生ではなく選定結果由来です。別素材候補を追加するか、候補選定をやり直してください。"
        }
        if hasAdjacentReuse {
            return "V1またはA1で同じ素材が連続しています。候補差し替えまたは再コンパイルで隣接素材を分散してください。"
        }
        if hasReuse && isCutOnly {
            return "同じ素材が複数回使われ、切り替えはカットのみです。繰り返し感やトランジション不足は現在のtimeline.jsonの構成に由来します。"
        }
        if hasReuse {
            return "同じ素材が複数回使われています。繰り返し感が気になる場合は候補差し替えまたは再コンパイルで素材を分散してください。"
        }
        if isCutOnly {
            return "現在の timeline.json はカットのみです。ディゾルブ等を期待する場合は transition_policy または beat craft を見直して再生成してください。"
        }
        return "timeline.json のV1/A1構成とトランジション概要を確認できます。"
    }

    private var hasOnlyCutTransitions: Bool {
        transitionTypeCounts.count == 1 && transitionTypeCounts.keys.first == "cut"
    }

    private var previewCoverageTargetSeconds: Double {
        previewExpectedRenderedSeconds ?? timelineDurationSeconds
    }

    private static func localizedTransitionType(_ rawValue: String) -> String {
        switch rawValue {
        case "cut":
            return "カット"
        case "crossfade":
            return "クロスフェード"
        case "match_cut":
            return "マッチカット"
        case "match_cut_soft":
            return "ソフトマッチカット"
        case "fade_to_black":
            return "黒フェード"
        case "dip_to_white":
            return "白ディップ"
        default:
            return rawValue
        }
    }

    private static func localizedPreviewSource(_ rawValue: String) -> String {
        switch rawValue {
        case "05_timeline/previews":
            return "生成済みタイムラインプレビュー"
        case "05_timeline/preview-full":
            return "全体タイムラインプレビュー"
        case "05_timeline/preview-first30s":
            return "冒頭タイムラインプレビュー"
        case "05_timeline/preview-editor":
            return "旧エディタープレビュー"
        case "09_output/rough-cut":
            return "書き出し済み粗編集"
        case "09_output/final":
            return "最終書き出し"
        case "09_output/latest":
            return "最新書き出し"
        case "07_package/video/final":
            return "パッケージ済み最終動画"
        case "07_package/assembly":
            return "パッケージ済み構成プレビュー"
        default:
            return rawValue
        }
    }

    private static func formatSeconds(_ seconds: Double) -> String {
        let value = max(0, seconds)
        if value >= 60 {
            let total = Int(value.rounded())
            return "\(total / 60)m\(String(format: "%02d", total % 60))s"
        }
        return String(format: "%.1fs", value)
    }
}

public enum ProjectTimelinePreviewDiagnosticsReader {
    public static func status(projectURL: URL) -> ProjectTimelinePreviewDiagnostics {
        status(
            projectURL: projectURL,
            previewResolver: { projectURL, playheadSeconds in
                ProjectMediaResolver.resolveTimelinePreview(projectURL: projectURL, playheadSeconds: playheadSeconds)
            },
            durationReader: { url in
                SafeMediaDurationReader.seconds(for: url)
            },
            audioStreamReader: { url in
                SafeMediaDurationReader.hasAudioStream(for: url)
            }
        )
    }

    static func status(
        projectURL: URL,
        previewResolver: (URL, Double) -> ProjectMediaReference?,
        durationReader: (URL) -> Double?,
        audioStreamReader: (URL) -> Bool? = { _ in nil }
    ) -> ProjectTimelinePreviewDiagnostics {
        let timelineURL = projectURL.appendingPathComponent("05_timeline/timeline.json")
        guard
            let data = try? Data(contentsOf: timelineURL),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return .empty
        }

        let tracks = root["tracks"] as? [String: Any] ?? [:]
        let videoTracks = tracks["video"] as? [[String: Any]] ?? []
        let audioTracks = tracks["audio"] as? [[String: Any]] ?? []
        let v1Track = videoTracks.first { $0["track_id"] as? String == "V1" } ?? videoTracks.first
        let a1Track = audioTracks.first { $0["track_id"] as? String == "A1" } ?? audioTracks.first
        let v1Clips = sortedClips(v1Track?["clips"] as? [[String: Any]] ?? [])
        let a1Clips = sortedClips(a1Track?["clips"] as? [[String: Any]] ?? [])
        let videoClipCount = videoTracks.reduce(0) { count, track in
            count + ((track["clips"] as? [[String: Any]])?.count ?? 0)
        }
        let audioClipCount = audioTracks.reduce(0) { count, track in
            count + ((track["clips"] as? [[String: Any]])?.count ?? 0)
        }
        let transitions = root["transitions"] as? [[String: Any]] ?? []
        let transitionTypeCounts = transitions.reduce(into: [String: Int]()) { counts, item in
            let type = (item["transition_type"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "unknown"
            counts[type, default: 0] += 1
        }
        let candidateAssetIDs = selectedCandidateAssetIDs(projectURL: projectURL)
        let timelineDurationSeconds = timelineDurationSeconds(root: root)
        let previewMedia = previewResolver(projectURL, 0)
        let previewDurationSeconds = previewMedia?.url.flatMap(durationReader)
        let previewHasAudioStream = previewMedia?.url.flatMap(audioStreamReader)
        let renderReport = roughCutRenderReport(projectURL: projectURL, previewMedia: previewMedia)

        return ProjectTimelinePreviewDiagnostics(
            hasTimeline: true,
            videoClipCount: videoClipCount,
            audioClipCount: audioClipCount,
            v1AssetIDs: uniqueAssetIDs(v1Clips),
            a1AssetIDs: uniqueAssetIDs(a1Clips),
            selectedCandidateAssetIDs: candidateAssetIDs.uniqueAssetIDs,
            selectedCandidateCount: candidateAssetIDs.totalCount,
            transitionTypeCounts: transitionTypeCounts,
            sameAssetAdjacentPairCount: sameAssetAdjacentPairCount(v1Clips),
            sameAudioAssetAdjacentPairCount: sameAssetAdjacentPairCount(a1Clips),
            timelineDurationSeconds: timelineDurationSeconds,
            previewMediaFilename: previewMedia?.filename,
            previewResolvedFrom: previewMedia?.resolvedFrom,
            previewDurationSeconds: previewDurationSeconds,
            previewHasAudioStream: previewHasAudioStream,
            previewExpectedRenderedSeconds: renderReport?.expectedRenderedSeconds,
            previewCollapsedGapSeconds: renderReport?.gapSeconds,
            previewCollapsedGapCount: renderReport?.gapCount,
            previewRenderParityPass: renderReport?.parityPass
        )
    }

    private struct RoughCutRenderReport {
        let expectedRenderedSeconds: Double?
        let gapSeconds: Double?
        let gapCount: Int?
        let parityPass: Bool?
    }

    private static func roughCutRenderReport(
        projectURL: URL,
        previewMedia: ProjectMediaReference?
    ) -> RoughCutRenderReport? {
        guard previewMedia?.resolvedFrom == "09_output/rough-cut" else { return nil }
        let reportURL = projectURL.appendingPathComponent("09_output/render-report.json")
        guard
            let data = try? Data(contentsOf: reportURL),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }

        return RoughCutRenderReport(
            expectedRenderedSeconds: doubleValue(root["expected_rendered_sec"]),
            gapSeconds: doubleValue(root["gap_sec"]),
            gapCount: intValue(root["gap_count"]),
            parityPass: root["parity_pass"] as? Bool
        )
    }

    private static func sortedClips(_ clips: [[String: Any]]) -> [[String: Any]] {
        clips.sorted { left, right in
            let leftFrame = left["timeline_in_frame"] as? Int ?? left["timeline_start_frame"] as? Int ?? 0
            let rightFrame = right["timeline_in_frame"] as? Int ?? right["timeline_start_frame"] as? Int ?? 0
            if leftFrame != rightFrame { return leftFrame < rightFrame }
            return (left["clip_id"] as? String ?? "") < (right["clip_id"] as? String ?? "")
        }
    }

    private static func uniqueAssetIDs(_ clips: [[String: Any]]) -> [String] {
        let values = clips.compactMap { item -> String? in
            guard let value = item["asset_id"] as? String, !value.isEmpty else { return nil }
            return value
        }
        return Array(Set(values)).sorted()
    }

    private static func sameAssetAdjacentPairCount(_ clips: [[String: Any]]) -> Int {
        guard clips.count >= 2 else { return 0 }
        var count = 0
        for index in 0..<(clips.count - 1) {
            guard
                let left = clips[index]["asset_id"] as? String,
                let right = clips[index + 1]["asset_id"] as? String,
                !left.isEmpty,
                left == right
            else {
                continue
            }
            count += 1
        }
        return count
    }

    private static func timelineDurationSeconds(root: [String: Any]) -> Double {
        let sequence = root["sequence"] as? [String: Any] ?? [:]
        let fps = sequenceFPS(sequence)
        let tracks = root["tracks"] as? [String: Any] ?? [:]
        let videoTracks = tracks["video"] as? [[String: Any]] ?? []
        let audioTracks = tracks["audio"] as? [[String: Any]] ?? []
        let allTracks = videoTracks + audioTracks
        let maxFrame = allTracks
            .flatMap { $0["clips"] as? [[String: Any]] ?? [] }
            .map { clip -> Int in
                let start = clip["timeline_in_frame"] as? Int ?? clip["timeline_start_frame"] as? Int ?? 0
                let duration = clip["timeline_duration_frames"] as? Int ?? clip["duration_frames"] as? Int ?? 0
                return start + duration
            }
            .max() ?? 0
        guard fps > 0 else { return 0 }
        return Double(maxFrame) / fps
    }

    private static func sequenceFPS(_ sequence: [String: Any]) -> Double {
        if let fps = sequence["fps"] as? Double, fps > 0 {
            return fps
        }
        if let fps = sequence["fps"] as? Int, fps > 0 {
            return Double(fps)
        }
        let numerator = sequence["fps_num"] as? Int ?? 24
        let denominator = sequence["fps_den"] as? Int ?? 1
        guard numerator > 0, denominator > 0 else { return 24 }
        return Double(numerator) / Double(denominator)
    }

    private static func doubleValue(_ value: Any?) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let value = value as? String, let number = Double(value) { return number }
        return nil
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        if let value = value as? Double { return Int(value) }
        if let value = value as? String, let number = Int(value) { return number }
        return nil
    }

    private static func selectedCandidateAssetIDs(projectURL: URL) -> (uniqueAssetIDs: [String], totalCount: Int) {
        let selectsURL = projectURL.appendingPathComponent("04_plan/selects_candidates.yaml")
        guard let raw = try? String(contentsOf: selectsURL, encoding: .utf8) else {
            return ([], 0)
        }
        let values = raw
            .split(whereSeparator: \.isNewline)
            .compactMap { line -> String? in
                let trimmed = String(line).trimmingCharacters(in: .whitespacesAndNewlines)
                guard trimmed.hasPrefix("asset_id:") else { return nil }
                let value = String(trimmed
                    .dropFirst("asset_id:".count)
                )
                .trimmingCharacters(in: .whitespacesAndNewlines)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                return value.isEmpty ? nil : value
            }
        return (Array(Set(values)).sorted(), values.count)
    }
}
