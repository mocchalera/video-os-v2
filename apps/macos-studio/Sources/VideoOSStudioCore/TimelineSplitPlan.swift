import Foundation

public struct TimelineSplitPlan: Equatable, Sendable {
    public let targetClipID: TimelineClip.ID
    public let trackID: TimelineTrack.ID
    public let playheadFrame: Int
    public let leftDurationFrames: Int
    public let rightDurationFrames: Int
    public let splitSourceUS: Int
    public let operations: [ReviewPatchOperation]

    public static func nextClipID(in timeline: TimelineDocument) -> TimelineClip.ID {
        let maxNumber = (timeline.tracks.video + timeline.tracks.audio)
            .flatMap(\.clips)
            .compactMap { clip -> Int? in
                guard clip.id.hasPrefix("CLP_") else { return nil }
                return Int(clip.id.dropFirst(4))
            }
            .max() ?? 0
        return "CLP_\(String(format: "%04d", maxNumber + 1))"
    }

    public static func make(
        selection: TimelineClipSelection,
        playheadFrame: Int,
        reason: String
    ) -> TimelineSplitPlan? {
        let clip = selection.clip
        guard clip.timelineDurationFrames > 1 else { return nil }
        guard clip.timelineInFrame < playheadFrame,
              playheadFrame < clip.timelineOutFrame else { return nil }
        guard let sourceInUS = clip.sourceInUS,
              let sourceOutUS = clip.sourceOutUS,
              sourceOutUS > sourceInUS,
              let splitSourceUS = clip.sourceTimeUS(atTimelineFrame: playheadFrame),
              sourceInUS < splitSourceUS,
              splitSourceUS < sourceOutUS else {
            return nil
        }

        let leftDurationFrames = playheadFrame - clip.timelineInFrame
        let rightDurationFrames = clip.timelineOutFrame - playheadFrame
        guard leftDurationFrames > 0, rightDurationFrames > 0 else { return nil }

        return TimelineSplitPlan(
            targetClipID: clip.id,
            trackID: selection.trackID,
            playheadFrame: playheadFrame,
            leftDurationFrames: leftDurationFrames,
            rightDurationFrames: rightDurationFrames,
            splitSourceUS: splitSourceUS,
            operations: [
                .splitSegment(
                    target_clip_id: clip.id,
                    split_timeline_frame: playheadFrame,
                    reason: reason
                )
            ]
        )
    }
}
