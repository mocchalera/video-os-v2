import Foundation

public struct TimelineSourceReplacePlan: Equatable, Sendable {
    public let candidate: BrowserCandidate
    public let targetSelection: TimelineClipSelection
    public let operation: ReviewPatchOperation
    public let timeline: TimelineDocument

    public var changedClipIDs: [TimelineClip.ID] {
        [targetSelection.clip.id]
    }

    public static func make(
        timeline: TimelineDocument,
        dataSource: CandidateBrowserDataSource,
        sourceAssetID: String,
        targetClipID: TimelineClip.ID,
        reason: String,
        candidateID: BrowserCandidate.ID? = nil,
        sourceRangeOverride: TimelineSourceRangeOverride? = nil
    ) -> TimelineSourceReplacePlan? {
        guard let targetSelection = timeline.clipSelection(for: targetClipID) else {
            return nil
        }
        let usedSegmentIDs = Set(timeline.displayTracks
            .flatMap(\.clips)
            .filter { $0.id != targetClipID }
            .map(\.segmentID))
        let candidates = TimelineSourceInsertPlan.insertCandidates(
            in: dataSource,
            sourceAssetID: sourceAssetID,
            usedSegmentIDs: usedSegmentIDs
        )
        let candidate = candidateID.flatMap { id in
            candidates.first { $0.id == id }
        } ?? candidates.first
        guard let candidate, isCompatible(candidate: candidate, with: targetSelection.trackKind) else {
            return nil
        }
        let sourceInUS = sourceRangeOverride?.sourceInUS ?? candidate.src_in_us
        let sourceOutUS = sourceRangeOverride?.sourceOutUS ?? candidate.src_out_us
        guard sourceInUS >= candidate.src_in_us,
              sourceOutUS <= candidate.src_out_us,
              sourceOutUS > sourceInUS else {
            return nil
        }

        let hasSourceRangeOverride = sourceInUS != candidate.src_in_us || sourceOutUS != candidate.src_out_us
        let operation = ReviewPatchOperation.replaceSegment(
            target_clip_id: targetSelection.clip.id,
            with_segment_id: candidate.segment_id,
            with_candidate_ref: candidate.id,
            new_src_in_us: hasSourceRangeOverride ? sourceInUS : nil,
            new_src_out_us: hasSourceRangeOverride ? sourceOutUS : nil,
            reason: reason
        )
        guard operation.isValidForStudioSession,
              let updatedTimeline = timeline.replacingClip(
                targetSelection.clip.id,
                with: candidate,
                reason: reason,
                sourceRangeOverride: sourceRangeOverride
              )
        else {
            return nil
        }

        return TimelineSourceReplacePlan(
            candidate: candidate,
            targetSelection: targetSelection,
            operation: operation,
            timeline: updatedTimeline
        )
    }

    public static func isCompatible(candidate: BrowserCandidate, with trackKind: TimelineTrackKind) -> Bool {
        let role = TimelineSourceInsertPlan.insertRole(for: candidate.role)
        let candidateKind = TimelineSourceInsertPlan.targetKind(forRole: role)
        switch (trackKind, candidateKind) {
        case (.audio, .audio):
            return true
        case (.video, .video):
            return true
        default:
            return false
        }
    }
}
