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
    var mediaPreviewSummary: ProjectMediaPreviewSummary
    var playheadLabel: String?
    var isPlaying: Bool
    var syncGeneration: Int
    var audioSyncGeneration: Int
    var audioMuted: Bool
    var audioVolume: Double
    var onDiagnosticAction: (ProjectViewerReadinessDiagnostic.Action) -> Void
    var onTogglePlayback: () -> Void
    var onStepBackward: () -> Void
    var onStepForward: () -> Void
    var onToggleAudioMute: () -> Void
    var onAudioVolumeChange: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(selection?.clip.role.capitalized ?? project?.name ?? "Project")
                        .font(.title2.weight(.semibold))
                        .lineLimit(1)
                    Text(viewerSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
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
                mediaPreviewSummary: mediaPreviewSummary,
                isPlaying: isPlaying,
                syncGeneration: syncGeneration,
                audioSyncGeneration: audioSyncGeneration,
                audioMuted: audioMuted,
                audioVolume: audioVolume,
                onDiagnosticAction: onDiagnosticAction
            )
            .frame(minHeight: 280, maxHeight: .infinity)

            TransportBar(
                media: media,
                audioMedia: audioMedia,
                playheadLabel: playheadLabel,
                isPlaying: isPlaying,
                audioMuted: audioMuted,
                audioVolume: audioVolume,
                onTogglePlayback: onTogglePlayback,
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
            PlaybackContractBadge(status: playbackContract)
        }
        Label(project?.hasReview == true ? "Reviewed" : "Draft", systemImage: project?.hasReview == true ? "checkmark.seal" : "circle.dotted")
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
}

/// Tells the operator whether what they see in the viewer is approval-grade
/// (preview manifest derived from the current timeline) or approximate.
struct PlaybackContractBadge: View {
    let status: ProjectPlaybackContractStatus

    var body: some View {
        Label(label, systemImage: icon)
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.medium))
            .foregroundStyle(tint)
            .help(status.recommendation)
            .accessibilityLabel("Playback contract: \(label)")
    }

    private var label: String {
        switch status.state {
        case .exact: return "Exact preview"
        case .stale: return "Stale preview"
        case .legacyManifest: return "Unverified preview"
        case .missingManifest: return "No preview manifest"
        case .missingTimeline: return "No timeline"
        }
    }

    private var icon: String {
        switch status.state {
        case .exact: return "checkmark.shield"
        case .stale: return "exclamationmark.triangle"
        case .legacyManifest, .missingManifest, .missingTimeline: return "questionmark.diamond"
        }
    }

    private var tint: Color {
        switch status.state {
        case .exact: return .green
        case .stale: return .orange
        case .legacyManifest, .missingManifest, .missingTimeline: return .secondary
        }
    }
}

