import AVFoundation
import Combine
import Foundation
import VideoOSStudioCore

@MainActor
final class CaptionMediaPreviewController: ObservableObject {
    enum Readiness { case loading, ready, failed }
    let player = AVPlayer()

    @Published private(set) var isPlaying = false
    @Published private(set) var statusMessage = "前後プレビューを準備しています。"
    @Published private(set) var waveformPeaks: [Double] = []
    @Published private(set) var currentSeconds = 0.0
    @Published private(set) var loopStartSeconds = 0.0
    @Published private(set) var loopEndSeconds = 0.0
    @Published private(set) var captionStartSeconds = 0.0
    @Published private(set) var captionEndSeconds = 0.0
    @Published private(set) var readiness: Readiness = .loading
    @Published private(set) var canRetry = true

    private var currentURL: URL?
    private var timeObserver: Any?
    private var generation = 0
    private var retryRequest: (projectURL: URL, item: CaptionReviewQueueItem, fps: Double, padding: Double)?

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
        retryRequest = (projectURL, item, fps, paddingSeconds)
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
        readiness = .loading
        canRetry = true

        guard let media = ProjectMediaResolver.resolveTimelinePreview(
            projectURL: projectURL,
            playheadSeconds: loopStartSeconds
        ), media.exists, let url = media.url else {
            currentURL = nil
            player.replaceCurrentItem(with: nil)
            let failure = ProjectMediaResolver.timelinePreviewFailure(projectURL: projectURL)
            statusMessage = failure.message
            canRetry = failure.retryable
            readiness = .failed
            return
        }

        let playerItem: AVPlayerItem
        if currentURL != url || player.currentItem == nil {
            currentURL = url
            playerItem = AVPlayerItem(url: url)
            player.replaceCurrentItem(with: playerItem)
        } else {
            playerItem = player.currentItem!
        }
        statusMessage = "プレビュー動画の準備完了を待っています。"
        Task { [weak self] in
            do {
                let playable = try await playerItem.asset.load(.isPlayable)
                guard playable else { throw PreviewReadinessError.notPlayable }
                // Large local media can need several seconds for first decode.
                // Generation checks make reselection cancel this wait logically.
                for _ in 0..<750 {
                    guard let self, self.generation == requestGeneration else { return }
                    switch playerItem.status {
                    case .readyToPlay:
                        let seekCompleted = await self.seekForPreparation(to: self.loopStartSeconds)
                        guard self.generation == requestGeneration else { return }
                        guard seekCompleted else { throw PreviewReadinessError.seekFailed }
                        self.readiness = .ready
                        self.statusMessage = "発話前後を含む\(String(format: "%.1f", self.loopEndSeconds - self.loopStartSeconds))秒のループです。"
                        return
                    case .failed:
                        throw playerItem.error ?? PreviewReadinessError.notPlayable
                    case .unknown:
                        try await Task.sleep(nanoseconds: 20_000_000)
                    @unknown default:
                        throw PreviewReadinessError.notPlayable
                    }
                }
                throw PreviewReadinessError.timeout
            } catch {
                guard let self, self.generation == requestGeneration else { return }
                self.readiness = .failed
                self.canRetry = true
                self.statusMessage = "プレビュー準備に失敗しました: \(error.localizedDescription)"
            }
        }

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
        guard player.currentItem != nil, readiness == .ready else { return }
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

    func retry() {
        guard let request = retryRequest else { return }
        currentURL = nil
        prepare(projectURL: request.projectURL, item: request.item, fps: request.fps, paddingSeconds: request.padding)
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

    private func seekForPreparation(to seconds: Double) async -> Bool {
        let bounded = max(0, seconds)
        let completed = await withCheckedContinuation { continuation in
            player.seek(
                to: CMTime(seconds: bounded, preferredTimescale: 600),
                toleranceBefore: .zero,
                toleranceAfter: .zero
            ) { finished in
                continuation.resume(returning: finished)
            }
        }
        if completed { currentSeconds = bounded }
        return completed
    }
}

private enum PreviewReadinessError: LocalizedError {
    case notPlayable
    case seekFailed
    case timeout
    var errorDescription: String? {
        switch self {
        case .notPlayable: return "動画を再生できません"
        case .seekFailed: return "開始位置へ移動できません"
        case .timeout: return "player準備がタイムアウトしました"
        }
    }
}
