import Foundation

public struct TimelineClipMovePlan: Equatable, Sendable {
    public let targetClipID: TimelineClip.ID
    public let trackID: TimelineTrack.ID
    public let originalTimelineInFrame: Int
    public let proposedTimelineInFrame: Int
    public let newTimelineInFrame: Int
    public let durationFrames: Int
    public let targetTrackID: TimelineTrack.ID
    public let laneLift: TimelineClipMoveLaneLift?
    public let snap: TimelineClipMoveSnap?
    public let displacements: [TimelineClipMoveDisplacement]
    public let operations: [ReviewPatchOperation]

    public static func make(
        timeline: TimelineDocument,
        selection: TimelineClipSelection,
        frameDelta: Int,
        snapThresholdFrames: Int,
        playheadFrame: Int,
        reason: String,
        preferredTargetTrackID: TimelineTrack.ID? = nil
    ) -> TimelineClipMovePlan? {
        let clip = selection.clip
        let explicitTrackMoveID = preferredTargetTrackID.flatMap { $0 == selection.trackID ? nil : $0 }
        guard (frameDelta != 0 || explicitTrackMoveID != nil), clip.timelineDurationFrames > 0 else { return nil }
        guard let track = timeline.displayTracks.first(where: { $0.id == selection.trackID }) else { return nil }
        let explicitTargetTrack = explicitTrackMoveID.flatMap {
            compatibleTrack(in: timeline, sourceTrack: track, targetTrackID: $0)
        }
        guard explicitTrackMoveID == nil || explicitTargetTrack != nil else { return nil }

        let proposedStart = max(0, clip.timelineInFrame + frameDelta)
        let snapTrack = explicitTargetTrack ?? track
        let resolved = resolveSnap(
            timeline: timeline,
            track: snapTrack,
            clip: clip,
            proposedStart: proposedStart,
            snapThresholdFrames: max(0, snapThresholdFrames),
            playheadFrame: playheadFrame
        )
        let newStart = resolved.start
        let explicitLaneLift: TimelineClipMoveLaneLift?
        let explicitTargetTrackID: TimelineTrack.ID?
        if let explicitTargetTrack {
            if hasOverlap(
                on: explicitTargetTrack,
                movingClipID: clip.id,
                movingStart: newStart,
                movingDurationFrames: clip.timelineDurationFrames
            ) {
                guard let lift = makeLaneLift(
                    timeline: timeline,
                    sourceTrack: track,
                    requestedTargetTrack: explicitTargetTrack,
                    movingClipID: clip.id,
                    movingStart: newStart,
                    movingDurationFrames: clip.timelineDurationFrames
                ) else { return nil }
                explicitLaneLift = lift
                explicitTargetTrackID = lift.targetTrackID
            } else {
                explicitLaneLift = nil
                explicitTargetTrackID = explicitTargetTrack.id
            }
        } else {
            explicitLaneLift = nil
            explicitTargetTrackID = nil
        }
        let laneLift = explicitLaneLift ?? (explicitTargetTrack == nil ? makeLaneLift(
            timeline: timeline,
            sourceTrack: track,
            movingClipID: clip.id,
            movingStart: newStart,
            movingDurationFrames: clip.timelineDurationFrames
        ) : nil)
        let targetTrackID = explicitTargetTrackID ?? laneLift?.targetTrackID ?? selection.trackID
        guard newStart >= 0, newStart != clip.timelineInFrame || targetTrackID != selection.trackID else { return nil }
        let displacements = laneLift == nil && explicitTargetTrack == nil ? makeDisplacements(
            on: track,
            movingClipID: clip.id,
            movingStart: newStart,
            movingDurationFrames: clip.timelineDurationFrames
        ) : []
        let operationTargetTrackID = targetTrackID == selection.trackID ? nil : targetTrackID
        let operations = [
            ReviewPatchOperation.moveSegment(
                target_clip_id: clip.id,
                new_timeline_in_frame: newStart,
                new_duration_frames: nil,
                target_track_id: operationTargetTrackID,
                reason: reason
            )
        ] + displacements.map { displacement in
            ReviewPatchOperation.moveSegment(
                target_clip_id: displacement.clipID,
                new_timeline_in_frame: displacement.newTimelineInFrame,
                new_duration_frames: nil,
                target_track_id: nil,
                reason: "\(reason) magnetic displacement"
            )
        }

        return TimelineClipMovePlan(
            targetClipID: clip.id,
            trackID: selection.trackID,
            originalTimelineInFrame: clip.timelineInFrame,
            proposedTimelineInFrame: proposedStart,
            newTimelineInFrame: newStart,
            durationFrames: clip.timelineDurationFrames,
            targetTrackID: targetTrackID,
            laneLift: laneLift,
            snap: resolved.snap,
            displacements: displacements,
            operations: operations
        )
    }

