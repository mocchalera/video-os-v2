import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

struct ViewerPanel: View {
    var project: ProjectSummary?
    var playbackContract: ProjectPlaybackContractStatus?
    var selection: TimelineClipSelection?
    var media: ProjectMediaReference?
    var audioMedia: ProjectMediaReference?
    var nextMedia: ProjectMediaReference?
    var transitionPreview: ViewerTransitionPreview?
    var captionText: String?
    var monitorSnapshot: TimelineMonitorSnapshot?
    var interviewVisualTransformPreview: ReviewVisualTransform?
    var sequenceWidth: Int
    var sequenceHeight: Int
    var mediaPreviewSummary: ProjectMediaPreviewSummary
    var timelinePreviewDiagnostics: ProjectTimelinePreviewDiagnostics
    var playheadLabel: String?
    var isPlaying: Bool
    var playbackRate: Double
    var playbackRateLabel: String?
    var playbackLoopLabel: String?
    var isLoopPlaybackEnabled: Bool
    var syncGeneration: Int
    var audioSyncGeneration: Int
    var audioMuted: Bool
    var audioVolume: Double
    var onDiagnosticAction: (ProjectViewerReadinessDiagnostic.Action) -> Void
    var onTogglePlayback: () -> Void
    var onPlayReverse: () -> Void
    var onPlayForward: () -> Void
    var onTogglePlaybackLoop: () -> Void
    var onStepBackward: () -> Void
    var onStepForward: () -> Void
    var onToggleAudioMute: () -> Void
    var onAudioVolumeChange: (Double) -> Void
    var onPlaybackTimeUpdate: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(selection.map { localizedClipRole($0.clip.role) } ?? media?.displayName ?? project?.name ?? "プロジェクト")
                        .font(.title2.weight(.semibold))
                        .lineLimit(1)
                    Text(viewerSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let monitorSnapshot, monitorSnapshot.hasProgramSourceCue {
                        ViewerProgramSourceCue(snapshot: monitorSnapshot)
                    }
                    if let diagnosticsSubtitle {
                        Text(diagnosticsSubtitle)
                            .font(.caption2)
                            .foregroundStyle(diagnosticsNeedsAttention ? .orange : .secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .help(timelinePreviewDiagnostics.recommendation)
                            .accessibilityIdentifier("ViewerTimelinePreviewDiagnostics")
                    }
                }
                .layoutPriority(1)

                Spacer()

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        statusBadges
                    }
                    VStack(alignment: .trailing, spacing: 4) {
                        statusBadges
                    }
                }
            }

            ViewerSurface(
                media: media,
                audioMedia: audioMedia,
                nextMedia: nextMedia,
                transitionPreview: transitionPreview,
                captionText: captionText,
                interviewVisualTransformPreview: interviewVisualTransformPreview,
                sequenceWidth: sequenceWidth,
                sequenceHeight: sequenceHeight,
                mediaPreviewSummary: mediaPreviewSummary,
                isTimelineFallbackPlayback: isTimelineFallbackPlayback,
                isPlaying: isPlaying,
                playbackRate: playbackRate,
                syncGeneration: syncGeneration,
                audioSyncGeneration: audioSyncGeneration,
                audioMuted: audioMuted,
                audioVolume: audioVolume,
                onDiagnosticAction: onDiagnosticAction,
                onPlaybackTimeUpdate: onPlaybackTimeUpdate
            )
            .frame(minHeight: 280, maxHeight: .infinity)

            TransportBar(
                media: media,
                audioMedia: ProjectMediaResolver.preferredViewerAudioMedia(
                    programMedia: media,
                    audioMedia: audioMedia
                ),
                isTimelineFallbackPlayback: isTimelineFallbackPlayback,
                playheadLabel: playheadLabel,
                isPlaying: isPlaying,
                playbackRate: playbackRate,
                playbackRateLabel: playbackRateLabel,
                playbackLoopLabel: playbackLoopLabel,
                isLoopPlaybackEnabled: isLoopPlaybackEnabled,
                audioMuted: audioMuted,
                audioVolume: audioVolume,
                onTogglePlayback: onTogglePlayback,
                onPlayReverse: onPlayReverse,
                onPlayForward: onPlayForward,
                onTogglePlaybackLoop: onTogglePlaybackLoop,
                onStepBackward: onStepBackward,
                onStepForward: onStepForward,
                onToggleAudioMute: onToggleAudioMute,
                onAudioVolumeChange: onAudioVolumeChange
            )
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var statusBadges: some View {
        if project != nil, let playbackContract {
            PlaybackContractBadge(
                status: playbackContract,
                diagnostics: timelinePreviewDiagnostics,
                media: media
            )
        }
        Label(project?.hasReview == true ? "レビュー済み" : "下書き", systemImage: project?.hasReview == true ? "checkmark.seal" : "circle.dotted")
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.medium))
            .foregroundStyle(project?.hasReview == true ? .green : .secondary)
            .lineLimit(1)
    }

    private var viewerSubtitle: String {
        if let media {
            return "\(media.assetID) / \(media.filename) / \(media.sourceRangeLabel)"
        }
        return project?.path.path ?? "projects/ 配下にプロジェクトがありません"
    }

    private var diagnosticsSubtitle: String? {
        guard timelinePreviewDiagnostics.hasTimeline else { return nil }
        return [
            timelinePreviewDiagnostics.previewCoverageLabel,
            timelinePreviewDiagnostics.previewAudioLabel,
            timelinePreviewDiagnostics.trackCompositionLabel,
            timelinePreviewDiagnostics.transitionLabel,
            timelinePreviewDiagnostics.repeatRiskLabel
        ].joined(separator: " / ")
    }

    private var diagnosticsNeedsAttention: Bool {
        guard timelinePreviewDiagnostics.hasTimeline else { return false }
        if timelinePreviewDiagnostics.previewCoverageNeedsAttention { return true }
        if timelinePreviewDiagnostics.previewAudioNeedsAttention { return true }
        return timelinePreviewDiagnostics.editorialStructureNeedsAttention
    }

    private var isTimelineFallbackPlayback: Bool {
        guard timelinePreviewDiagnostics.hasTimeline, let media, media.exists else { return false }
        return !media.isTimelinePreview
    }
}

/// Tells the operator whether what they see in the viewer is approval-grade
/// (preview manifest derived from the current timeline) or approximate.
struct PlaybackContractBadge: View {
    let status: ProjectPlaybackContractStatus
    let diagnostics: ProjectTimelinePreviewDiagnostics
    let media: ProjectMediaReference?

