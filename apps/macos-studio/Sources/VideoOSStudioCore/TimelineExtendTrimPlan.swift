import Foundation

public enum TimelineExtendTrimEdge: String, Equatable, Sendable {
    case start
    case end
}

public struct TimelineExtendTrimPlan: Equatable, Sendable {
    public let edge: TimelineExtendTrimEdge
    public let trackID: TimelineTrack.ID
    public let clipID: TimelineClip.ID
    public let oldTimelineInFrame: Int
    public let oldDurationFrames: Int
    public let newTimelineInFrame: Int
    public let newDurationFrames: Int
    public let oldSourceInUS: Int
    public let oldSourceOutUS: Int
    public let newSourceInUS: Int
    public let newSourceOutUS: Int
    public let addedFrames: Int
    public let addedUS: Int
    public let operations: [ReviewPatchOperation]

    public static func make(
        timeline: TimelineDocument,
        selection: TimelineClipSelection,
        edge: TimelineExtendTrimEdge,
        deltaFrames: Int,
        assetDurationUS: Int?,
        reason: String
    ) -> TimelineExtendTrimPlan? {
        guard deltaFrames > 0,
              let track = timeline.displayTracks.first(where: { $0.id == selection.trackID }) else {
            return nil
        }
        let clip = selection.clip
        guard let sourceInUS = clip.sourceInUS,
              let sourceOutUS = clip.sourceOutUS,
              sourceOutUS > sourceInUS,
              let deltaUS = sourceDeltaUS(clip: clip, frames: deltaFrames) else {
            return nil
        }

        let sortedClips = track.clips.sorted { lhs, rhs in
            if lhs.timelineInFrame != rhs.timelineInFrame {
                return lhs.timelineInFrame < rhs.timelineInFrame
            }
            return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
        }
        guard let selectedIndex = sortedClips.firstIndex(where: { $0.id == clip.id }) else { return nil }

        let newTimelineInFrame: Int
        let newDurationFrames: Int
        let newSourceInUS: Int
        let newSourceOutUS: Int

        switch edge {
        case .start:
            let previousOut = selectedIndex > 0
                ? sortedClips[selectedIndex - 1].timelineOutFrame
                : 0
            let availableFrames = clip.timelineInFrame - previousOut
            guard availableFrames >= deltaFrames else { return nil }
            newTimelineInFrame = clip.timelineInFrame - deltaFrames
            newDurationFrames = clip.timelineDurationFrames + deltaFrames
            newSourceInUS = sourceInUS - deltaUS
            newSourceOutUS = sourceOutUS
            guard newTimelineInFrame >= 0, newSourceInUS >= 0 else { return nil }
        case .end:
            let nextIn = selectedIndex < sortedClips.count - 1
                ? sortedClips[selectedIndex + 1].timelineInFrame
                : nil
            if let nextIn {
                let availableFrames = nextIn - clip.timelineOutFrame
                guard availableFrames >= deltaFrames else { return nil }
            }
            newTimelineInFrame = clip.timelineInFrame
            newDurationFrames = clip.timelineDurationFrames + deltaFrames
            newSourceInUS = sourceInUS
            newSourceOutUS = sourceOutUS + deltaUS
            guard let assetDurationUS, newSourceOutUS <= assetDurationUS else { return nil }
        }

        guard newDurationFrames > clip.timelineDurationFrames,
              newSourceOutUS > newSourceInUS else {
            return nil
        }

        return TimelineExtendTrimPlan(
            edge: edge,
            trackID: selection.trackID,
            clipID: clip.id,
            oldTimelineInFrame: clip.timelineInFrame,
            oldDurationFrames: clip.timelineDurationFrames,
            newTimelineInFrame: newTimelineInFrame,
            newDurationFrames: newDurationFrames,
            oldSourceInUS: sourceInUS,
            oldSourceOutUS: sourceOutUS,
            newSourceInUS: newSourceInUS,
            newSourceOutUS: newSourceOutUS,
            addedFrames: deltaFrames,
            addedUS: deltaUS,
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

    private static func sourceDeltaUS(clip: TimelineClip, frames: Int) -> Int? {
        guard frames > 0,
              let sourceInUS = clip.sourceInUS,
              let sourceOutUS = clip.sourceOutUS,
              sourceOutUS > sourceInUS,
              clip.timelineDurationFrames > 0 else {
            return nil
        }
        let sourceUSPerFrame = Double(sourceOutUS - sourceInUS) / Double(clip.timelineDurationFrames)
        return max(1, Int((Double(frames) * sourceUSPerFrame).rounded()))
    }
}
