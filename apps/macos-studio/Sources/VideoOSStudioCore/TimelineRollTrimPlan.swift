import Foundation

public enum TimelineRollTrimBoundary: String, Equatable, Sendable {
    case incoming
    case outgoing
}

public enum TimelineRollTrimDirection: String, Equatable, Sendable {
    case left
    case right

    var sign: Int {
        switch self {
        case .left: return -1
        case .right: return 1
        }
    }
}

public struct TimelineRollTrimPlan: Equatable, Sendable {
    public let boundary: TimelineRollTrimBoundary
    public let direction: TimelineRollTrimDirection
    public let trackID: TimelineTrack.ID
    public let leftClipID: TimelineClip.ID
    public let rightClipID: TimelineClip.ID
    public let oldBoundaryFrame: Int
    public let newBoundaryFrame: Int
    public let shiftFrames: Int
    public let operations: [ReviewPatchOperation]

    public var affectedClipIDs: [TimelineClip.ID] {
        [leftClipID, rightClipID]
    }

    public static func make(
        timeline: TimelineDocument,
        selection: TimelineClipSelection,
        boundary: TimelineRollTrimBoundary,
        direction: TimelineRollTrimDirection,
        deltaFrames: Int,
        assetDurationsUSByID: [String: Int],
        reason: String
    ) -> TimelineRollTrimPlan? {
        guard deltaFrames > 0 else { return nil }
        guard let track = timeline.displayTracks.first(where: { $0.id == selection.trackID }) else { return nil }
        let clips = track.clips.sorted { lhs, rhs in
            if lhs.timelineInFrame != rhs.timelineInFrame {
                return lhs.timelineInFrame < rhs.timelineInFrame
            }
            return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
        }
        guard let selectedIndex = clips.firstIndex(where: { $0.id == selection.clip.id }) else { return nil }

        let left: TimelineClip
        let right: TimelineClip
        switch boundary {
        case .incoming:
            guard selectedIndex > 0 else { return nil }
            left = clips[selectedIndex - 1]
            right = clips[selectedIndex]
        case .outgoing:
            guard selectedIndex < clips.count - 1 else { return nil }
            left = clips[selectedIndex]
            right = clips[selectedIndex + 1]
        }

        guard left.timelineOutFrame == right.timelineInFrame else { return nil }
        let oldBoundary = left.timelineOutFrame
        let signedDeltaFrames = direction.sign * deltaFrames
        let newBoundary = oldBoundary + signedDeltaFrames
        guard newBoundary > left.timelineInFrame,
              newBoundary < right.timelineOutFrame else {
            return nil
        }

        guard let leftSource = rolledLeftSource(
            clip: left,
            signedDeltaFrames: signedDeltaFrames,
            assetDurationUS: assetDurationsUSByID[left.assetID]
        ),
              let rightSource = rolledRightSource(
                clip: right,
                signedDeltaFrames: signedDeltaFrames
              ) else {
            return nil
        }

        let leftDurationFrames = newBoundary - left.timelineInFrame
        let rightDurationFrames = right.timelineOutFrame - newBoundary
        guard leftDurationFrames > 0, rightDurationFrames > 0 else { return nil }

        return TimelineRollTrimPlan(
            boundary: boundary,
            direction: direction,
            trackID: selection.trackID,
            leftClipID: left.id,
            rightClipID: right.id,
            oldBoundaryFrame: oldBoundary,
            newBoundaryFrame: newBoundary,
            shiftFrames: deltaFrames,
            operations: [
                .trimSegment(
                    target_clip_id: left.id,
                    new_src_in_us: leftSource.sourceInUS,
                    new_src_out_us: leftSource.sourceOutUS,
                    reason: "\(reason) left clip"
                ),
                .moveSegment(
                    target_clip_id: left.id,
                    new_timeline_in_frame: left.timelineInFrame,
                    new_duration_frames: leftDurationFrames,
                    target_track_id: nil,
                    reason: "\(reason) left clip"
                ),
                .trimSegment(
                    target_clip_id: right.id,
                    new_src_in_us: rightSource.sourceInUS,
                    new_src_out_us: rightSource.sourceOutUS,
                    reason: "\(reason) right clip"
                ),
                .moveSegment(
                    target_clip_id: right.id,
                    new_timeline_in_frame: newBoundary,
                    new_duration_frames: rightDurationFrames,
                    target_track_id: nil,
                    reason: "\(reason) right clip"
                )
            ]
        )
    }

    private static func rolledLeftSource(
        clip: TimelineClip,
        signedDeltaFrames: Int,
        assetDurationUS: Int?
    ) -> (sourceInUS: Int, sourceOutUS: Int)? {
        guard let sourceInUS = clip.sourceInUS,
              let sourceOutUS = clip.sourceOutUS,
              sourceOutUS > sourceInUS,
              let deltaUS = sourceDeltaUS(clip: clip, frames: abs(signedDeltaFrames)) else {
            return nil
        }
        let signedDeltaUS = signedDeltaFrames < 0 ? -deltaUS : deltaUS
        let newSourceOutUS = sourceOutUS + signedDeltaUS
        guard newSourceOutUS > sourceInUS else { return nil }
        if newSourceOutUS > sourceOutUS {
            guard let assetDurationUS, newSourceOutUS <= assetDurationUS else { return nil }
        }
        return (sourceInUS, newSourceOutUS)
    }

    private static func rolledRightSource(
        clip: TimelineClip,
        signedDeltaFrames: Int
    ) -> (sourceInUS: Int, sourceOutUS: Int)? {
        guard let sourceInUS = clip.sourceInUS,
              let sourceOutUS = clip.sourceOutUS,
              sourceOutUS > sourceInUS,
              let deltaUS = sourceDeltaUS(clip: clip, frames: abs(signedDeltaFrames)) else {
            return nil
        }
        let signedDeltaUS = signedDeltaFrames < 0 ? -deltaUS : deltaUS
        let newSourceInUS = sourceInUS + signedDeltaUS
        guard newSourceInUS >= 0, sourceOutUS > newSourceInUS else { return nil }
        return (newSourceInUS, sourceOutUS)
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