    var body: some View {
        Label(label, systemImage: icon)
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.medium))
            .foregroundStyle(tint)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .help(helpText)
            .accessibilityLabel(accessibilityLabel)
    }

    private var label: String {
        if isSourcePlayback {
            return "ソース確認中"
        }
        if previewMediaMissing {
            return "プレビュー動画なし"
        }
        if diagnostics.previewAudioNeedsAttention {
            return "音声なしプレビュー"
        }
        if diagnostics.previewCoverageNeedsAttention {
            return "プレビュー不足"
        }
        if diagnostics.editorialStructureNeedsAttention {
            return "構成注意"
        }
        if diagnostics.previewUsesCollapsedGapContract {
            return "空白詰めプレビュー"
        }
        switch status.state {
        case .exact: return "照合済みプレビュー"
        case .stale: return "古いプレビュー"
        case .legacyManifest: return "未検証プレビュー"
        case .missingManifest: return "プレビュー情報なし"
        case .missingTimeline: return "タイムラインなし"
        }
    }

    private var icon: String {
        if isSourcePlayback {
            return "play.rectangle"
        }
        if diagnosticsNeedsAttention {
            return "exclamationmark.triangle"
        }
        switch status.state {
        case .exact: return "checkmark.shield"
        case .stale: return "exclamationmark.triangle"
        case .legacyManifest, .missingManifest, .missingTimeline: return "questionmark.diamond"
        }
    }

    private var tint: Color {
        if isSourcePlayback {
            return .orange
        }
        if diagnosticsNeedsAttention {
            return .orange
        }
        switch status.state {
        case .exact: return .green
        case .stale: return .orange
        case .legacyManifest, .missingManifest, .missingTimeline: return .secondary
        }
    }

    private var helpText: String {
        if isSourcePlayback {
            return "Viewerは現在位置の元素材を表示しています。timeline.jsonのトランジション、完成音声、複数トラック合成は再現されません。承認前にタイムラインプレビューを生成してください。"
        }
        if diagnosticsNeedsAttention {
            return diagnostics.recommendation
        }
        if diagnostics.previewUsesCollapsedGapContract {
            return diagnostics.recommendation
        }
        return status.recommendation
    }

    private var accessibilityLabel: String {
        if diagnostics.editorialStructureNeedsAttention,
           !diagnostics.previewCoverageNeedsAttention,
           !diagnostics.previewAudioNeedsAttention,
           !isSourcePlayback,
           !previewMediaMissing {
            return "再生契約: 照合済みプレビュー、構成注意"
        }
        return "再生契約: \(label)"
    }

    private var isSourcePlayback: Bool {
        guard let media, media.exists else { return false }
        return !media.isTimelinePreview
    }

    private var previewMediaMissing: Bool {
        diagnostics.hasTimeline && diagnostics.previewMediaFilename == nil
    }

    private var diagnosticsNeedsAttention: Bool {
        diagnostics.previewCoverageNeedsAttention
            || diagnostics.previewAudioNeedsAttention
            || diagnostics.editorialStructureNeedsAttention
    }
}

private struct ViewerProgramSourceCue: View {
    let snapshot: TimelineMonitorSnapshot

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                clipChips
            }
            VStack(alignment: .leading, spacing: 4) {
                clipChips
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Viewer.ProgramSourceCue")
        .help("Viewerが現在の再生位置で参照しているTimeline上の映像/音声clipと、次に切り替わるclipです。")
    }

    @ViewBuilder
    private var clipChips: some View {
        if let visual = snapshot.visual {
            ViewerProgramClipChip(
                roleLabel: "映像",
                systemImage: "play.rectangle.fill",
                tint: .accentColor,
                clip: visual,
                accessibilitySuffix: "Visual"
            )
        }
        if let audio = snapshot.audio {
            ViewerProgramClipChip(
                roleLabel: "音声",
                systemImage: "speaker.wave.2.fill",
                tint: .secondary,
                clip: audio,
                accessibilitySuffix: "Audio"
            )
        }
        if let upcomingClip {
            ViewerProgramClipChip(
                roleLabel: "次",
                systemImage: "forward.end.fill",
                tint: .orange,
                clip: upcomingClip,
                accessibilitySuffix: "Next"
            )
        }
    }

    private var upcomingClip: TimelineMonitorClip? {
        guard let nextProgram = snapshot.nextProgram else { return nil }
        if nextProgram.matches(snapshot.visual) || nextProgram.matches(snapshot.audio) {
            return nil
        }
        return nextProgram
    }
}

private struct ViewerProgramClipChip: View {
    let roleLabel: String
    let systemImage: String
    let tint: Color
    let clip: TimelineMonitorClip
    let accessibilitySuffix: String

    var body: some View {
        Label {
            HStack(spacing: 4) {
                Text(roleLabel)
                    .fontWeight(.semibold)
                Text("\(clip.trackID) / \(clip.clipID)")
                    .font(.system(size: 10, design: .monospaced))
                    .truncationMode(.middle)
                if let sourceTimeLabel {
                    Text(sourceTimeLabel)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: systemImage)
        }
        .labelStyle(.titleAndIcon)
        .font(.caption2)
        .foregroundStyle(tint)
        .lineLimit(1)
        .minimumScaleFactor(0.72)
        .padding(.horizontal, 7)
        .frame(height: 20)
        .frame(maxWidth: 210, alignment: .leading)
        .background(.thinMaterial, in: Capsule())
        .overlay {
            Capsule().stroke(tint.opacity(0.34), lineWidth: 0.8)
        }
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier("Viewer.ProgramSourceCue.\(accessibilitySuffix)")
    }

    private var sourceTimeLabel: String? {
        guard let sourceTimeUS = clip.sourceTimeUS else { return nil }
        return "src \(formatMicrosecondClock(sourceTimeUS))"
    }

    private var accessibilityLabel: String {
        var values = ["Viewer参照中", roleLabel, "\(clip.trackID)", "\(clip.clipID)", localizedTrackKind(clip.trackKind)]
        if let sourceTimeLabel {
            values.append(sourceTimeLabel)
        }
        return values.joined(separator: " ")
    }

    private func formatMicrosecondClock(_ microseconds: Int) -> String {
        let totalSeconds = max(0, Int((Double(microseconds) / 1_000_000).rounded(.down)))
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }
}

private extension TimelineMonitorSnapshot {
    var hasProgramSourceCue: Bool {
        visual != nil || audio != nil || nonCurrentNextProgram != nil
    }

