import Foundation

public enum TimelinePlayheadTrimEdge: String, Equatable, Sendable {
    case start
    case end
}

public struct TimelinePlayheadTrimPlan: Equatable, Sendable {
    public let targetClipID: TimelineClip.ID
    public let trackID: TimelineTrack.ID
    public let edge: TimelinePlayheadTrimEdge
    public let playheadFrame: Int
    public let removedFrames: Int
    public let newTimelineInFrame: Int
    public let newDurationFrames: Int
    public let newSourceInUS: Int
    public let newSourceOutUS: Int
    public let operations: [ReviewPatchOperation]

    public static func make(
        selection: TimelineClipSelection,
        playheadFrame: Int,
        edge: TimelinePlayheadTrimEdge,
        reason: String
    ) -> TimelinePlayheadTrimPlan? {
        let clip = selection.clip
        guard clip.timelineDurationFrames > 1 else { return nil }
        guard clip.timelineInFrame < playheadFrame,
              playheadFrame < clip.timelineOutFrame else { return nil }
        guard let originalSourceInUS = clip.sourceInUS,
              let originalSourceOutUS = clip.sourceOutUS,
              originalSourceOutUS > originalSourceInUS,
              let sourceAtPlayheadUS = clip.sourceTimeUS(atTimelineFrame: playheadFrame) else {
            return nil
        }

        let newTimelineInFrame: Int
        let newDurationFrames: Int
        let newSourceInUS: Int
        let newSourceOutUS: Int
        let removedFrames: Int

        switch edge {
        case .start:
            newTimelineInFrame = playheadFrame
            newDurationFrames = clip.timelineOutFrame - playheadFrame
            newSourceInUS = sourceAtPlayheadUS
            newSourceOutUS = originalSourceOutUS
            removedFrames = playheadFrame - clip.timelineInFrame
            guard newDurationFrames > 0, newSourceOutUS > newSourceInUS else { return nil }
        case .end:
            newTimelineInFrame = clip.timelineInFrame
            newDurationFrames = playheadFrame - clip.timelineInFrame
            newSourceInUS = originalSourceInUS
            newSourceOutUS = sourceAtPlayheadUS
            removedFrames = clip.timelineOutFrame - playheadFrame
            guard newDurationFrames > 0, newSourceOutUS > newSourceInUS else { return nil }
        }

        return TimelinePlayheadTrimPlan(
            targetClipID: clip.id,
            trackID: selection.trackID,
            edge: edge,
            playheadFrame: playheadFrame,
            removedFrames: removedFrames,
            newTimelineInFrame: newTimelineInFrame,
            newDurationFrames: newDurationFrames,
            newSourceInUS: newSourceInUS,
            newSourceOutUS: newSourceOutUS,
            operations: [
                .trimSegment(
                    target_clip_id: clip.id,
                    new_src_in_us: newSourceInUS,
                    new_src_out_us: newSourceOutUS,
                    reason: reason
                ),
                .moveSegment(
                    target_clip_id: clip.id,
                    new_timeline_in_frame: newTimelineInFrame,
                    new_duration_frames: newDurationFrames,
                    target_track_id: nil,
                    reason: reason
                )
            ]
        )
    }
}
