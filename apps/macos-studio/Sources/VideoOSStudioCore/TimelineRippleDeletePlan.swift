import Foundation

public struct TimelineRippleDeletePlan: Equatable, Sendable {
    public let deletedClipID: TimelineClip.ID
    public let trackID: TimelineTrack.ID
    public let shiftFrames: Int
    public let movedClipIDs: [TimelineClip.ID]
    public let operations: [ReviewPatchOperation]

    public static func make(
        timeline: TimelineDocument,
        selection: TimelineClipSelection,
        reason: String
    ) -> TimelineRippleDeletePlan? {
        let clip = selection.clip
        guard clip.timelineDurationFrames > 0 else { return nil }
        guard let track = timeline.displayTracks.first(where: { $0.id == selection.trackID }) else { return nil }

        let followingClips = track.clips
            .filter { $0.id != clip.id && $0.timelineInFrame >= clip.timelineOutFrame }
            .sorted { lhs, rhs in
                if lhs.timelineInFrame != rhs.timelineInFrame {
                    return lhs.timelineInFrame < rhs.timelineInFrame
                }
                return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
            }

        var operations: [ReviewPatchOperation] = [
            .removeSegment(target_clip_id: clip.id, reason: reason)
        ]
        var movedClipIDs: [TimelineClip.ID] = []

        for following in followingClips {
            let newFrame = max(clip.timelineInFrame, following.timelineInFrame - clip.timelineDurationFrames)
            guard newFrame != following.timelineInFrame else { continue }
            operations.append(.moveSegment(
                target_clip_id: following.id,
                new_timeline_in_frame: newFrame,
                new_duration_frames: nil,
                target_track_id: nil,
                reason: "Ripple delete after \(clip.id)"
            ))
            movedClipIDs.append(following.id)
        }

        return TimelineRippleDeletePlan(
            deletedClipID: clip.id,
            trackID: selection.trackID,
            shiftFrames: clip.timelineDurationFrames,
            movedClipIDs: movedClipIDs,
            operations: operations
        )
    }
}

public struct TimelineRippleDeleteGroupPlan: Equatable, Sendable {
    public let deletedClipIDs: [TimelineClip.ID]
    public let trackID: TimelineTrack.ID
    public let trackIDs: [TimelineTrack.ID]
    public let shiftFrames: Int
    public let rangeInFrame: Int
    public let rangeOutFrame: Int
    public let movedClipIDs: [TimelineClip.ID]
    public let operations: [ReviewPatchOperation]

    public var isCrossTrackRipple: Bool {
        trackIDs.count > 1
    }