    private static func compatibleTrack(
        in timeline: TimelineDocument,
        sourceTrack: TimelineTrack,
        targetTrackID: TimelineTrack.ID
    ) -> TimelineTrack? {
        let candidates: [TimelineTrack]
        switch sourceTrack.kind {
        case .video:
            candidates = timeline.tracks.video
        case .audio:
            candidates = timeline.tracks.audio
        case .overlay:
            candidates = timeline.tracks.overlay
        case .caption:
            candidates = timeline.tracks.caption
        }
        return candidates.first { $0.id == targetTrackID && $0.kind == sourceTrack.kind }
    }

    fileprivate static func resolveSnap(
        timeline: TimelineDocument,
        track: TimelineTrack,
        clip: TimelineClip,
        proposedStart: Int,
        snapThresholdFrames: Int,
        playheadFrame: Int,
        ignoredClipIDs: Set<TimelineClip.ID> = []
    ) -> (start: Int, snap: TimelineClipMoveSnap?) {
        guard snapThresholdFrames > 0 else {
            return (proposedStart, nil)
        }
        let proposedEnd = proposedStart + clip.timelineDurationFrames
        var candidates: [TimelineClipMoveSnapCandidate] = [
            TimelineClipMoveSnapCandidate(
                frame: 0,
                alignment: .start,
                kind: .timelineStart,
                label: "タイムライン先頭"
            ),
            TimelineClipMoveSnapCandidate(
                frame: max(0, min(playheadFrame, timeline.totalFrames)),
                alignment: .start,
                kind: .playhead,
                label: "再生位置"
            ),
            TimelineClipMoveSnapCandidate(
                frame: max(0, min(playheadFrame, timeline.totalFrames)),
                alignment: .end,
                kind: .playhead,
                label: "再生位置"
            )
        ]

        for marker in timeline.markers.sorted(by: { $0.frame < $1.frame }) {
            let frame = max(0, min(marker.frame, timeline.totalFrames))
            let label = marker.label.isEmpty ? "マーカー" : marker.label
            candidates.append(TimelineClipMoveSnapCandidate(
                frame: frame,
                alignment: .start,
                kind: .marker,
                label: label
            ))
            candidates.append(TimelineClipMoveSnapCandidate(
                frame: frame,
                alignment: .end,
                kind: .marker,
                label: label
            ))
        }

        for other in track.clips where other.id != clip.id && !ignoredClipIDs.contains(other.id) {
            candidates.append(TimelineClipMoveSnapCandidate(
                frame: other.timelineInFrame,
                alignment: .end,
                kind: .editPoint,
                label: "\(other.id) 先頭"
            ))
            candidates.append(TimelineClipMoveSnapCandidate(
                frame: other.timelineOutFrame,
                alignment: .start,
                kind: .editPoint,
                label: "\(other.id) 末尾"
            ))
        }

        let matches = candidates.compactMap { candidate -> TimelineClipMoveSnapMatch? in
            let movingFrame = candidate.alignment == .start ? proposedStart : proposedEnd
            let distance = abs(movingFrame - candidate.frame)
            guard distance <= snapThresholdFrames else { return nil }
            let snappedStart = candidate.alignment == .start
                ? candidate.frame
                : candidate.frame - clip.timelineDurationFrames
            guard snappedStart >= 0 else { return nil }
            return TimelineClipMoveSnapMatch(
                candidate: candidate,
                distanceFrames: distance,
                snappedStartFrame: snappedStart
            )
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
            return (proposedStart, nil)
        }

        return (
            match.snappedStartFrame,
            TimelineClipMoveSnap(
                kind: match.candidate.kind,
                alignment: match.candidate.alignment,
                frame: match.candidate.frame,
                distanceFrames: match.distanceFrames,
                label: match.candidate.label
            )
        )
    }

