import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

struct ViewerPanel: View {
    var project: ProjectSummary?
    var selection: TimelineClipSelection?
    var media: ProjectMediaReference?
    var audioMedia: ProjectMediaReference?
    var nextMedia: ProjectMediaReference?
    var playheadLabel: String?
    var isPlaying: Bool
    var syncGeneration: Int
    var audioSyncGeneration: Int
    var audioMuted: Bool
    var audioVolume: Double
    var onTogglePlayback: () -> Void
    var onStepBackward: () -> Void
    var onStepForward: () -> Void
    var onToggleAudioMute: () -> Void
    var onAudioVolumeChange: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(selection?.clip.role.capitalized ?? project?.name ?? "Project")
                        .font(.title2.weight(.semibold))
                    Text(viewerSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Label(project?.hasReview == true ? "Reviewed" : "Draft", systemImage: project?.hasReview == true ? "checkmark.seal" : "circle.dotted")
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(project?.hasReview == true ? .green : .secondary)
            }

            ViewerSurface(
                media: media,
                audioMedia: audioMedia,
                nextMedia: nextMedia,
                isPlaying: isPlaying,
                syncGeneration: syncGeneration,
                audioSyncGeneration: audioSyncGeneration,
                audioMuted: audioMuted,
                audioVolume: audioVolume
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

    private var viewerSubtitle: String {
        if let media {
            return "\(media.assetID) / \(media.filename) / \(media.sourceRangeLabel)"
        }
        return project?.path.path ?? "projects/ 配下にプロジェクトがありません"
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
        HStack(spacing: 14) {
            Button(action: onStepBackward) {
                Image(systemName: "backward.end.fill")
            }
            Button(action: onTogglePlayback) {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
            }
            Button(action: onStepForward) {
                Image(systemName: "forward.end.fill")
            }
            Text(playheadLabel ?? media?.sourceRangeLabel ?? "00:00:00:00")
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(.secondary)
            Spacer()
            if let media {
                Text(media.exists ? media.resolvedFrom : "missing media")
                    .font(.caption)
                    .foregroundStyle(media.exists ? Color.secondary : Color.orange)
            }
            if let audioMedia {
                Label(audioMedia.filename, systemImage: audioMedia.exists ? "waveform" : "waveform.slash")
                    .font(.caption)
                    .foregroundStyle(audioMedia.exists ? Color.secondary : Color.orange)
                    .lineLimit(1)
            } else {
                Label("No audio", systemImage: "waveform.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Button(action: onToggleAudioMute) {
                Image(systemName: audioMuted || audioVolume <= 0 ? "speaker.slash.fill" : "speaker.wave.2.fill")
            }
            Slider(
                value: Binding(
                    get: { audioVolume },
                    set: { onAudioVolumeChange($0) }
                ),
                in: 0...1
            )
            .frame(width: 90)
            Button { } label: { Image(systemName: "slider.horizontal.3") }
        }
        .buttonStyle(.borderless)
        .controlSize(.large)
    }
}

struct ViewerSurface: View {
    var media: ProjectMediaReference?
    var audioMedia: ProjectMediaReference?
    var nextMedia: ProjectMediaReference?
    var isPlaying: Bool
    var syncGeneration: Int
    var audioSyncGeneration: Int
    var audioMuted: Bool
    var audioVolume: Double

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(.black)

            VStack(spacing: 10) {
                Image(systemName: placeholderIcon)
                    .font(.system(size: 44))
                    .foregroundStyle(.secondary)
                Text(placeholderTitle)
                    .font(.headline)
                    .foregroundStyle(.secondary)
                if let detail = placeholderDetail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
            }

            if let audioMedia, audioMedia.exists, audioMedia.canPlayAudio, let audioURL = audioMedia.url {
                MediaAudioPlayer(
                    url: audioURL,
                    startSeconds: audioMedia.sourceStartSeconds,
                    isPlaying: isPlaying,
                    syncGeneration: audioSyncGeneration,
                    isMuted: audioMuted,
                    volume: Float(audioVolume)
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var placeholderIcon: String {
        guard let media else { return "play.rectangle" }
        if media.exists, media.isPlayableVideo { return "film" }
        return media.exists ? "waveform" : "questionmark.video"
    }

    private var placeholderTitle: String {
        guard let media else { return "Select a timeline clip" }
        if media.exists, media.isPlayableVideo { return isPlaying ? "Video playback armed" : "Video preview ready" }
        return media.exists ? "Audio or unsupported preview" : "Source media missing"
    }

    private var placeholderDetail: String? {
        guard let media else { return "Choose a clip in the timeline to inspect source playback." }
        if media.exists {
            return media.url?.lastPathComponent
        }
        return media.url?.path ?? media.filename
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
        let time = CMTime(seconds: max(0, startSeconds), preferredTimescale: 600)
        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
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