    public static func make(
        timeline: TimelineDocument,
        clipIDs: Set<TimelineClip.ID>,
        reason: String
    ) -> TimelineRippleDeleteGroupPlan? {
        guard !clipIDs.isEmpty else { return nil }

        let matchingTracks = timeline.displayTracks.compactMap { track -> (track: TimelineTrack, clips: [TimelineClip])? in
            let clips = track.clips.filter { clipIDs.contains($0.id) }
            return clips.isEmpty ? nil : (track, clips)
        }
        guard !matchingTracks.isEmpty else { return nil }
        guard matchingTracks.reduce(0, { $0 + $1.clips.count }) == clipIDs.count else { return nil }

        if matchingTracks.count > 1 {
            return makeCrossTrack(
                matchingTracks: matchingTracks,
                reason: reason
            )
        }

        guard let match = matchingTracks.first else { return nil }

        let selectedClips = match.clips.sorted { lhs, rhs in
            if lhs.timelineInFrame != rhs.timelineInFrame {
                return lhs.timelineInFrame < rhs.timelineInFrame
            }
            return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
        }
        guard selectedClips.allSatisfy({ $0.timelineDurationFrames > 0 }) else { return nil }

        let selectedIDs = Set(selectedClips.map(\.id))
        let remainingClips = match.track.clips
            .filter { !selectedIDs.contains($0.id) }
            .sorted { lhs, rhs in
                if lhs.timelineInFrame != rhs.timelineInFrame {
                    return lhs.timelineInFrame < rhs.timelineInFrame
                }
                return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
            }

        let hasUnsafeOverlap = remainingClips.contains { remaining in
            selectedClips.contains { selected in
                remaining.timelineInFrame < selected.timelineOutFrame
                    && remaining.timelineOutFrame > selected.timelineInFrame
            }
        }
        guard !hasUnsafeOverlap else { return nil }

        let deletedClipIDs = selectedClips.map(\.id)
        let deletedLabel = deletedClipIDs.joined(separator: ",")
        let shiftFrames = selectedClips.reduce(0) { $0 + $1.timelineDurationFrames }
        var operations: [ReviewPatchOperation] = deletedClipIDs.map {
            .removeSegment(target_clip_id: $0, reason: reason)
        }
        var movedClipIDs: [TimelineClip.ID] = []

        for clip in remainingClips {
            let shiftBeforeClip = selectedClips.reduce(0) { total, selected in
                selected.timelineOutFrame <= clip.timelineInFrame
                    ? total + selected.timelineDurationFrames
                    : total
            }
            guard shiftBeforeClip > 0 else { continue }
            let newFrame = max(0, clip.timelineInFrame - shiftBeforeClip)
            guard newFrame != clip.timelineInFrame else { continue }
            operations.append(.moveSegment(
                target_clip_id: clip.id,
                new_timeline_in_frame: newFrame,
                new_duration_frames: nil,
                target_track_id: nil,
                reason: "Ripple delete after \(deletedLabel)"
            ))
            movedClipIDs.append(clip.id)
        }

        return TimelineRippleDeleteGroupPlan(
            deletedClipIDs: deletedClipIDs,
            trackID: match.track.id,
            trackIDs: [match.track.id],
            shiftFrames: shiftFrames,
            rangeInFrame: selectedClips.map(\.timelineInFrame).min() ?? 0,
            rangeOutFrame: selectedClips.map(\.timelineOutFrame).max() ?? 0,
            movedClipIDs: movedClipIDs,
            operations: operations
        )
    }

    private static func makeCrossTrack(
        matchingTracks: [(track: TimelineTrack, clips: [TimelineClip])],
        reason: String
    ) -> TimelineRippleDeleteGroupPlan? {
        let selectedClips = matchingTracks.flatMap(\.clips)
        guard selectedClips.allSatisfy({ $0.timelineDurationFrames > 0 }),
              let rangeInFrame = selectedClips.map(\.timelineInFrame).min(),
              let rangeOutFrame = selectedClips.map(\.timelineOutFrame).max(),
              rangeOutFrame > rangeInFrame else {
            return nil
        }

        let selectedIDs = Set(selectedClips.map(\.id))
        for match in matchingTracks {
            let selectedOnTrack = match.clips.sorted(by: compareByTimelineThenID)
            guard coversRange(selectedOnTrack, from: rangeInFrame, to: rangeOutFrame) else {
                return nil
            }
            let remaining = match.track.clips.filter { !selectedIDs.contains($0.id) }
            let hasUnsafeOverlap = remaining.contains { remainingClip in
                remainingClip.timelineInFrame < rangeOutFrame && remainingClip.timelineOutFrame > rangeInFrame
            }
            guard !hasUnsafeOverlap else { return nil }
        }

        let sortedSelections = matchingTracks
            .flatMap { match in match.clips.map { (trackID: match.track.id, clip: $0) } }
            .sorted { lhs, rhs in
                let lhsTrackIndex = matchingTracks.firstIndex { $0.track.id == lhs.trackID } ?? Int.max
                let rhsTrackIndex = matchingTracks.firstIndex { $0.track.id == rhs.trackID } ?? Int.max
                if lhsTrackIndex != rhsTrackIndex { return lhsTrackIndex < rhsTrackIndex }
                return compareByTimelineThenID(lhs.clip, rhs.clip)
            }

        let deletedClipIDs = sortedSelections.map { $0.clip.id }
        let trackIDs = matchingTracks.map { $0.track.id }
        let shiftFrames = rangeOutFrame - rangeInFrame
        var operations: [ReviewPatchOperation] = deletedClipIDs.map {
            .removeSegment(target_clip_id: $0, reason: reason)
        }
        var movedClipIDs: [TimelineClip.ID] = []

        for match in matchingTracks {
            let followingClips = match.track.clips
                .filter { !selectedIDs.contains($0.id) && $0.timelineInFrame >= rangeOutFrame }
                .sorted(by: compareByTimelineThenID)
            for following in followingClips {
                let newFrame = max(rangeInFrame, following.timelineInFrame - shiftFrames)
                guard newFrame != following.timelineInFrame else { continue }
                operations.append(.moveSegment(
                    target_clip_id: following.id,
                    new_timeline_in_frame: newFrame,
                    new_duration_frames: nil,
                    target_track_id: nil,
                    reason: "Cross-track ripple delete \(rangeInFrame)-\(rangeOutFrame)"
                ))
                movedClipIDs.append(following.id)
            }
        }

        return TimelineRippleDeleteGroupPlan(
            deletedClipIDs: deletedClipIDs,
            trackID: trackIDs[0],
            trackIDs: trackIDs,
            shiftFrames: shiftFrames,
            rangeInFrame: rangeInFrame,
            rangeOutFrame: rangeOutFrame,
            movedClipIDs: movedClipIDs,
            operations: operations
        )
    }