    var nonCurrentNextProgram: TimelineMonitorClip? {
        guard let nextProgram else { return nil }
        if nextProgram.matches(visual) || nextProgram.matches(audio) {
            return nil
        }
        return nextProgram
    }
}

private extension TimelineMonitorClip {
    func matches(_ other: TimelineMonitorClip?) -> Bool {
        guard let other else { return false }
        return trackID == other.trackID && clipID == other.clipID
    }
}

struct TransportBar: View {
    var media: ProjectMediaReference?
    var audioMedia: ProjectMediaReference?
    var isTimelineFallbackPlayback: Bool
    var playheadLabel: String?
    var isPlaying: Bool
    var playbackRate: Double
    var playbackRateLabel: String?
    var playbackLoopLabel: String?
    var isLoopPlaybackEnabled: Bool
    var audioMuted: Bool
    var audioVolume: Double
    var onTogglePlayback: () -> Void
    var onPlayReverse: () -> Void
    var onPlayForward: () -> Void
    var onTogglePlaybackLoop: () -> Void
    var onStepBackward: () -> Void
    var onStepForward: () -> Void
    var onToggleAudioMute: () -> Void
    var onAudioVolumeChange: (Double) -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            expandedControls
            compactControls
        }
        .buttonStyle(.borderless)
        .controlSize(.large)
    }

    private var expandedControls: some View {
        HStack(spacing: 14) {
            playbackControls
            timecodeLabel
            playbackRateBadge
            loopRangeBadge
            Spacer()
            mediaStatus
            audioStatus
            audioControls(sliderWidth: 90)
            Button { } label: { Image(systemName: "slider.horizontal.3") }
                .help("ビューア設定")
        }
    }

    private var compactControls: some View {
        HStack(spacing: 10) {
            playbackControls
            timecodeLabel
            playbackRateBadge
            loopRangeBadge
            Spacer(minLength: 4)
            compactMediaStatus
            audioControls(sliderWidth: 68)
        }
    }

    private var playbackControls: some View {
        HStack(spacing: 10) {
            Button(action: onPlayReverse) {
                Image(systemName: "backward.fill")
            }
            .help("逆再生シャトル（J、押すたび1x/2x/4x）")
            .accessibilityLabel("逆再生シャトル")
            .accessibilityIdentifier("Transport.PlayReverse")

            Button(action: onStepBackward) {
                Image(systemName: "backward.end.fill")
            }
            .help("1フレーム戻る（,）")
            .accessibilityLabel("1フレーム戻る")
            .accessibilityIdentifier("Transport.StepBackward")

            Button(action: onTogglePlayback) {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
            }
            .help(isPlaying ? "一時停止（Space / K）" : "再生（Space）")
            .accessibilityLabel(isPlaying ? "タイムラインを一時停止" : "タイムラインを再生")
            .accessibilityIdentifier("Transport.PlayPause")

            Button(action: onStepForward) {
                Image(systemName: "forward.end.fill")
            }
            .help("1フレーム進む（.）")
            .accessibilityLabel("1フレーム進む")
            .accessibilityIdentifier("Transport.StepForward")

            Button(action: onPlayForward) {
                Image(systemName: "forward.fill")
            }
            .help("順方向シャトル（L、押すたび1x/2x/4x）")
            .accessibilityLabel("順方向シャトル")
            .accessibilityIdentifier("Transport.PlayForward")

            Button(action: onTogglePlaybackLoop) {
                Image(systemName: isLoopPlaybackEnabled ? "repeat.circle.fill" : "repeat")
            }
            .help(playbackLoopLabel.map { "\(isLoopPlaybackEnabled ? "ループ再生をオフ" : "ループ再生をオン")（R）: \($0)" } ?? "選択範囲をループ範囲に設定（R）")
            .accessibilityLabel(isLoopPlaybackEnabled ? "ループ再生をオフ" : "ループ再生をオン")
            .accessibilityIdentifier("Transport.ToggleLoop")
        }
    }

    private var timecodeLabel: some View {
        Text(playheadLabel ?? media?.sourceRangeLabel ?? "00:00:00:00")
            .font(.system(.body, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .accessibilityLabel("再生位置 \(playheadLabel ?? media?.sourceRangeLabel ?? "00:00:00:00")")
    }

    @ViewBuilder
    private var playbackRateBadge: some View {
        if let playbackRateLabel {
            Label(playbackRateLabel, systemImage: playbackRate < 0 ? "backward.fill" : "forward.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(playbackRate < 0 ? Color.orange : Color.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .accessibilityIdentifier("Transport.PlaybackRate")
                .help(playbackRate < 0 ? "J/Lで方向と速度を切り替えます。逆再生中はフレーム同期を優先し、音声は停止します。" : "J/Lで方向と速度を切り替えます。Kで停止します。")
        }
    }

    @ViewBuilder
    private var loopRangeBadge: some View {
        if let playbackLoopLabel {
            Label(playbackLoopLabel, systemImage: isLoopPlaybackEnabled ? "repeat.circle.fill" : "repeat")
                .font(.caption.weight(.semibold))
                .foregroundStyle(isLoopPlaybackEnabled ? Color.green : Color.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: 210, alignment: .leading)
                .help(isLoopPlaybackEnabled ? "範囲終端で先頭へ戻って再生します。Rでオフにできます。" : "範囲は保持されています。Rでループ再生をオンにできます。")
                .accessibilityIdentifier("Transport.LoopRange")
        }
    }

    @ViewBuilder
    private var mediaStatus: some View {
        if let media {
            Label(mediaStatusLabel(for: media), systemImage: mediaStatusIcon(for: media))
                .font(.caption)
                .foregroundStyle(media.viewerNeedsAttention || isTimelineFallbackPlayback ? Color.orange : Color.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 160, alignment: .trailing)
                .help(media.url?.path ?? media.filename)
        }
    }

    @ViewBuilder
    private var audioStatus: some View {
        if let audioMedia {
            Label(audioMedia.filename, systemImage: audioMedia.exists ? "waveform" : "waveform.slash")
                .font(.caption)
                .foregroundStyle(audioMedia.exists ? Color.secondary : Color.orange)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 180, alignment: .trailing)
                .help(audioMedia.url?.path ?? audioMedia.filename)
        } else {
            Label("音声なし", systemImage: "waveform.slash")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private var compactMediaStatus: some View {
        if let media, media.viewerNeedsAttention || isTimelineFallbackPlayback {
            Label(mediaStatusLabel(for: media), systemImage: mediaStatusIcon(for: media))
                .font(.caption)
                .foregroundStyle(Color.orange)
                .lineLimit(1)
                .help(media.url?.path ?? media.filename)
        } else if audioMedia?.exists == false {
            Label("音声", systemImage: "waveform.slash")
                .font(.caption)
                .foregroundStyle(Color.orange)
                .lineLimit(1)
                .help(audioMedia?.url?.path ?? audioMedia?.filename ?? "音声が見つかりません")
        }
    }

    private func mediaStatusIcon(for media: ProjectMediaReference) -> String {
        if !media.exists { return "questionmark.video" }
        if media.isTimelinePreview { return "play.rectangle.on.rectangle" }
        if media.isSyntheticPreview { return "rectangle.dashed" }
        if media.isProxyPreview { return "video.badge.checkmark" }
        if media.isPlayableVideo { return "play.rectangle" }
        if media.isPlayableAudio { return "waveform" }
        return "exclamationmark.triangle"
    }

    private func mediaStatusLabel(for media: ProjectMediaReference) -> String {
        isTimelineFallbackPlayback && !media.isTimelinePreview ? "ソース確認中" : media.viewerModeLabel
    }

    private func audioControls(sliderWidth: CGFloat) -> some View {
        HStack(spacing: 8) {
            Button(action: onToggleAudioMute) {
                Image(systemName: audioMuted || audioVolume <= 0 ? "speaker.slash.fill" : "speaker.wave.2.fill")
            }
            .help(audioMuted || audioVolume <= 0 ? "音声をオン" : "音声をミュート")
            .accessibilityLabel(audioMuted || audioVolume <= 0 ? "音声をオン" : "音声をミュート")

            Slider(
                value: Binding(
                    get: { audioVolume },
                    set: { onAudioVolumeChange($0) }
                ),
                in: 0...1
            )
            .frame(width: sliderWidth)
            .accessibilityLabel("モニター音量")
        }
    }
}

struct ViewerTransitionPreview: Equatable {
    let media: ProjectMediaReference
    let opacity: Double
    let label: String
    let syncGeneration: Int
}

struct ViewerSurface: View {
    var media: ProjectMediaReference?
    var audioMedia: ProjectMediaReference?
    var nextMedia: ProjectMediaReference?
    var transitionPreview: ViewerTransitionPreview?
    var captionText: String?
    var interviewVisualTransformPreview: ReviewVisualTransform?
    var sequenceWidth: Int
    var sequenceHeight: Int
    var mediaPreviewSummary: ProjectMediaPreviewSummary
    var isTimelineFallbackPlayback: Bool
    var isPlaying: Bool
    var playbackRate: Double
    var syncGeneration: Int
    var audioSyncGeneration: Int
    var audioMuted: Bool
    var audioVolume: Double
    var onDiagnosticAction: (ProjectViewerReadinessDiagnostic.Action) -> Void
    var onPlaybackTimeUpdate: (Double) -> Void

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(.black)

            if let videoURL {
                GeometryReader { proxy in
                    MediaVideoPlayer(
                        url: videoURL,
                        startSeconds: videoStartSeconds,
                        isPlaying: isPlaying,
                        playbackRate: playbackRate,
                        syncGeneration: syncGeneration,
                        onPlaybackTimeUpdate: onPlaybackTimeUpdate
                    )
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .scaleEffect(interviewPreviewZoom)
                    .offset(
                        x: interviewPreviewOffsetX(viewerWidth: proxy.size.width),
                        y: interviewPreviewOffsetY(viewerHeight: proxy.size.height)
                    )
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .accessibilityLabel("プログラム映像プレビュー")
            } else {
                placeholderView
            }

            if let transitionPreview, let overlayVideoURL {
                MediaVideoPlayer(
                    url: overlayVideoURL,
                    startSeconds: transitionPreview.media.viewerStartSeconds,
                    isPlaying: isPlaying,
                    playbackRate: playbackRate,
                    syncGeneration: syncGeneration ^ transitionPreview.syncGeneration,
                    onPlaybackTimeUpdate: { _ in }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .opacity(transitionPreview.opacity)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }

            if let audioSource, audioSource.exists, audioSource.canPlayAudio, let audioURL = audioSource.url {
                MediaAudioPlayer(
                    url: audioURL,
                    startSeconds: playbackStartSeconds(for: audioSource),
                    isPlaying: isPlaying,
                    playbackRate: playbackRate,
                    syncGeneration: audioSource == audioMedia ? audioSyncGeneration : syncGeneration,
                    isMuted: audioMuted,
                    volume: Float(audioVolume)
                )
            }

            if let captionText, !captionText.isEmpty {
                VStack {
                    Spacer(minLength: 0)
                    Text(captionText)
                        .font(.system(size: 24, weight: .semibold, design: .rounded))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.white)
                        .lineLimit(3)
                        .minimumScaleFactor(0.72)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 10)
                        .background(.black.opacity(0.76), in: RoundedRectangle(cornerRadius: 8))
                        .shadow(color: .black.opacity(0.55), radius: 4, y: 2)
                        .padding(.horizontal, 28)
                        .padding(.bottom, 28)
                        .accessibilityIdentifier("Viewer.CaptionOverlay")
                }
                .allowsHitTesting(false)
            }

            if let media, media.viewerNeedsAttention || isTimelineFallbackPlayback {
                VStack {
                    Spacer()
                    HStack {
                        MediaDiagnosticBadge(media: media, isTimelineFallbackPlayback: isTimelineFallbackPlayback)
                        Spacer(minLength: 0)
                    }
                    .padding(12)
                }
            }

            if let transitionPreview {
                VStack {
                    HStack {
                        Spacer(minLength: 0)
                        TransitionPreviewBadge(
                            label: transitionPreview.label,
                            opacity: transitionPreview.opacity
                        )
                    }
                    .padding(12)
                    Spacer(minLength: 0)
                }
            }

            if interviewVisualTransformPreview != nil {
                VStack {
                    HStack {
                        Label("画角プレビュー", systemImage: "viewfinder")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .background(.blue.opacity(0.82), in: Capsule())
                            .accessibilityIdentifier("Viewer.InterviewReframePreviewBadge")
                        Spacer(minLength: 0)
                    }
                    .padding(12)
                    Spacer(minLength: 0)
                }
                .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var videoURL: URL? {
        guard let media, media.exists, media.isPlayableVideo else { return nil }
        return media.url
    }

    private var interviewPreviewZoom: Double {
        max(1, interviewVisualTransformPreview?.zoom ?? 1)
    }

    private func interviewPreviewOffsetX(viewerWidth: CGFloat) -> CGFloat {
        guard sequenceWidth > 0, let x = interviewVisualTransformPreview?.position?.x else { return 0 }
        return CGFloat(x / Double(sequenceWidth)) * viewerWidth
    }

    private func interviewPreviewOffsetY(viewerHeight: CGFloat) -> CGFloat {
        guard sequenceHeight > 0, let y = interviewVisualTransformPreview?.position?.y else { return 0 }
        return CGFloat(y / Double(sequenceHeight)) * viewerHeight
    }

    private var audioSource: ProjectMediaReference? {
        ProjectMediaResolver.preferredViewerAudioMedia(
            programMedia: media,
            audioMedia: audioMedia
        )
    }

    private var overlayVideoURL: URL? {
        guard let transitionPreview,
              transitionPreview.media.exists,
              transitionPreview.media.isPlayableVideo else {
            return nil
        }
        return transitionPreview.media.url
    }

    private var videoStartSeconds: Double {
        guard let media else { return 0 }
        return playbackStartSeconds(for: media)
    }

    private func playbackStartSeconds(for source: ProjectMediaReference) -> Double {
        source.viewerStartSeconds
    }

    private var placeholderView: some View {
        let diagnostic = ProjectViewerReadinessDiagnostic.diagnose(
            media: media,
            previewSummary: mediaPreviewSummary
        )

        return VStack(spacing: 10) {
            Image(systemName: placeholderIcon(for: diagnostic))
                .font(.system(size: 44))
                .foregroundStyle(placeholderTint(for: diagnostic))
            Text(diagnostic.title)
                .font(.headline)
                .foregroundStyle(placeholderTint(for: diagnostic))
                .lineLimit(1)
            Text(diagnostic.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .truncationMode(.middle)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
                .help(diagnostic.detail)
            if let action = diagnostic.action, let actionLabel = diagnostic.actionLabel {
                Button {
                    onDiagnosticAction(action)
                } label: {
                    Label(actionLabel, systemImage: "arrow.right.circle")
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(placeholderTint(for: diagnostic))
                .accessibilityIdentifier("ViewerDiagnosticActionButton")
                .help(actionLabel)
            }
        }
    }

    private func placeholderIcon(for diagnostic: ProjectViewerReadinessDiagnostic) -> String {
        switch diagnostic.severity {
        case .ready:
            return "play.rectangle"
        case .info:
            return "cursorarrow.click.2"
        case .warning:
            return media?.exists == true ? "exclamationmark.triangle" : "questionmark.video"
        }
    }

    private func placeholderTint(for diagnostic: ProjectViewerReadinessDiagnostic) -> Color {
        switch diagnostic.severity {
        case .ready:
            return .secondary
        case .info:
            return .secondary
        case .warning:
            return .orange
        }
    }
}

struct MediaDiagnosticBadge: View {
    let media: ProjectMediaReference
    var isTimelineFallbackPlayback = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(label, systemImage: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(tint)
                .lineLimit(1)
            Text(detail)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.82))
                .lineLimit(2)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(tint.opacity(0.45), lineWidth: 1)
        )
        .frame(maxWidth: 340, alignment: .leading)
        .help(media.url?.path ?? media.filename)
        .accessibilityLabel("\(label). \(detail)")
    }

    private var label: String {
        isTimelineFallbackPlayback && media.exists && !media.isTimelinePreview
            ? "ソース確認中"
            : media.viewerModeLabel
    }

    private var icon: String {
        if !media.exists { return "questionmark.video" }
        if media.isTimelinePreview { return "play.rectangle.on.rectangle" }
        if media.isSyntheticPreview { return "rectangle.dashed" }
        if media.isProxyPreview { return "video.badge.checkmark" }
        if media.isPlayableAudio { return "waveform" }
        return "exclamationmark.triangle"
    }

    private var tint: Color {
        if media.exists, media.isProxyPreview { return .blue }
        return .orange
    }

    private var detail: String {
        if isTimelineFallbackPlayback, media.exists, !media.isTimelinePreview {
            return "元素材を表示中です。クロスフェードは簡易表示し、完成音声や複数トラック合成は保存して更新後に確認します。"
        }
        if !media.exists {
            return media.url?.path ?? media.filename
        }
        if media.isTimelinePreview {
            return "再生中: \(media.url?.lastPathComponent ?? media.filename) / 参照位置 \(media.sourceRangeLabel)"
        }
        if media.isSyntheticPreview {
            return "合成素材を0:00から再生中 / タイムライン参照 \(media.sourceRangeLabel)"
        }
        if media.isProxyPreview {
            return "プロキシ: \(media.url?.lastPathComponent ?? media.filename) / 元素材位置 \(media.sourceRangeLabel)"
        }
        if media.isPlayableAudio, !media.isPlayableVideo {
            return "音声のみ: \(media.url?.lastPathComponent ?? media.filename)"
        }
        return media.url?.lastPathComponent ?? media.filename
    }
}

struct TransitionPreviewBadge: View {
    let label: String
    let opacity: Double

    var body: some View {
        Label("\(label) \(percentageText)", systemImage: "rectangle.on.rectangle")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.black.opacity(0.68), in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.white.opacity(0.22), lineWidth: 1)
            )
            .accessibilityLabel("\(label) プレビュー \(percentageText)")
            .accessibilityIdentifier("Viewer.TransitionPreviewBadge")
    }

    private var percentageText: String {
        "\(Int((min(1, max(0, opacity)) * 100).rounded()))%"
    }
}

struct MediaVideoPlayer: NSViewRepresentable {
    let url: URL
    let startSeconds: Double
    let isPlaying: Bool
    let playbackRate: Double
    let syncGeneration: Int
    let onPlaybackTimeUpdate: (Double) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onPlaybackTimeUpdate: onPlaybackTimeUpdate)
    }

    func makeNSView(context: Context) -> PlayerContainerView {
        let view = PlayerContainerView()
        context.coordinator.updatePlaybackTimeHandler(onPlaybackTimeUpdate)
        context.coordinator.configure(
            view: view,
            url: url,
            startSeconds: startSeconds,
            syncGeneration: syncGeneration
        )
        context.coordinator.updatePlayback(isPlaying: isPlaying, playbackRate: playbackRate)
        return view
    }

    func updateNSView(_ view: PlayerContainerView, context: Context) {
        context.coordinator.updatePlaybackTimeHandler(onPlaybackTimeUpdate)
        context.coordinator.configure(
            view: view,
            url: url,
            startSeconds: startSeconds,
            syncGeneration: syncGeneration
        )
        context.coordinator.updatePlayback(isPlaying: isPlaying, playbackRate: playbackRate)
    }

    static func dismantleNSView(_ nsView: PlayerContainerView, coordinator: Coordinator) {
        coordinator.stop()
        nsView.player = nil
    }

    final class PlayerContainerView: NSView {
        private let backingLayer = CALayer()
        private let playerLayer = AVPlayerLayer()
        private let posterLayer = CALayer()

        var player: AVPlayer? {
            get { playerLayer.player }
            set {
                ensurePlayerLayerAttached()
                playerLayer.player = newValue
            }
        }

        override init(frame frameRect: NSRect) {
            super.init(frame: frameRect)
            wantsLayer = true
            layer = backingLayer
            backingLayer.backgroundColor = NSColor.black.cgColor
            playerLayer.zPosition = 0
            playerLayer.videoGravity = .resizeAspect
            posterLayer.zPosition = 1
            posterLayer.contentsGravity = .resizeAspect
            posterLayer.backgroundColor = NSColor.black.cgColor
            posterLayer.isHidden = true
            ensurePlayerLayerAttached()
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            nil
        }

        override func layout() {
            super.layout()
            ensurePlayerLayerAttached()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            playerLayer.frame = bounds
            posterLayer.frame = bounds
            CATransaction.commit()
        }

        func setPosterImage(_ image: CGImage?) {
            ensurePlayerLayerAttached()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            posterLayer.contents = image
            posterLayer.isHidden = image == nil
            CATransaction.commit()
        }

        func setPosterVisible(_ visible: Bool) {
            ensurePlayerLayerAttached()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            posterLayer.isHidden = !visible || posterLayer.contents == nil
            CATransaction.commit()
        }

        private func ensurePlayerLayerAttached() {
            if layer == nil {
                wantsLayer = true
                layer = backingLayer
            }
            if playerLayer.superlayer !== layer {
                playerLayer.removeFromSuperlayer()
                layer?.addSublayer(playerLayer)
            }
            if posterLayer.superlayer !== layer {
                posterLayer.removeFromSuperlayer()
                layer?.addSublayer(posterLayer)
            }
        }
    }

    final class Coordinator {
        private var currentURL: URL?
        private var lastSyncGeneration: Int?
        private var currentDurationSeconds: Double?
        private var player: AVPlayer?
        private weak var view: PlayerContainerView?
        private var isPlaying = false
        private var playbackRate: Double = 0
        private var itemStatusObservation: NSKeyValueObservation?
        private var pendingSeekSeconds: Double?
        private var posterRequestID = 0
        private var timeObserverToken: Any?
        private var onPlaybackTimeUpdate: (Double) -> Void

        init(onPlaybackTimeUpdate: @escaping (Double) -> Void) {
            self.onPlaybackTimeUpdate = onPlaybackTimeUpdate
        }

        func updatePlaybackTimeHandler(_ handler: @escaping (Double) -> Void) {
            onPlaybackTimeUpdate = handler
        }

        func configure(view: PlayerContainerView, url: URL, startSeconds: Double, syncGeneration: Int) {
            self.view = view
            let needsPlayer = currentURL != url || player == nil
            if needsPlayer {
                removeTimeObserver()
                let asset = AVURLAsset(url: url)
                let playerItem = AVPlayerItem(asset: asset)
                let player = AVPlayer(playerItem: playerItem)
                player.isMuted = true
                player.actionAtItemEnd = .pause
                self.player = player
                currentURL = url
                currentDurationSeconds = Self.durationSeconds(for: playerItem.duration)
                observeReadiness(for: playerItem, url: url)
                view.player = player
                addTimeObserver(to: player)
            }

            if needsPlayer || lastSyncGeneration != syncGeneration {
                pendingSeekSeconds = startSeconds
                seek(to: startSeconds)
                if !isPlaying {
                    requestPosterFrame(for: url, startSeconds: startSeconds, view: view)
                }
                lastSyncGeneration = syncGeneration
            }

            player?.isMuted = true
        }

        func updatePlayback(isPlaying: Bool, playbackRate: Double) {
            self.isPlaying = isPlaying
            self.playbackRate = playbackRate
            view?.setPosterVisible(!isPlaying)
            if isPlaying {
                player?.rate = Float(playbackRate == 0 ? 1 : playbackRate)
            } else {
                player?.pause()
            }
        }

        func stop() {
            player?.pause()
            removeTimeObserver()
            player = nil
            view?.setPosterImage(nil)
            view = nil
            currentURL = nil
            lastSyncGeneration = nil
            currentDurationSeconds = nil
            pendingSeekSeconds = nil
            itemStatusObservation = nil
            posterRequestID &+= 1
        }

        private func observeReadiness(for item: AVPlayerItem, url: URL) {
            itemStatusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self, weak item] observedItem, _ in
                guard let self, let item else { return }
                guard observedItem.status == .readyToPlay else { return }
                DispatchQueue.main.async { [weak self, weak item] in
                    guard let self, let item, self.currentURL == url else { return }
                    self.currentDurationSeconds = Self.durationSeconds(for: item.duration)
                    if let pendingSeekSeconds = self.pendingSeekSeconds {
                        self.seek(to: pendingSeekSeconds)
                    }
                }
            }
        }

        private func seek(to seconds: Double) {
            let clampedSeconds = clampedSeekSeconds(seconds)
            onPlaybackTimeUpdate(clampedSeconds)
            let time = CMTime(seconds: clampedSeconds, preferredTimescale: 600)
            player?.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
        }

        private func addTimeObserver(to player: AVPlayer) {
            timeObserverToken = player.addPeriodicTimeObserver(
                forInterval: CMTime(seconds: 0.1, preferredTimescale: 600),
                queue: .main
            ) { [weak self] time in
                guard let self else { return }
                let seconds = time.seconds
                guard seconds.isFinite, seconds >= 0 else { return }
                self.onPlaybackTimeUpdate(seconds)
            }
        }

        private func removeTimeObserver() {
            guard let timeObserverToken else { return }
            player?.removeTimeObserver(timeObserverToken)
            self.timeObserverToken = nil
        }

        private func requestPosterFrame(for url: URL, startSeconds: Double, view: PlayerContainerView) {
            posterRequestID &+= 1
            let requestID = posterRequestID
            view.setPosterImage(nil)
            generatePosterFrame(
                with: Self.makePosterFrameGenerator(url: url),
                url: url,
                requestID: requestID,
                times: Self.posterFrameTimes(for: startSeconds),
                index: 0,
                view: view
            )
        }

        private func generatePosterFrame(
            with generator: AVAssetImageGenerator,
            url: URL,
            requestID: Int,
            times: [CMTime],
            index: Int,
            view: PlayerContainerView
        ) {
            guard index < times.count else { return }
            generator.generateCGImageAsynchronously(for: times[index]) { [weak self, weak view, generator] image, _, _ in
                DispatchQueue.main.async { [weak self, weak view] in
                    guard let view else { return }
                    guard let self,
                          self.posterRequestID == requestID,
                          self.currentURL == url
                    else {
                        return
                    }
                    if let image {
                        view.setPosterImage(image)
                        view.setPosterVisible(!self.isPlaying)
                    } else {
                        self.generatePosterFrame(
                            with: generator,
                            url: url,
                            requestID: requestID,
                            times: times,
                            index: index + 1,
                            view: view
                        )
                    }
                }
            }
        }

        private static func makePosterFrameGenerator(url: URL) -> AVAssetImageGenerator {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 1600, height: 1600)
            generator.requestedTimeToleranceBefore = CMTime(seconds: 0.25, preferredTimescale: 600)
            generator.requestedTimeToleranceAfter = CMTime(seconds: 0.25, preferredTimescale: 600)
            return generator
        }

        private static func posterFrameTimes(for seconds: Double) -> [CMTime] {
            let requested = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
            guard seconds > 0 else { return [requested] }
            return [requested, .zero]
        }

        private func clampedSeekSeconds(_ seconds: Double) -> Double {
            let requested = max(0, seconds)
            let duration = currentDurationSeconds ?? Self.durationSeconds(for: player?.currentItem?.duration)
            guard let duration else { return requested }
            let upperBound = max(0, duration - 0.05)
            return min(requested, upperBound)
        }

        private static func durationSeconds(for duration: CMTime?) -> Double? {
            guard let duration else { return nil }
            let seconds = duration.seconds
            guard seconds.isFinite, seconds > 0 else { return nil }
            return seconds
        }
    }
}

