import Foundation

public struct TimelineDragTrimPlan: Equatable, Sendable {
    public let targetClipID: TimelineClip.ID
    public let trackID: TimelineTrack.ID
    public let edge: TimelinePlayheadTrimEdge
    public let proposedBoundaryFrame: Int
    public let targetBoundaryFrame: Int
    public let snap: TimelineClipMoveSnap?
    public let removedFrames: Int
    public let addedFrames: Int
    public let durationDeltaFrames: Int
    public let changedFrames: Int
    public let newTimelineInFrame: Int
    public let newDurationFrames: Int
    public let newSourceInUS: Int
    public let newSourceOutUS: Int
    public let operations: [ReviewPatchOperation]

    public static func make(
        selection: TimelineClipSelection,
        targetBoundaryFrame: Int,
        edge: TimelinePlayheadTrimEdge,
        reason: String
    ) -> TimelineDragTrimPlan? {
        makeResolved(
            selection: selection,
            proposedBoundaryFrame: targetBoundaryFrame,
            targetBoundaryFrame: targetBoundaryFrame,
            snap: nil,
            edge: edge,
            reason: reason
        )
    }

    public static func make(
        timeline: TimelineDocument,
        selection: TimelineClipSelection,
        targetBoundaryFrame: Int,
        edge: TimelinePlayheadTrimEdge,
        snapThresholdFrames: Int,
        playheadFrame: Int,
        assetDurationUS: Int? = nil,
        reason: String
    ) -> TimelineDragTrimPlan? {
        let resolved = resolveSnap(
            timeline: timeline,
            selection: selection,
            proposedBoundaryFrame: targetBoundaryFrame,
            edge: edge,
            snapThresholdFrames: snapThresholdFrames,
            playheadFrame: playheadFrame
        )
        return makeResolved(
            selection: selection,
            proposedBoundaryFrame: targetBoundaryFrame,
            targetBoundaryFrame: resolved.boundaryFrame,
            snap: resolved.snap,
            edge: edge,
            timeline: timeline,
            assetDurationUS: assetDurationUS,
            reason: reason
        )
    }