    private static func coversRange(_ clips: [TimelineClip], from rangeInFrame: Int, to rangeOutFrame: Int) -> Bool {
        var cursor = rangeInFrame
        for clip in clips.sorted(by: compareByTimelineThenID) {
            guard clip.timelineInFrame == cursor else { return false }
            cursor = clip.timelineOutFrame
        }
        return cursor == rangeOutFrame
    }

    private static func compareByTimelineThenID(_ lhs: TimelineClip, _ rhs: TimelineClip) -> Bool {
        if lhs.timelineInFrame != rhs.timelineInFrame {
            return lhs.timelineInFrame < rhs.timelineInFrame
        }
        return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
    }
}

public struct TimelineLiftDeletePlan: Equatable, Sendable {
    public let deletedClipIDs: [TimelineClip.ID]
    public let trackIDs: [TimelineTrack.ID]
    public let operations: [ReviewPatchOperation]

    public static func make(
        timeline: TimelineDocument,
        clipIDs: Set<TimelineClip.ID>,
        reason: String
    ) -> TimelineLiftDeletePlan? {
        guard !clipIDs.isEmpty else { return nil }

        let tracksByOrder = Dictionary(uniqueKeysWithValues: timeline.displayTracks.enumerated().map { index, track in
            (track.id, index)
        })
        let selections = clipIDs.compactMap { timeline.clipSelection(for: $0) }
        guard selections.count == clipIDs.count else { return nil }

        let sortedSelections = selections.sorted { lhs, rhs in
            let lhsTrackOrder = tracksByOrder[lhs.trackID] ?? Int.max
            let rhsTrackOrder = tracksByOrder[rhs.trackID] ?? Int.max
            if lhsTrackOrder != rhsTrackOrder { return lhsTrackOrder < rhsTrackOrder }
            if lhs.clip.timelineInFrame != rhs.clip.timelineInFrame {
                return lhs.clip.timelineInFrame < rhs.clip.timelineInFrame
            }
            return lhs.clip.id.localizedStandardCompare(rhs.clip.id) == .orderedAscending
        }

        let deletedClipIDs = sortedSelections.map { $0.clip.id }
        let trackIDs = sortedSelections.map(\.trackID).reduce(into: [TimelineTrack.ID]()) { result, trackID in
            guard !result.contains(trackID) else { return }
            result.append(trackID)
        }
        let operations = deletedClipIDs.map {
            ReviewPatchOperation.removeSegment(target_clip_id: $0, reason: reason)
        }

        return TimelineLiftDeletePlan(
            deletedClipIDs: deletedClipIDs,
            trackIDs: trackIDs,
            operations: operations
        )
    }
}