struct MediaAudioPlayer: View {
    let url: URL
    let startSeconds: Double
    let isPlaying: Bool
    let playbackRate: Double
    let syncGeneration: Int
    let isMuted: Bool
    let volume: Float
    @State private var player: AVPlayer

    init(url: URL, startSeconds: Double, isPlaying: Bool, playbackRate: Double, syncGeneration: Int, isMuted: Bool, volume: Float) {
        self.url = url
        self.startSeconds = startSeconds
        self.isPlaying = isPlaying
        self.playbackRate = playbackRate
        self.syncGeneration = syncGeneration
        self.isMuted = isMuted
        self.volume = volume
        _player = State(initialValue: AVPlayer(url: url))
    }

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onAppear {
                seekToStart()
                updatePlayback()
            }
            .onChange(of: url) { _, newURL in
                player = AVPlayer(url: newURL)
                seekToStart()
                updatePlayback()
            }
            .onChange(of: syncGeneration) { _, _ in
                seekToStart()
                updatePlayback()
            }
            .onChange(of: isMuted) { _, _ in
                updateAudioMix()
            }
            .onChange(of: volume) { _, _ in
                updateAudioMix()
            }
            .onChange(of: isPlaying) { _, _ in
                updatePlayback()
            }
            .onChange(of: playbackRate) { _, _ in
                updatePlayback()
            }
    }

    private func seekToStart() {
        let time = CMTime(seconds: clampedSeekSeconds(startSeconds), preferredTimescale: 600)
        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
    }

    private func clampedSeekSeconds(_ seconds: Double) -> Double {
        let requested = max(0, seconds)
        guard let duration = durationSeconds(for: player.currentItem?.duration) else { return requested }
        let upperBound = max(0, duration - 0.05)
        return min(requested, upperBound)
    }

    private func durationSeconds(for duration: CMTime?) -> Double? {
        guard let duration else { return nil }
        let seconds = duration.seconds
        guard seconds.isFinite, seconds > 0 else { return nil }
        return seconds
    }

    private func updatePlayback() {
        updateAudioMix()
        if isPlaying, playbackRate > 0 {
            player.rate = Float(playbackRate)
        } else {
            player.pause()
        }
    }

    private func updateAudioMix() {
        player.isMuted = isMuted
        player.volume = max(0, min(volume, 1))
    }
}