    private static func makeDisplacements(
        on track: TimelineTrack,
        movingClipID: TimelineClip.ID,
        movingStart: Int,
        movingDurationFrames: Int
    ) -> [TimelineClipMoveDisplacement] {
        var cursor = movingStart + movingDurationFrames
        var displacements: [TimelineClipMoveDisplacement] = []
        let candidates = track.clips
            .filter { $0.id != movingClipID && $0.timelineOutFrame > movingStart }
            .sorted { lhs, rhs in
                if lhs.timelineInFrame == rhs.timelineInFrame {
                    return lhs.id < rhs.id
                }
                return lhs.timelineInFrame < rhs.timelineInFrame
            }

        for clip in candidates {
            guard clip.timelineDurationFrames > 0 else { continue }
            guard clip.timelineInFrame < cursor else { break }
            displacements.append(TimelineClipMoveDisplacement(
                clipID: clip.id,
                originalTimelineInFrame: clip.timelineInFrame,
                newTimelineInFrame: cursor,
                durationFrames: clip.timelineDurationFrames
            ))
            cursor += clip.timelineDurationFrames
        }

        return displacements
    }

    private static func makeLaneLift(
        timeline: TimelineDocument,
        sourceTrack: TimelineTrack,
        movingClipID: TimelineClip.ID,
        movingStart: Int,
        movingDurationFrames: Int
    ) -> TimelineClipMoveLaneLift? {
        guard sourceTrack.kind == .video || sourceTrack.kind == .audio || sourceTrack.kind == .overlay else { return nil }
        let overlappedClipIDs = overlappingClips(
            on: sourceTrack,
            movingClipID: movingClipID,
            movingStart: movingStart,
            movingDurationFrames: movingDurationFrames
        ).map(\.id)
        guard !overlappedClipIDs.isEmpty else { return nil }

        let compatibleTracks: [TimelineTrack]
        switch sourceTrack.kind {
        case .video:
            compatibleTracks = timeline.tracks.video
        case .audio:
            compatibleTracks = timeline.tracks.audio
        case .overlay:
            compatibleTracks = timeline.tracks.overlay
        case .caption:
            compatibleTracks = timeline.tracks.caption
        }
        if let openTrack = compatibleTracks.first(where: { candidate in
            candidate.id != sourceTrack.id
                && !hasOverlap(
                    on: candidate,
                    movingClipID: movingClipID,
                    movingStart: movingStart,
                    movingDurationFrames: movingDurationFrames
                )
        }) {
            return TimelineClipMoveLaneLift(
                sourceTrackID: sourceTrack.id,
                targetTrackID: openTrack.id,
                createsTrack: false,
                overlappedClipIDs: overlappedClipIDs
            )
        }

        return TimelineClipMoveLaneLift(
            sourceTrackID: sourceTrack.id,
            targetTrackID: nextTrackID(for: sourceTrack.kind, existingTrackIDs: compatibleTracks.map(\.id)),
            createsTrack: true,
            overlappedClipIDs: overlappedClipIDs
        )
    }