struct TransportBar: View {
    var media: ProjectMediaReference?
    var audioMedia: ProjectMediaReference?
    var playheadLabel: String?
    var isPlaying: Bool
    var audioMuted: Bool
    var audioVolume: Double
    var onTogglePlayback: () -> Void
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
            Spacer()
            mediaStatus
            audioStatus
            audioControls(sliderWidth: 90)
            Button { } label: { Image(systemName: "slider.horizontal.3") }
                .help("Viewer Settings")
        }
    }

    private var compactControls: some View {
        HStack(spacing: 10) {
            playbackControls
            timecodeLabel
            Spacer(minLength: 4)
            compactMediaStatus
            audioControls(sliderWidth: 68)
        }
    }

    private var playbackControls: some View {
        HStack(spacing: 10) {
            Button(action: onStepBackward) {
                Image(systemName: "backward.end.fill")
            }
            .help("Step Backward")
            .accessibilityLabel("Step backward")

            Button(action: onTogglePlayback) {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
            }
            .help(isPlaying ? "Pause" : "Play")
            .accessibilityLabel(isPlaying ? "Pause timeline" : "Play timeline")

            Button(action: onStepForward) {
                Image(systemName: "forward.end.fill")
            }
            .help("Step Forward")
            .accessibilityLabel("Step forward")
        }
    }

    private var timecodeLabel: some View {
        Text(playheadLabel ?? media?.sourceRangeLabel ?? "00:00:00:00")
            .font(.system(.body, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .accessibilityLabel("Playhead \(playheadLabel ?? media?.sourceRangeLabel ?? "00:00:00:00")")
    }

    @ViewBuilder
    private var mediaStatus: some View {
        if let media {
            Label(media.viewerModeLabel, systemImage: mediaStatusIcon(for: media))
                .font(.caption)
                .foregroundStyle(media.viewerNeedsAttention ? Color.orange : Color.secondary)
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
            Label("No audio", systemImage: "waveform.slash")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private var compactMediaStatus: some View {
        if let media, media.viewerNeedsAttention {
            Label(media.viewerModeLabel, systemImage: mediaStatusIcon(for: media))
                .font(.caption)
                .foregroundStyle(Color.orange)
                .lineLimit(1)
                .help(media.url?.path ?? media.filename)
        } else if audioMedia?.exists == false {
            Label("Audio", systemImage: "waveform.slash")
                .font(.caption)
                .foregroundStyle(Color.orange)
                .lineLimit(1)
                .help(audioMedia?.url?.path ?? audioMedia?.filename ?? "Missing audio")
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

    private func audioControls(sliderWidth: CGFloat) -> some View {
        HStack(spacing: 8) {
            Button(action: onToggleAudioMute) {
                Image(systemName: audioMuted || audioVolume <= 0 ? "speaker.slash.fill" : "speaker.wave.2.fill")
            }
            .help(audioMuted || audioVolume <= 0 ? "Unmute Audio" : "Mute Audio")
            .accessibilityLabel(audioMuted || audioVolume <= 0 ? "Unmute audio" : "Mute audio")

            Slider(
                value: Binding(
                    get: { audioVolume },
                    set: { onAudioVolumeChange($0) }
                ),
                in: 0...1
            )
            .frame(width: sliderWidth)
            .accessibilityLabel("Monitor volume")
        }
    }
}

struct ViewerSurface: View {
    var media: ProjectMediaReference?
    var audioMedia: ProjectMediaReference?
    var nextMedia: ProjectMediaReference?
    var mediaPreviewSummary: ProjectMediaPreviewSummary
    var isPlaying: Bool
    var syncGeneration: Int
    var audioSyncGeneration: Int
    var audioMuted: Bool
    var audioVolume: Double
    var onDiagnosticAction: (ProjectViewerReadinessDiagnostic.Action) -> Void

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(.black)

            if let videoURL {
                MediaVideoPlayer(
                    url: videoURL,
                    startSeconds: videoStartSeconds,
                    isPlaying: isPlaying,
                    syncGeneration: syncGeneration
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .accessibilityLabel("Program video preview")
            } else {
                placeholderView
            }

            if let audioSource, audioSource.exists, audioSource.canPlayAudio, let audioURL = audioSource.url {
                MediaAudioPlayer(
                    url: audioURL,
                    startSeconds: playbackStartSeconds(for: audioSource),
                    isPlaying: isPlaying,
                    syncGeneration: audioSource == audioMedia ? audioSyncGeneration : syncGeneration,
                    isMuted: audioMuted,
                    volume: Float(audioVolume)
                )
            }

            if let media, media.viewerNeedsAttention {
                VStack {
                    Spacer()
                    HStack {
                        MediaDiagnosticBadge(media: media)
                        Spacer(minLength: 0)
                    }
                    .padding(12)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var videoURL: URL? {
        guard let media, media.exists, media.isPlayableVideo else { return nil }
        return media.url
    }

    private var audioSource: ProjectMediaReference? {
        if let media, media.isTimelinePreview, media.canPlayAudio {
            return media
        }
        if let audioMedia, audioMedia.exists, audioMedia.canPlayAudio {
            return audioMedia
        }
        return media
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

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(media.viewerModeLabel, systemImage: icon)
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
        .accessibilityLabel("\(media.viewerModeLabel). \(detail)")
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
        if !media.exists {
            return media.url?.path ?? media.filename
        }
        if media.isTimelinePreview {
            return "Playing \(media.url?.lastPathComponent ?? media.filename); source \(media.sourceRangeLabel)"
        }
        if media.isSyntheticPreview {
            return "Playing synthetic 0:00; timeline source \(media.sourceRangeLabel)"
        }
        if media.isProxyPreview {
            return "Proxy file \(media.url?.lastPathComponent ?? media.filename); source \(media.sourceRangeLabel)"
        }
        if media.isPlayableAudio, !media.isPlayableVideo {
            return "Audio-only source \(media.url?.lastPathComponent ?? media.filename)"
        }
        return media.url?.lastPathComponent ?? media.filename
    }
}

struct MediaVideoPlayer: NSViewRepresentable {
    let url: URL
    let startSeconds: Double
    let isPlaying: Bool
    let syncGeneration: Int

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> PlayerContainerView {
        let view = PlayerContainerView()
        context.coordinator.configure(
            view: view,
            url: url,
            startSeconds: startSeconds,
            syncGeneration: syncGeneration
        )
        context.coordinator.updatePlayback(isPlaying: isPlaying)
        return view
    }

    func updateNSView(_ view: PlayerContainerView, context: Context) {
        context.coordinator.configure(
            view: view,
            url: url,
            startSeconds: startSeconds,
            syncGeneration: syncGeneration
        )
        context.coordinator.updatePlayback(isPlaying: isPlaying)
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
        private var itemStatusObservation: NSKeyValueObservation?
        private var pendingSeekSeconds: Double?
        private var posterRequestID = 0

        func configure(view: PlayerContainerView, url: URL, startSeconds: Double, syncGeneration: Int) {
            self.view = view
            let needsPlayer = currentURL != url || player == nil
            if needsPlayer {
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
            }

            if needsPlayer || lastSyncGeneration != syncGeneration {
                pendingSeekSeconds = startSeconds
                seek(to: startSeconds)
                requestPosterFrame(for: url, startSeconds: startSeconds, view: view)
                lastSyncGeneration = syncGeneration
            }

            player?.isMuted = true
        }

        func updatePlayback(isPlaying: Bool) {
            self.isPlaying = isPlaying
            view?.setPosterVisible(!isPlaying)
            isPlaying ? player?.play() : player?.pause()
        }

        func stop() {
            player?.pause()
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
            let time = CMTime(seconds: clampedSeekSeconds(seconds), preferredTimescale: 600)
            player?.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
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
    let syncGeneration: Int
    let isMuted: Bool
    let volume: Float
    @State private var player: AVPlayer

    init(url: URL, startSeconds: Double, isPlaying: Bool, syncGeneration: Int, isMuted: Bool, volume: Float) {
        self.url = url
        self.startSeconds = startSeconds
        self.isPlaying = isPlaying
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
        isPlaying ? player.play() : player.pause()
    }

    private func updateAudioMix() {
        player.isMuted = isMuted
        player.volume = max(0, min(volume, 1))
    }
}