    private static func makeResolved(
        selection: TimelineClipSelection,
        proposedBoundaryFrame: Int,
        targetBoundaryFrame: Int,
        snap: TimelineClipMoveSnap?,
        edge: TimelinePlayheadTrimEdge,
        timeline: TimelineDocument? = nil,
        assetDurationUS: Int? = nil,
        reason: String
    ) -> TimelineDragTrimPlan? {
        let clip = selection.clip
        guard let sourceInUS = clip.sourceInUS,
              let sourceOutUS = clip.sourceOutUS,
              sourceOutUS > sourceInUS,
              clip.timelineDurationFrames > 1 else { return nil }

        let oldTimelineInFrame = clip.timelineInFrame
        let oldTimelineOutFrame = clip.timelineOutFrame
        let newTimelineInFrame: Int
        let newDurationFrames: Int
        let newSourceInUS: Int
        let newSourceOutUS: Int

        switch edge {
        case .start:
            let previousOut = timeline.flatMap { adjacentBounds(in: $0, selection: selection)?.previousOut }
                ?? oldTimelineInFrame + 1
            guard targetBoundaryFrame >= previousOut,
                  targetBoundaryFrame < oldTimelineOutFrame,
                  targetBoundaryFrame != oldTimelineInFrame else { return nil }
            let frameDelta = targetBoundaryFrame - oldTimelineInFrame
            guard let sourceDeltaUS = sourceDeltaUS(clip: clip, frames: abs(frameDelta)) else { return nil }
            newTimelineInFrame = targetBoundaryFrame
            newDurationFrames = oldTimelineOutFrame - targetBoundaryFrame
            if frameDelta >= 0 {
                newSourceInUS = sourceInUS + sourceDeltaUS
            } else {
                newSourceInUS = sourceInUS - sourceDeltaUS
            }
            newSourceOutUS = sourceOutUS
            guard newSourceInUS >= 0 else { return nil }
        case .end:
            let nextIn = timeline.flatMap { adjacentBounds(in: $0, selection: selection)?.nextIn }
            guard targetBoundaryFrame > oldTimelineInFrame,
                  targetBoundaryFrame != oldTimelineOutFrame else { return nil }
            if let nextIn {
                guard targetBoundaryFrame <= nextIn else { return nil }
            } else if timeline == nil {
                guard targetBoundaryFrame < oldTimelineOutFrame else { return nil }
            }
            let frameDelta = targetBoundaryFrame - oldTimelineOutFrame
            guard let sourceDeltaUS = sourceDeltaUS(clip: clip, frames: abs(frameDelta)) else { return nil }
            newTimelineInFrame = oldTimelineInFrame
            newDurationFrames = targetBoundaryFrame - oldTimelineInFrame
            newSourceInUS = sourceInUS
            if frameDelta >= 0 {
                newSourceOutUS = sourceOutUS + sourceDeltaUS
                guard let assetDurationUS, newSourceOutUS <= assetDurationUS else { return nil }
            } else {
                newSourceOutUS = sourceOutUS - sourceDeltaUS
            }
        }

        guard newDurationFrames > 0, newSourceOutUS > newSourceInUS else { return nil }

        let durationDeltaFrames = newDurationFrames - clip.timelineDurationFrames
        let removedFrames = max(0, -durationDeltaFrames)
        let addedFrames = max(0, durationDeltaFrames)

        return TimelineDragTrimPlan(
            targetClipID: clip.id,
            trackID: selection.trackID,
            edge: edge,
            proposedBoundaryFrame: proposedBoundaryFrame,
            targetBoundaryFrame: targetBoundaryFrame,
            snap: snap,
            removedFrames: removedFrames,
            addedFrames: addedFrames,
            durationDeltaFrames: durationDeltaFrames,
            changedFrames: max(removedFrames, addedFrames),
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

    public var isExtension: Bool {
        addedFrames > 0
    }

    public var viewerPreviewFrame: Int {
        switch edge {
        case .start:
            return newTimelineInFrame
        case .end:
            return max(newTimelineInFrame, newTimelineInFrame + newDurationFrames - 1)
        }
    }

    private static func resolveSnap(
        timeline: TimelineDocument,
        selection: TimelineClipSelection,
        proposedBoundaryFrame: Int,
        edge: TimelinePlayheadTrimEdge,
        snapThresholdFrames: Int,
        playheadFrame: Int
    ) -> (boundaryFrame: Int, snap: TimelineClipMoveSnap?) {
        guard snapThresholdFrames > 0 else {
            return (proposedBoundaryFrame, nil)
        }

        let clip = selection.clip
        let boundaryAlignment: TimelineClipMoveSnapAlignment = edge == .start ? .start : .end
        let bounds = adjacentBounds(in: timeline, selection: selection)
        let lowerBound: Int
        let upperBound: Int
        switch edge {
        case .start:
            lowerBound = bounds?.previousOut ?? clip.timelineInFrame + 1
            upperBound = clip.timelineOutFrame - 1
        case .end:
            lowerBound = clip.timelineInFrame + 1
            upperBound = bounds?.nextIn ?? Int.max
        }
        var candidates: [TimelineDragTrimSnapCandidate] = [
            TimelineDragTrimSnapCandidate(
                frame: 0,
                kind: .timelineStart,
                label: "タイムライン先頭"
            ),
            TimelineDragTrimSnapCandidate(
                frame: max(0, min(playheadFrame, timeline.totalFrames)),
                kind: .playhead,
                label: "再生位置"
            )
        ]

        for marker in timeline.markers.sorted(by: { $0.frame < $1.frame }) {
            let frame = max(0, min(marker.frame, timeline.totalFrames))
            candidates.append(TimelineDragTrimSnapCandidate(
                frame: frame,
                kind: .marker,
                label: marker.label.isEmpty ? "マーカー" : marker.label
            ))
        }

        if let track = timeline.displayTracks.first(where: { $0.id == selection.trackID }) {
            for other in track.clips where other.id != clip.id {
                candidates.append(TimelineDragTrimSnapCandidate(
                    frame: other.timelineInFrame,
                    kind: .editPoint,
                    label: "\(other.id) 先頭"
                ))
                candidates.append(TimelineDragTrimSnapCandidate(
                    frame: other.timelineOutFrame,
                    kind: .editPoint,
                    label: "\(other.id) 末尾"
                ))
            }
        }

        let matches = candidates.compactMap { candidate -> TimelineDragTrimSnapMatch? in
            guard candidate.frame >= lowerBound,
                  candidate.frame <= upperBound,
                  candidate.frame != (edge == .start ? clip.timelineInFrame : clip.timelineOutFrame) else {
                return nil
            }
            let distance = abs(proposedBoundaryFrame - candidate.frame)
            guard distance <= snapThresholdFrames else { return nil }
            return TimelineDragTrimSnapMatch(candidate: candidate, distanceFrames: distance)
        }
        .sorted { lhs, rhs in
            if lhs.distanceFrames != rhs.distanceFrames {
                return lhs.distanceFrames < rhs.distanceFrames
            }
            if lhs.candidate.kind.priority != rhs.candidate.kind.priority {
                return lhs.candidate.kind.priority < rhs.candidate.kind.priority
            }
            return lhs.candidate.frame < rhs.candidate.frame
        }

        guard let match = matches.first else {
            return (proposedBoundaryFrame, nil)
        }

        return (
            match.candidate.frame,
            TimelineClipMoveSnap(
                kind: match.candidate.kind,
                alignment: boundaryAlignment,
                frame: match.candidate.frame,
                distanceFrames: match.distanceFrames,
                label: match.candidate.label
            )
        )
    }

    private static func adjacentBounds(
        in timeline: TimelineDocument,
        selection: TimelineClipSelection
    ) -> (previousOut: Int, nextIn: Int?)? {
        guard let track = timeline.displayTracks.first(where: { $0.id == selection.trackID }) else { return nil }
        let sortedClips = track.clips.sorted { lhs, rhs in
            if lhs.timelineInFrame == rhs.timelineInFrame {
                return lhs.id < rhs.id
            }
            return lhs.timelineInFrame < rhs.timelineInFrame
        }
        guard let selectedIndex = sortedClips.firstIndex(where: { $0.id == selection.clip.id }) else { return nil }
        let previousOut = selectedIndex > 0 ? sortedClips[selectedIndex - 1].timelineOutFrame : 0
        let nextIn = selectedIndex < sortedClips.count - 1 ? sortedClips[selectedIndex + 1].timelineInFrame : nil
        return (previousOut, nextIn)
    }

    private static func sourceDeltaUS(clip: TimelineClip, frames: Int) -> Int? {
        guard frames > 0,
              let sourceInUS = clip.sourceInUS,
              let sourceOutUS = clip.sourceOutUS,
              sourceOutUS > sourceInUS,
              clip.timelineDurationFrames > 0 else { return nil }
        let sourceUSPerFrame = Double(sourceOutUS - sourceInUS) / Double(clip.timelineDurationFrames)
        return max(1, Int((Double(frames) * sourceUSPerFrame).rounded()))
    }
}

private struct TimelineDragTrimSnapCandidate: Equatable {
    let frame: Int
    let kind: TimelineClipMoveSnapKind
    let label: String
}

private struct TimelineDragTrimSnapMatch: Equatable {
    let candidate: TimelineDragTrimSnapCandidate
    let distanceFrames: Int
}