    private static func makeLaneLift(
        timeline: TimelineDocument,
        sourceTrack: TimelineTrack,
        requestedTargetTrack: TimelineTrack,
        movingClipID: TimelineClip.ID,
        movingStart: Int,
        movingDurationFrames: Int
    ) -> TimelineClipMoveLaneLift? {
        guard sourceTrack.kind == .video || sourceTrack.kind == .audio || sourceTrack.kind == .overlay else { return nil }
        let overlappedClipIDs = overlappingClips(
            on: requestedTargetTrack,
            movingClipID: movingClipID,
            movingStart: movingStart,
            movingDurationFrames: movingDurationFrames
        ).map(\.id)
        guard !overlappedClipIDs.isEmpty else { return nil }

        let compatibleTracks: [TimelineTrack]
        switch sourceTrack.kind {
        case .video:
            compatibleTracks = timeline.tracks.video
        case .audio:
            compatibleTracks = timeline.tracks.audio
        case .overlay:
            compatibleTracks = timeline.tracks.overlay
        case .caption:
            compatibleTracks = timeline.tracks.caption
        }
        if let openTrack = compatibleTracks.first(where: { candidate in
            candidate.id != sourceTrack.id
                && candidate.id != requestedTargetTrack.id
                && !hasOverlap(
                    on: candidate,
                    movingClipID: movingClipID,
                    movingStart: movingStart,
                    movingDurationFrames: movingDurationFrames
                )
        }) {
            return TimelineClipMoveLaneLift(
                sourceTrackID: sourceTrack.id,
                targetTrackID: openTrack.id,
                createsTrack: false,
                overlappedClipIDs: overlappedClipIDs
            )
        }

        return TimelineClipMoveLaneLift(
            sourceTrackID: sourceTrack.id,
            targetTrackID: nextTrackID(for: sourceTrack.kind, existingTrackIDs: compatibleTracks.map(\.id)),
            createsTrack: true,
            overlappedClipIDs: overlappedClipIDs
        )
    }

    private static func overlappingClips(
        on track: TimelineTrack,
        movingClipID: TimelineClip.ID,
        movingStart: Int,
        movingDurationFrames: Int
    ) -> [TimelineClip] {
        let movingEnd = movingStart + movingDurationFrames
        return track.clips.filter { clip in
            guard clip.id != movingClipID, clip.timelineDurationFrames > 0 else { return false }
            return clip.timelineInFrame < movingEnd && clip.timelineOutFrame > movingStart
        }
    }

    private static func hasOverlap(
        on track: TimelineTrack,
        movingClipID: TimelineClip.ID,
        movingStart: Int,
        movingDurationFrames: Int
    ) -> Bool {
        !overlappingClips(
            on: track,
            movingClipID: movingClipID,
            movingStart: movingStart,
            movingDurationFrames: movingDurationFrames
        ).isEmpty
    }

    private static func nextTrackID(for trackKind: TimelineTrackKind, existingTrackIDs: [TimelineTrack.ID]) -> TimelineTrack.ID {
        let prefix: String
        switch trackKind {
        case .video:
            prefix = "V"
        case .audio:
            prefix = "A"
        case .overlay:
            prefix = "O"
        case .caption:
            prefix = "C"
        }
        let maxIndex = existingTrackIDs.compactMap { id -> Int? in
            guard id.uppercased().hasPrefix(prefix) else { return nil }
            return Int(id.dropFirst())
        }.max() ?? 0
        return "\(prefix)\(maxIndex + 1)"
    }
}

public struct TimelineClipGroupMovePlan: Equatable, Sendable {
    public let targetClipID: TimelineClip.ID
    public let movedClipIDs: [TimelineClip.ID]
    public let resolvedFrameDelta: Int
    public let originalTimelineInFrames: [TimelineClip.ID: Int]
    public let newTimelineInFrames: [TimelineClip.ID: Int]
    public let sourceTrackID: TimelineTrack.ID?
    public let targetTrackID: TimelineTrack.ID?
    public let laneLift: TimelineClipMoveLaneLift?
    public let snap: TimelineClipMoveSnap?
    public let displacements: [TimelineClipMoveDisplacement]
    public let operations: [ReviewPatchOperation]