// MARK: - Canonical graphical caption projection

/// A projection of the service-resolved caption treatment. This view owns no
/// style registry or safe-zone policy; it only renders the typed canonical
/// input and reports a local drag/resize candidate back to the session.
struct CaptionCanonicalTreatmentOverlay: View {
    let text: String
    let projection: CaptionVisualResolvedProjection
    let operation: CaptionVisualTreatmentOperation
    let input: CaptionVisualTreatmentInputDocument
    let safeZoneProfile: CaptionSafeZoneProfileDocument?
    let status: CaptionVisualTreatmentStatus
    let reasons: [String]
    let showsSafeZoneOverlay: Bool
    let isEditable: Bool
    let onOperationChanged: (CaptionVisualTreatmentOperation) -> Void
    let onOperationCommitted: (CaptionVisualTreatmentOperation) -> Void

    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion
    @State private var dragOrigin: CaptionVisualRect?
    @State private var resizeOrigin: CaptionVisualRect?
    @State private var gestureState = CaptionVisualGestureCommitState()

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                if showsSafeZoneOverlay {
                    CaptionSafeZoneProfileOverlay(profile: safeZoneProfile)
                }

                let rect = resolvedRect
                treatmentCard(rect: rect, in: geometry.size)
                    .position(
                        x: geometry.size.width * (rect.x + rect.width / 2),
                        y: geometry.size.height * (rect.y + rect.height / 2)
                    )

