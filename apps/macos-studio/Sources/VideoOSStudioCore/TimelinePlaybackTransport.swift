import Foundation

public enum TimelinePlaybackDirection: String, Equatable, Sendable {
    case forward
    case reverse
}

public enum TimelinePlaybackShuttle {
    public static let maximumSpeed: Double = 4

    public static func nextSpeed(
        isPlaying: Bool,
        currentDirection: TimelinePlaybackDirection,
        currentSpeed: Double,
        requestedDirection: TimelinePlaybackDirection
    ) -> Double {
        guard isPlaying, currentDirection == requestedDirection else { return 1 }
        let next = max(currentSpeed, 1) * 2
        return next > maximumSpeed ? 1 : next
    }

    public static func signedRate(
        isPlaying: Bool,
        direction: TimelinePlaybackDirection,
        speed: Double
    ) -> Double {
        guard isPlaying else { return 0 }
        let rate = max(speed, 0)
        return direction == .reverse ? -rate : rate
    }
}

public enum TimelinePlaybackTransportPublishing {
    public static func clampedSpeed(_ speed: Double) -> Double {
        max(1, min(speed, TimelinePlaybackShuttle.maximumSpeed))
    }

    public static func shouldPublishDirection(
        previous: TimelinePlaybackDirection,
        next: TimelinePlaybackDirection
    ) -> Bool {
        previous != next
    }

    public static func shouldPublishSpeed(
        previous: Double,
        next: Double
    ) -> Bool {
        previous != next
    }

    public static func shouldPublishPlaying(
        previous: Bool,
        next: Bool
    ) -> Bool {
        previous != next
    }
}

public struct TimelinePlaybackRange: Equatable, Sendable {
    public let startFrame: Int
    public let endFrame: Int

    public init?(startFrame: Int, endFrame: Int) {
        guard startFrame >= 0, endFrame > startFrame else { return nil }
        self.startFrame = startFrame
        self.endFrame = endFrame
    }

    public var durationFrames: Int {
        endFrame - startFrame
    }

    public func contains(_ frame: Int) -> Bool {
        startFrame <= frame && frame < endFrame
    }
}

public enum TimelinePlaybackLoop {
    public static func range(covering clips: [TimelineClip]) -> TimelinePlaybackRange? {
        let validClips = clips.filter { $0.timelineDurationFrames > 0 }
        guard !validClips.isEmpty else { return nil }
        let startFrame = validClips.map(\.timelineInFrame).min() ?? 0
        let endFrame = validClips.map(\.timelineOutFrame).max() ?? 0
        return TimelinePlaybackRange(startFrame: startFrame, endFrame: endFrame)
    }

    public static func transitionReviewRange(
        timeline: TimelineDocument,
        transition: TimelineTransition
    ) -> TimelinePlaybackRange? {
        guard transition.isVisibleTimelineTransition,
              let transitionFrames = transition.transitionFrames,
              transitionFrames > 0,
              let track = timeline.displayTracks.first(where: { $0.id == transition.trackID }),
              let fromClip = track.clips.first(where: { $0.id == transition.fromClipID }),
              let toClip = track.clips.first(where: { $0.id == transition.toClipID }),
              fromClip.timelineOutFrame == toClip.timelineInFrame
        else {
            return nil
        }
        let boundaryFrame = fromClip.timelineOutFrame
        let startFrame = max(fromClip.timelineInFrame, boundaryFrame - transitionFrames)
        let endFrame = min(toClip.timelineOutFrame, boundaryFrame + transitionFrames)
        return TimelinePlaybackRange(startFrame: startFrame, endFrame: endFrame)
    }

    public static func normalizedRange(_ range: TimelinePlaybackRange?, totalFrames: Int) -> TimelinePlaybackRange? {
        guard let range, totalFrames > 0 else { return nil }
        let startFrame = max(0, min(range.startFrame, totalFrames))
        let endFrame = max(0, min(range.endFrame, totalFrames))
        return TimelinePlaybackRange(startFrame: startFrame, endFrame: endFrame)
    }

    public static func preparedStartFrame(
        currentFrame: Int,
        direction: TimelinePlaybackDirection,
        range: TimelinePlaybackRange
    ) -> Int {
        switch direction {
        case .forward:
            return range.contains(currentFrame) ? currentFrame : range.startFrame
        case .reverse:
            if range.contains(currentFrame) {
                return currentFrame == range.startFrame ? range.endFrame - 1 : currentFrame
            }
            return range.endFrame - 1
        }
    }

    public static func loopedFrame(
        proposedFrame: Int,
        direction: TimelinePlaybackDirection,
        range: TimelinePlaybackRange
    ) -> Int? {
        let duration = max(range.durationFrames, 1)
        switch direction {
        case .forward:
            guard proposedFrame >= range.endFrame else { return nil }
            return range.startFrame + ((proposedFrame - range.endFrame) % duration)
        case .reverse:
            guard proposedFrame < range.startFrame else { return nil }
            return range.endFrame - 1 - ((range.startFrame - proposedFrame - 1) % duration)
        }
    }
}

public enum TimelinePlaybackLoopPublishing {
    public static func shouldPublishRange(
        previous: TimelinePlaybackRange?,
        next: TimelinePlaybackRange?
    ) -> Bool {
        previous != next
    }

    public static func shouldPublishEnabled(
        previous: Bool,
        next: Bool
    ) -> Bool {
        previous != next
    }
}