    public static func make(
        timeline: TimelineDocument,
        anchorSelection: TimelineClipSelection,
        selectedClipIDs: Set<TimelineClip.ID>,
        frameDelta: Int,
        snapThresholdFrames: Int,
        playheadFrame: Int,
        reason: String,
        preferredTargetTrackID: TimelineTrack.ID? = nil
    ) -> TimelineClipGroupMovePlan? {
        let explicitTargetTrackID = preferredTargetTrackID.flatMap { $0 == anchorSelection.trackID ? nil : $0 }
        guard (frameDelta != 0 || explicitTargetTrackID != nil),
              selectedClipIDs.contains(anchorSelection.clip.id)
        else { return nil }
        let selections = sortedSelections(
            in: timeline,
            matching: selectedClipIDs
        )
        guard selections.count > 1 else { return nil }
        guard let anchorTrack = timeline.displayTracks.first(where: { $0.id == anchorSelection.trackID }) else {
            return nil
        }
        let explicitTargetTrack = explicitTargetTrackID.flatMap {
            compatibleTrack(in: timeline, sourceTrack: anchorTrack, targetTrackID: $0)
        }
        guard explicitTargetTrackID == nil || explicitTargetTrack != nil else { return nil }
        if explicitTargetTrackID != nil {
            guard selections.allSatisfy({ $0.trackID == anchorSelection.trackID }) else { return nil }
        }
        guard selections.contains(where: { $0.clip.id == anchorSelection.clip.id }) else { return nil }
        guard selections.allSatisfy({ $0.clip.timelineDurationFrames > 0 }) else { return nil }

        let proposedAnchorStart = max(0, anchorSelection.clip.timelineInFrame + frameDelta)
        let snapTrack = explicitTargetTrack ?? anchorTrack
        let resolvedAnchor = TimelineClipMovePlan.resolveSnap(
            timeline: timeline,
            track: snapTrack,
            clip: anchorSelection.clip,
            proposedStart: proposedAnchorStart,
            snapThresholdFrames: max(0, snapThresholdFrames),
            playheadFrame: playheadFrame,
            ignoredClipIDs: selectedClipIDs.subtracting([anchorSelection.clip.id])
        )
        let resolvedFrameDelta = resolvedAnchor.start - anchorSelection.clip.timelineInFrame
        guard resolvedFrameDelta != 0 || explicitTargetTrackID != nil else { return nil }

        var originalTimelineInFrames: [TimelineClip.ID: Int] = [:]
        var newTimelineInFrames: [TimelineClip.ID: Int] = [:]
        for selection in selections {
            let clip = selection.clip
            let newStart = clip.timelineInFrame + resolvedFrameDelta
            guard newStart >= 0 else { return nil }
            originalTimelineInFrames[clip.id] = clip.timelineInFrame
            newTimelineInFrames[clip.id] = newStart
        }

        let movedClipIDs = selections.map(\.clip.id)
        let movedIDSet = Set(movedClipIDs)
        let laneLift: TimelineClipMoveLaneLift?
        let targetTrackID: TimelineTrack.ID?
        let displacements: [TimelineClipMoveDisplacement]
        if let explicitTargetTrack {
            if hasOverlap(
                on: explicitTargetTrack,
                movingSelections: selections,
                newTimelineInFrames: newTimelineInFrames
            ) {
                guard let lift = makeLaneLift(
                    timeline: timeline,
                    sourceTrack: anchorTrack,
                    requestedTargetTrack: explicitTargetTrack,
                    movingSelections: selections,
                    newTimelineInFrames: newTimelineInFrames
                ) else { return nil }
                laneLift = lift
                targetTrackID = lift.targetTrackID
            } else {
                laneLift = nil
                targetTrackID = explicitTargetTrack.id
            }
            displacements = []
        } else if selections.allSatisfy({ $0.trackID == anchorSelection.trackID }),
                  let lift = makeLaneLift(
                    timeline: timeline,
                    sourceTrack: anchorTrack,
                    requestedTargetTrack: anchorTrack,
                    movingSelections: selections,
                    newTimelineInFrames: newTimelineInFrames
                  ) {
            laneLift = lift
            targetTrackID = lift.targetTrackID
            displacements = []
        } else {
            laneLift = nil
            targetTrackID = nil
            displacements = makeDisplacements(
                timeline: timeline,
                selectedClipIDs: movedIDSet,
                newTimelineInFrames: newTimelineInFrames
            )
        }
        let moveOperations = selections.map { selection in
            ReviewPatchOperation.moveSegment(
                target_clip_id: selection.clip.id,
                new_timeline_in_frame: newTimelineInFrames[selection.clip.id] ?? selection.clip.timelineInFrame,
                new_duration_frames: nil,
                target_track_id: targetTrackID,
                reason: reason
            )
        }
        let displacementOperations = displacements.map { displacement in
            ReviewPatchOperation.moveSegment(
                target_clip_id: displacement.clipID,
                new_timeline_in_frame: displacement.newTimelineInFrame,
                new_duration_frames: nil,
                target_track_id: nil,
                reason: "\(reason) magnetic group displacement"
            )
        }

        return TimelineClipGroupMovePlan(
            targetClipID: anchorSelection.clip.id,
            movedClipIDs: movedClipIDs,
            resolvedFrameDelta: resolvedFrameDelta,
            originalTimelineInFrames: originalTimelineInFrames,
            newTimelineInFrames: newTimelineInFrames,
            sourceTrackID: targetTrackID == nil ? nil : anchorSelection.trackID,
            targetTrackID: targetTrackID,
            laneLift: laneLift,
            snap: resolvedAnchor.snap,
            displacements: displacements,
            operations: moveOperations + displacementOperations
        )
    }

