import Foundation

public struct CaptionPlaybackTickDecision: Equatable, Sendable {
    public let currentSeconds: Double
    public let restartAtSeconds: Double?
}

public enum CaptionPlaybackTickAdapter {
    public static func decision(
        seconds: Double,
        isPlaying: Bool,
        loopStartSeconds: Double,
        loopEndSeconds: Double
    ) -> CaptionPlaybackTickDecision? {
        guard seconds.isFinite else { return nil }
        guard isPlaying, seconds >= loopEndSeconds else {
            return CaptionPlaybackTickDecision(
                currentSeconds: seconds,
                restartAtSeconds: nil
            )
        }

        let restartSeconds = max(0, loopStartSeconds)
        return CaptionPlaybackTickDecision(
            currentSeconds: restartSeconds,
            restartAtSeconds: restartSeconds
        )
    }
}
