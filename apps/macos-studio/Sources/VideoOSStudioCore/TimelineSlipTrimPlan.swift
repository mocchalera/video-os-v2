import Foundation

public enum TimelineSlipTrimDirection: String, Equatable, Sendable {
    case left
    case right

    var sign: Int {
        switch self {
        case .left: return -1
        case .right: return 1
        }
    }
}

public struct TimelineSlipTrimPlan: Equatable, Sendable {
    public let direction: TimelineSlipTrimDirection
    public let clipID: TimelineClip.ID
    public let oldSourceInUS: Int
    public let oldSourceOutUS: Int
    public let newSourceInUS: Int
    public let newSourceOutUS: Int
    public let shiftFrames: Int
    public let shiftUS: Int
    public let operations: [ReviewPatchOperation]

    public static func make(
        selection: TimelineClipSelection,
        direction: TimelineSlipTrimDirection,
        deltaFrames: Int,
        assetDurationUS: Int?,
        reason: String
    ) -> TimelineSlipTrimPlan? {
        guard deltaFrames > 0 else { return nil }
        let clip = selection.clip
        guard let sourceInUS = clip.sourceInUS,
              let sourceOutUS = clip.sourceOutUS,
              sourceOutUS > sourceInUS,
              let deltaUS = sourceDeltaUS(clip: clip, frames: deltaFrames) else {
            return nil
        }

        let signedDeltaUS = direction.sign * deltaUS
        let newSourceInUS = sourceInUS + signedDeltaUS
        let newSourceOutUS = sourceOutUS + signedDeltaUS
        guard newSourceInUS >= 0, newSourceOutUS > newSourceInUS else { return nil }
        if signedDeltaUS > 0 {
            guard let assetDurationUS, newSourceOutUS <= assetDurationUS else { return nil }
        }

        return TimelineSlipTrimPlan(
            direction: direction,
            clipID: clip.id,
            oldSourceInUS: sourceInUS,
            oldSourceOutUS: sourceOutUS,
            newSourceInUS: newSourceInUS,
            newSourceOutUS: newSourceOutUS,
            shiftFrames: deltaFrames,
            shiftUS: deltaUS,
            operations: [
                .trimSegment(
                    target_clip_id: clip.id,
                    new_src_in_us: newSourceInUS,
                    new_src_out_us: newSourceOutUS,
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