    public func newTimelineInFrame(for clipID: TimelineClip.ID) -> Int? {
        newTimelineInFrames[clipID]
    }

    private static func sortedSelections(
        in timeline: TimelineDocument,
        matching selectedClipIDs: Set<TimelineClip.ID>
    ) -> [TimelineClipSelection] {
        var selections: [TimelineClipSelection] = []
        for track in timeline.displayTracks {
            for clip in track.clips.sorted(by: sortClips) where selectedClipIDs.contains(clip.id) {
                selections.append(TimelineClipSelection(trackID: track.id, trackKind: track.kind, clip: clip))
            }
        }
        return selections
    }

    private static func compatibleTrack(
        in timeline: TimelineDocument,
        sourceTrack: TimelineTrack,
        targetTrackID: TimelineTrack.ID
    ) -> TimelineTrack? {
        let candidates: [TimelineTrack]
        switch sourceTrack.kind {
        case .video:
            candidates = timeline.tracks.video
        case .audio:
            candidates = timeline.tracks.audio
        case .overlay:
            candidates = timeline.tracks.overlay
        case .caption:
            candidates = timeline.tracks.caption
        }
        return candidates.first { $0.id == targetTrackID && $0.kind == sourceTrack.kind }
    }

    private static func makeLaneLift(
        timeline: TimelineDocument,
        sourceTrack: TimelineTrack,
        requestedTargetTrack: TimelineTrack,
        movingSelections: [TimelineClipSelection],
        newTimelineInFrames: [TimelineClip.ID: Int]
    ) -> TimelineClipMoveLaneLift? {
        guard sourceTrack.kind == .video || sourceTrack.kind == .audio || sourceTrack.kind == .overlay else { return nil }
        let overlappedClipIDs = overlappingClips(
            on: requestedTargetTrack,
            movingSelections: movingSelections,
            newTimelineInFrames: newTimelineInFrames
        ).map(\.id)
        guard !overlappedClipIDs.isEmpty else { return nil }

        let compatibleTracks: [TimelineTrack]
        switch sourceTrack.kind {
        case .video:
            compatibleTracks = timeline.tracks.video
        case .audio:
            compatibleTracks = timeline.tracks.audio
        case .overlay:
            compatibleTracks = timeline.tracks.overlay
        case .caption:
            compatibleTracks = timeline.tracks.caption
        }
        if let openTrack = compatibleTracks.first(where: { candidate in
            candidate.id != sourceTrack.id
                && candidate.id != requestedTargetTrack.id
                && !hasOverlap(
                    on: candidate,
                    movingSelections: movingSelections,
                    newTimelineInFrames: newTimelineInFrames
                )
        }) {
            return TimelineClipMoveLaneLift(
                sourceTrackID: sourceTrack.id,
                targetTrackID: openTrack.id,
                createsTrack: false,
                overlappedClipIDs: overlappedClipIDs
            )
        }

        return TimelineClipMoveLaneLift(
            sourceTrackID: sourceTrack.id,
            targetTrackID: nextTrackID(for: sourceTrack.kind, existingTrackIDs: compatibleTracks.map(\.id)),
            createsTrack: true,
            overlappedClipIDs: overlappedClipIDs
        )
    }

