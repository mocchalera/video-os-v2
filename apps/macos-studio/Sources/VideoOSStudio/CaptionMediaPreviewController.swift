import AVFoundation
import Combine
import Foundation
import VideoOSStudioCore

@MainActor
final class CaptionMediaPreviewController: ObservableObject {
    let player = AVPlayer()

    @Published private(set) var isPlaying = false
    @Published private(set) var statusMessage = "前後プレビューを準備しています。"
    @Published private(set) var waveformPeaks: [Double] = []
    @Published private(set) var currentSeconds = 0.0
    @Published private(set) var loopStartSeconds = 0.0
    @Published private(set) var loopEndSeconds = 0.0
    @Published private(set) var captionStartSeconds = 0.0
    @Published private(set) var captionEndSeconds = 0.0

    private var currentURL: URL?
    private var timeObserver: Any?
    private var generation = 0

    init() {
        player.actionAtItemEnd = .none
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.05, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            Task { @MainActor in
                self?.handlePlaybackTime(CMTimeGetSeconds(time))
            }
        }
    }

    deinit {
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
        }
    }

    func prepare(
        projectURL: URL,
        item: CaptionReviewQueueItem,
        fps: Double,
        paddingSeconds: Double = 1.25
    ) {
        generation += 1
        let requestGeneration = generation
        pause()
        let safeFPS = max(fps, 1)
        captionStartSeconds = Double(item.timelineInFrame) / safeFPS
        captionEndSeconds = Double(item.timelineOutFrame) / safeFPS
        loopStartSeconds = max(0, captionStartSeconds - paddingSeconds)
        loopEndSeconds = captionEndSeconds + paddingSeconds
        currentSeconds = loopStartSeconds
        waveformPeaks = []

        guard let media = ProjectMediaResolver.resolveTimelinePreview(
            projectURL: projectURL,
            playheadSeconds: loopStartSeconds
        ), media.exists, let url = media.url else {
            currentURL = nil
            player.replaceCurrentItem(with: nil)
            statusMessage = "現在のタイムラインに対応するプレビュー動画がありません。"
            return
        }

        if currentURL != url {
            currentURL = url
            player.replaceCurrentItem(with: AVPlayerItem(url: url))
        }
        seek(to: loopStartSeconds)
        statusMessage = "発話前後を含む\(String(format: "%.1f", loopEndSeconds - loopStartSeconds))秒のループです。"

        let start = loopStartSeconds
        let end = loopEndSeconds
        Task { [weak self] in
            let peaks = await Task.detached(priority: .userInitiated) {
                (try? AudioWaveformExtractor.extractPeaks(
                    from: url,
                    startSeconds: start,
                    endSeconds: end,
                    sampleCount: 144
                )) ?? []
            }.value
            guard let self, self.generation == requestGeneration else { return }
            self.waveformPeaks = peaks
        }
    }

    func updateCaptionRange(startFrame: Int, endFrame: Int, fps: Double) {
        let safeFPS = max(fps, 1)
        captionStartSeconds = Double(startFrame) / safeFPS
        captionEndSeconds = Double(endFrame) / safeFPS
    }

    func togglePlayback() {
        isPlaying ? pause() : play()
    }

    func play() {
        guard player.currentItem != nil else { return }
        if currentSeconds < loopStartSeconds || currentSeconds >= loopEndSeconds {
            seek(to: loopStartSeconds)
        }
        player.play()
        isPlaying = true
    }

    func pause() {
        player.pause()
        isPlaying = false
    }

    func restartLoop() {
        seek(to: loopStartSeconds)
        play()
    }

    private func handlePlaybackTime(_ seconds: Double) {
        guard seconds.isFinite else { return }
        currentSeconds = seconds
        if isPlaying, seconds >= loopEndSeconds {
            seek(to: loopStartSeconds)
            player.play()
        }
    }

    private func seek(to seconds: Double) {
        let bounded = max(0, seconds)
        player.seek(
            to: CMTime(seconds: bounded, preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        )
        currentSeconds = bounded
    }
}