                VStack {
                    HStack(alignment: .top, spacing: 6) {
                        Label(status.localizedLabel, systemImage: statusIcon)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(statusColor)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 5)
                            .background(.thinMaterial, in: Capsule())
                        Spacer()
                        Label(
                            safeZoneProfile == nil
                                ? "safe-zone unknown"
                                : (safeZoneProfile?.isHumanHold == true ? "safe-zone HOLD" : "safe-zone measured"),
                            systemImage: safeZoneProfile?.isHumanHold == true ? "hand.raised.fill" : "viewfinder"
                        )
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(safeZoneProfile?.isHumanHold == true || safeZoneProfile == nil ? .orange : .green)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 5)
                        .background(.thinMaterial, in: Capsule())
                    }
                    .padding(9)
                    Spacer()
                    if !reasons.isEmpty {
                        Text(reasons.joined(separator: " / "))
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .lineLimit(2)
                            .padding(7)
                            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 6))
                            .padding(9)
                    }
                }
                .allowsHitTesting(false)
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityIdentifier("CaptionCanonicalTreatmentOverlay.\(operation.captionID)")
        }
    }

    private var resolvedRect: CaptionVisualRect {
        operation.rect ?? CaptionVisualRect(x: 0.14, y: 0.76, width: 0.72, height: 0.14)
    }

    @ViewBuilder
    private func treatmentCard(rect: CaptionVisualRect, in size: CGSize) -> some View {
        let fontSize = max(9, projection.fontSizePx1080 * size.height / 1080 * (operation.referenceScale ?? 1) * projection.emphasisScale)
        let fillColor = canonicalColor(projection.fillRGBA) ?? Color.primary
        let outlineColor = canonicalColor(projection.outlineRGBA) ?? Color.secondary
        let panelColor: Color = projection.panelEnabled ? outlineColor.opacity(0.68) : .clear
        let strokeColor: Color = projection.outlineEnabled ? outlineColor : .clear
        let card = ZStack(alignment: .bottomTrailing) {
            if StudioBundledFontRegistry.registrationReport.canRenderCustomFont(family: projection.fontFamily) {
                Text(text)
                    .font(.custom(projection.fontFamily, size: fontSize).weight(viewerSwiftUIWeight))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(fillColor)
                    .lineLimit(3)
                    .minimumScaleFactor(0.72)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .frame(width: max(30, size.width * rect.width), height: max(24, size.height * rect.height))
                    .background(panelColor, in: RoundedRectangle(cornerRadius: 7))
                    .overlay {
                        RoundedRectangle(cornerRadius: 7)
                            .stroke(strokeColor, lineWidth: max(0.8, projection.outlinePx1080 * size.height / 1080))
                    }
                    .shadow(color: projection.shadowEnabled ? outlineColor.opacity(0.72) : .clear, radius: max(2, projection.shadowPx1080 * size.height / 1080))
            } else {
                Label("選択fontを登録できないためcanonical previewを停止しました", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
                    .frame(width: max(30, size.width * rect.width), height: max(24, size.height * rect.height))
                    .background(.black.opacity(0.68), in: RoundedRectangle(cornerRadius: 7))
            }
            if isEditable {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.primary)
                    .padding(5)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 5))
                    .contentShape(Rectangle())
                    .gesture(resizeGesture(in: size))
                    .accessibilityLabel("caption treatmentのsizeを変更")
            }
        }
        .frame(width: max(30, size.width * rect.width), height: max(24, size.height * rect.height))
        .contentShape(Rectangle())

        if isEditable {
            card
                .gesture(dragGesture(in: size))
                .onHover { hovering in
                    (hovering ? NSCursor.openHand : NSCursor.arrow).set()
                }
        } else {
            card
        }
    }

    private func dragGesture(in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { value in
                if dragOrigin == nil { dragOrigin = resolvedRect }
                guard var next = dragOrigin else { return }
                next.x = clamped(value: next.x + Double(value.translation.width / max(size.width, 1)), lower: 0, upper: 1 - next.width)
                next.y = clamped(value: next.y + Double(value.translation.height / max(size.height, 1)), lower: 0, upper: 1 - next.height)
                var updated = gestureState.pendingOperation ?? operation
                updated.rect = next
                gestureState.changed(updated)
                onOperationChanged(updated)
            }
            .onEnded { _ in
                if let gestureOperation = gestureState.ended() { onOperationCommitted(gestureOperation) }
                dragOrigin = nil
            }
    }

    private func resizeGesture(in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { value in
                if resizeOrigin == nil { resizeOrigin = resolvedRect }
                guard let origin = resizeOrigin else { return }
                let width = clamped(value: origin.width + Double(value.translation.width / max(size.width, 1)), lower: 0.12, upper: 0.92)
                let height = clamped(value: origin.height + Double(value.translation.height / max(size.height, 1)), lower: 0.08, upper: 0.72)
                var updated = gestureState.pendingOperation ?? operation
                updated.rect = CaptionVisualRect(
                    x: min(origin.x, 1 - width),
                    y: min(origin.y, 1 - height),
                    width: width,
                    height: height
                )
                let originWidth = max(origin.width, 0.01)
                updated.referenceScale = min(max((updated.referenceScale ?? 1) * width / originWidth, 0.25), 4)
                gestureState.changed(updated)
                onOperationChanged(updated)
            }
            .onEnded { _ in
                if let gestureOperation = gestureState.ended() { onOperationCommitted(gestureOperation) }
                resizeOrigin = nil
            }
    }

    private func clamped(value: Double, lower: Double, upper: Double) -> Double {
        min(max(value, lower), upper)
    }

    private var statusIcon: String {
        switch status {
        case .ready: return "checkmark.circle.fill"
        case .fallback: return "arrow.triangle.branch"
        case .humanHold: return "hand.raised.fill"
        case .blocked: return "xmark.octagon.fill"
        }
    }

    private var statusColor: Color {
        switch status {
        case .ready: return .green
        case .fallback, .humanHold: return .orange
        case .blocked: return .red
        }
    }

    private var accessibilityLabel: String {
        let identity = input.identity(for: operation.captionID)
        let timing = identity.map { "IN \($0.timelineInFrame)、\($0.timelineDurationFrames)フレーム" } ?? "timing unknown"
        return "canonical caption treatment、\(operation.captionID)、\(timing)、style \(projection.styleRef)、effect \(projection.effectRef ?? "none")、\(status.localizedLabel)"
    }

    private var viewerSwiftUIWeight: Font.Weight {
        switch projection.fontWeight {
        case 900...: return .black
        case 800...: return .heavy
        case 700...: return .bold
        default: return .regular
        }
    }

    private func canonicalColor(_ rgba: String) -> Color? {
        guard rgba.count == 8,
              let value = UInt32(rgba, radix: 16)
        else { return nil }
        return Color(
            red: Double((value >> 24) & 0xFF) / 255,
            green: Double((value >> 16) & 0xFF) / 255,
            blue: Double((value >> 8) & 0xFF) / 255,
            opacity: Double(value & 0xFF) / 255
        )
    }
}

struct CaptionSafeZoneProfileOverlay: View {
    let profile: CaptionSafeZoneProfileDocument?

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                if let profile {
                    ForEach(profile.geometry.safeRegions.regions) { region in
                        Rectangle()
                            .stroke(Color.green.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                            .frame(
                                width: geometry.size.width * region.rect.width,
                                height: geometry.size.height * region.rect.height
                            )
                            .position(
                                x: geometry.size.width * (region.rect.x + region.rect.width / 2),
                                y: geometry.size.height * (region.rect.y + region.rect.height / 2)
                            )
                            .accessibilityHidden(true)
                    }
                    ForEach(profile.geometry.uiRegions.regions) { region in
                        Rectangle()
                            .stroke(Color.orange.opacity(0.68), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                            .frame(
                                width: geometry.size.width * region.rect.width,
                                height: geometry.size.height * region.rect.height
                            )
                            .position(
                                x: geometry.size.width * (region.rect.x + region.rect.width / 2),
                                y: geometry.size.height * (region.rect.y + region.rect.height / 2)
                            )
                            .accessibilityHidden(true)
                    }
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