    private static func hasOverlap(
        on track: TimelineTrack,
        movingSelections: [TimelineClipSelection],
        newTimelineInFrames: [TimelineClip.ID: Int]
    ) -> Bool {
        let movingClipIDs = Set(movingSelections.map(\.clip.id))
        let movingIntervals = movingSelections.compactMap { selection -> TimelineClipMoveInterval? in
            let clip = selection.clip
            guard let newStart = newTimelineInFrames[clip.id],
                  clip.timelineDurationFrames > 0
            else { return nil }
            return TimelineClipMoveInterval(
                clipID: clip.id,
                start: newStart,
                durationFrames: clip.timelineDurationFrames
            )
        }
        let targetIntervals = track.clips.compactMap { clip -> TimelineClipMoveInterval? in
            guard !movingClipIDs.contains(clip.id), clip.timelineDurationFrames > 0 else { return nil }
            return TimelineClipMoveInterval(
                clipID: clip.id,
                start: clip.timelineInFrame,
                durationFrames: clip.timelineDurationFrames
            )
        }

        return movingIntervals.contains { moving in
            targetIntervals.contains { target in
                moving.start < target.end && moving.end > target.start
            }
        }
    }

    private static func overlappingClips(
        on track: TimelineTrack,
        movingSelections: [TimelineClipSelection],
        newTimelineInFrames: [TimelineClip.ID: Int]
    ) -> [TimelineClip] {
        let movingClipIDs = Set(movingSelections.map(\.clip.id))
        let movingIntervals = movingSelections.compactMap { selection -> TimelineClipMoveInterval? in
            let clip = selection.clip
            guard let newStart = newTimelineInFrames[clip.id],
                  clip.timelineDurationFrames > 0
            else { return nil }
            return TimelineClipMoveInterval(
                clipID: clip.id,
                start: newStart,
                durationFrames: clip.timelineDurationFrames
            )
        }
        return track.clips.filter { clip in
            guard !movingClipIDs.contains(clip.id), clip.timelineDurationFrames > 0 else { return false }
            return movingIntervals.contains { moving in
                moving.start < clip.timelineOutFrame && moving.end > clip.timelineInFrame
            }
        }
    }

    private static func makeDisplacements(
        timeline: TimelineDocument,
        selectedClipIDs: Set<TimelineClip.ID>,
        newTimelineInFrames: [TimelineClip.ID: Int]
    ) -> [TimelineClipMoveDisplacement] {
        timeline.displayTracks.flatMap { track in
            makeDisplacements(
                on: track,
                selectedClipIDs: selectedClipIDs,
                newTimelineInFrames: newTimelineInFrames
            )
        }
    }

    private static func makeDisplacements(
        on track: TimelineTrack,
        selectedClipIDs: Set<TimelineClip.ID>,
        newTimelineInFrames: [TimelineClip.ID: Int]
    ) -> [TimelineClipMoveDisplacement] {
        var occupiedIntervals = track.clips.compactMap { clip -> TimelineClipMoveInterval? in
            guard selectedClipIDs.contains(clip.id),
                  let newStart = newTimelineInFrames[clip.id],
                  clip.timelineDurationFrames > 0 else { return nil }
            return TimelineClipMoveInterval(
                clipID: clip.id,
                start: newStart,
                durationFrames: clip.timelineDurationFrames
            )
        }
        guard let earliestMovingStart = occupiedIntervals.map(\.start).min() else { return [] }

        var displacements: [TimelineClipMoveDisplacement] = []
        let candidates = track.clips
            .filter { !selectedClipIDs.contains($0.id) && $0.timelineDurationFrames > 0 && $0.timelineOutFrame > earliestMovingStart }
            .sorted(by: sortClips)

        for clip in candidates {
            var newStart = clip.timelineInFrame
            while let overlapEnd = overlapEnd(forStart: newStart, durationFrames: clip.timelineDurationFrames, in: occupiedIntervals) {
                newStart = max(newStart, overlapEnd)
            }
            if newStart != clip.timelineInFrame {
                displacements.append(TimelineClipMoveDisplacement(
                    clipID: clip.id,
                    originalTimelineInFrame: clip.timelineInFrame,
                    newTimelineInFrame: newStart,
                    durationFrames: clip.timelineDurationFrames
                ))
            }
            occupiedIntervals.append(TimelineClipMoveInterval(
                clipID: clip.id,
                start: newStart,
                durationFrames: clip.timelineDurationFrames
            ))
        }

        return displacements
    }

    private static func overlapEnd(
        forStart start: Int,
        durationFrames: Int,
        in intervals: [TimelineClipMoveInterval]
    ) -> Int? {
        let end = start + durationFrames
        let overlappingEnds = intervals.compactMap { interval -> Int? in
            guard start < interval.end && end > interval.start else { return nil }
            return interval.end
        }
        return overlappingEnds.max()
    }

    private static func nextTrackID(for trackKind: TimelineTrackKind, existingTrackIDs: [TimelineTrack.ID]) -> TimelineTrack.ID {
        let prefix: String
        switch trackKind {
        case .video:
            prefix = "V"
        case .audio:
            prefix = "A"
        case .overlay:
            prefix = "O"
        case .caption:
            prefix = "C"
        }
        let maxIndex = existingTrackIDs.compactMap { id -> Int? in
            guard id.uppercased().hasPrefix(prefix) else { return nil }
            return Int(id.dropFirst())
        }.max() ?? 0
        return "\(prefix)\(maxIndex + 1)"
    }

    private static func sortClips(_ lhs: TimelineClip, _ rhs: TimelineClip) -> Bool {
        if lhs.timelineInFrame == rhs.timelineInFrame {
            return lhs.id < rhs.id
        }
        return lhs.timelineInFrame < rhs.timelineInFrame
    }
}

public struct TimelineClipMoveDisplacement: Equatable, Sendable {
    public let clipID: TimelineClip.ID
    public let originalTimelineInFrame: Int
    public let newTimelineInFrame: Int
    public let durationFrames: Int
}

public struct TimelineClipMoveLaneLift: Equatable, Sendable {
    public let sourceTrackID: TimelineTrack.ID
    public let targetTrackID: TimelineTrack.ID
    public let createsTrack: Bool
    public let overlappedClipIDs: [TimelineClip.ID]
}

public struct TimelineClipMoveSnap: Equatable, Sendable {
    public let kind: TimelineClipMoveSnapKind
    public let alignment: TimelineClipMoveSnapAlignment
    public let frame: Int
    public let distanceFrames: Int
    public let label: String
}

public enum TimelineClipMoveSnapKind: String, Equatable, Sendable {
    case timelineStart
    case playhead
    case marker
    case editPoint

    var priority: Int {
        switch self {
        case .editPoint: return 0
        case .playhead: return 1
        case .marker: return 2
        case .timelineStart: return 3
        }
    }
}

public enum TimelineClipMoveSnapAlignment: String, Equatable, Sendable {
    case start
    case end
}

private struct TimelineClipMoveSnapCandidate: Equatable {
    let frame: Int
    let alignment: TimelineClipMoveSnapAlignment
    let kind: TimelineClipMoveSnapKind
    let label: String
}

private struct TimelineClipMoveSnapMatch: Equatable {
    let candidate: TimelineClipMoveSnapCandidate
    let distanceFrames: Int
    let snappedStartFrame: Int
}

private struct TimelineClipMoveInterval: Equatable {
    let clipID: TimelineClip.ID
    let start: Int
    let durationFrames: Int

    var end: Int {
        start + durationFrames
    }
}
