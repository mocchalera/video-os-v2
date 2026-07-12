import Foundation

public struct TimelineSourceRangeOverride: Equatable, Sendable {
    public let sourceInUS: Int
    public let sourceOutUS: Int

    public init?(sourceInUS: Int, sourceOutUS: Int) {
        guard sourceInUS >= 0, sourceOutUS > sourceInUS else {
            return nil
        }
        self.sourceInUS = sourceInUS
        self.sourceOutUS = sourceOutUS
    }
}

public enum TimelineSourceRangeMarkHandle: Equatable, Sendable {
    case inPoint
    case outPoint
}

public enum TimelineSourceRangeMarkPlan {
    public static func range(
        candidateSourceInUS: Int,
        candidateSourceOutUS: Int,
        currentSourceInUS: Int?,
        currentSourceOutUS: Int?,
        handle: TimelineSourceRangeMarkHandle,
        normalizedPosition: Double,
        minimumDurationUS: Int = 1
    ) -> TimelineSourceRangeOverride? {
        guard candidateSourceOutUS > candidateSourceInUS else { return nil }
        let minimumDurationUS = max(1, minimumDurationUS)
        guard candidateSourceOutUS - candidateSourceInUS >= minimumDurationUS else { return nil }

        let currentRange = effectiveRange(
            candidateSourceInUS: candidateSourceInUS,
            candidateSourceOutUS: candidateSourceOutUS,
            currentSourceInUS: currentSourceInUS,
            currentSourceOutUS: currentSourceOutUS,
            minimumDurationUS: minimumDurationUS
        )
        guard let currentRange else { return nil }

        let projectedUS = sourceUS(
            normalizedPosition: normalizedPosition,
            candidateSourceInUS: candidateSourceInUS,
            candidateSourceOutUS: candidateSourceOutUS
        )

        switch handle {
        case .inPoint:
            let nextInUS = max(candidateSourceInUS, min(projectedUS, currentRange.sourceOutUS - minimumDurationUS))
            return TimelineSourceRangeOverride(sourceInUS: nextInUS, sourceOutUS: currentRange.sourceOutUS)
        case .outPoint:
            let nextOutUS = min(candidateSourceOutUS, max(projectedUS, currentRange.sourceInUS + minimumDurationUS))
            return TimelineSourceRangeOverride(sourceInUS: currentRange.sourceInUS, sourceOutUS: nextOutUS)
        }
    }

    public static func effectiveRange(
        candidateSourceInUS: Int,
        candidateSourceOutUS: Int,
        currentSourceInUS: Int?,
        currentSourceOutUS: Int?,
        minimumDurationUS: Int = 1
    ) -> TimelineSourceRangeOverride? {
        guard candidateSourceOutUS > candidateSourceInUS else { return nil }
        let minimumDurationUS = max(1, minimumDurationUS)
        let sourceInUS = max(candidateSourceInUS, min(currentSourceInUS ?? candidateSourceInUS, candidateSourceOutUS - minimumDurationUS))
        let sourceOutUS = min(candidateSourceOutUS, max(currentSourceOutUS ?? candidateSourceOutUS, sourceInUS + minimumDurationUS))
        return TimelineSourceRangeOverride(sourceInUS: sourceInUS, sourceOutUS: sourceOutUS)
    }

    public static func shouldPublishRange(
        currentSourceInUS: Int?,
        currentSourceOutUS: Int?,
        nextRange: TimelineSourceRangeOverride?
    ) -> Bool {
        guard let nextRange else {
            return currentSourceInUS != nil || currentSourceOutUS != nil
        }
        return currentSourceInUS != nextRange.sourceInUS || currentSourceOutUS != nextRange.sourceOutUS
    }

    public static func fraction(
        sourceUS: Int,
        candidateSourceInUS: Int,
        candidateSourceOutUS: Int
    ) -> Double {
        guard candidateSourceOutUS > candidateSourceInUS else { return 0 }
        let clampedSourceUS = max(candidateSourceInUS, min(sourceUS, candidateSourceOutUS))
        return Double(clampedSourceUS - candidateSourceInUS) / Double(candidateSourceOutUS - candidateSourceInUS)
    }

    public static func sourceUS(
        normalizedPosition: Double,
        candidateSourceInUS: Int,
        candidateSourceOutUS: Int
    ) -> Int {
        guard candidateSourceOutUS > candidateSourceInUS else { return candidateSourceInUS }
        let clampedPosition = min(1, max(0, normalizedPosition))
        let durationUS = Double(candidateSourceOutUS - candidateSourceInUS)
        return candidateSourceInUS + Int((durationUS * clampedPosition).rounded())
    }
}

public struct TimelineSourceInsertSnap: Equatable, Sendable {
    public let kind: TimelineSourceInsertSnapKind
    public let alignment: TimelineSourceInsertSnapAlignment
    public let frame: Int
    public let distanceFrames: Int
    public let label: String
}

public enum TimelineSourceInsertSnapKind: String, Equatable, Sendable {
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

public enum TimelineSourceInsertSnapAlignment: String, Equatable, Sendable {
    case start
    case end
}

public struct TimelineSourceInsertPlan: Equatable, Sendable {
    public struct LaneLift: Equatable, Sendable {
        public let requestedTrackID: TimelineTrack.ID
        public let targetTrackID: TimelineTrack.ID
        public let createsTrack: Bool
        public let overlappedClipIDs: [TimelineClip.ID]
    }

    public let candidate: BrowserCandidate
    public let insertedClipID: TimelineClip.ID
    public let beatID: String
    public let role: String
    public let targetTrackID: TimelineTrack.ID
    public let targetKind: TimelineTrackKind
    public let laneLift: LaneLift?
    public let proposedTimelineInFrame: Int
    public let timelineInFrame: Int
    public let durationFrames: Int
    public let snap: TimelineSourceInsertSnap?
    public let operation: ReviewPatchOperation
    public let timeline: TimelineDocument

    public var changedClipIDs: [TimelineClip.ID] {
        [insertedClipID]
    }

    public static func make(
        timeline: TimelineDocument,
        dataSource: CandidateBrowserDataSource,
        sourceAssetID: String,
        playheadFrame: Int,
        reason: String,
        candidateID: BrowserCandidate.ID? = nil,
        preferredTargetTrackID: TimelineTrack.ID? = nil,
        sourceRangeOverride: TimelineSourceRangeOverride? = nil,
        snapThresholdFrames: Int = 0,
        snapPlayheadFrame: Int? = nil
    ) -> TimelineSourceInsertPlan? {
        let usedSegmentIDs = Set(timeline.displayTracks.flatMap(\.clips).map(\.segmentID))
        let candidates = insertCandidates(
            in: dataSource,
            sourceAssetID: sourceAssetID,
            usedSegmentIDs: usedSegmentIDs
        )
        let candidate = candidateID.flatMap { id in
            candidates.first { $0.id == id }
        } ?? candidates.first
        guard let candidate else {
            return nil
        }
        let sourceInUS = sourceRangeOverride?.sourceInUS ?? candidate.src_in_us
        let sourceOutUS = sourceRangeOverride?.sourceOutUS ?? candidate.src_out_us
        guard sourceInUS >= candidate.src_in_us,
              sourceOutUS <= candidate.src_out_us,
              sourceOutUS > sourceInUS else {
            return nil
        }

        let role = insertRole(for: candidate.role)
        let targetKind = targetKind(forRole: role)
        let defaultTargetTrackID = targetTrackID(forRole: role)
        guard let requestedTargetTrackID = resolvedTargetTrackID(
            in: timeline,
            preferredTargetTrackID: preferredTargetTrackID,
            defaultTargetTrackID: defaultTargetTrackID,
            targetKind: targetKind
        ) else {
            return nil
        }
        let proposedTimelineInFrame = max(0, min(playheadFrame, timeline.totalFrames))
        let durationFrames = Self.durationFrames(sourceInUS: sourceInUS, sourceOutUS: sourceOutUS, sequence: timeline.sequence)
        let snapTrack = timeline.displayTracks.first { $0.id == requestedTargetTrackID && $0.kind == targetKind }
        let snapResolution = resolveSnap(
            timeline: timeline,
            track: snapTrack,
            proposedStart: proposedTimelineInFrame,
            durationFrames: durationFrames,
            snapThresholdFrames: max(0, snapThresholdFrames),
            playheadFrame: snapPlayheadFrame
        )
        let timelineInFrame = snapResolution.start
        let targetResolution = resolveTargetForOverlap(
            in: timeline,
            requestedTargetTrackID: requestedTargetTrackID,
            targetKind: targetKind,
            timelineInFrame: timelineInFrame,
            durationFrames: durationFrames
        )
        let targetTrackID = targetResolution.targetTrackID
        let laneLift = targetResolution.laneLift
        let insertedClipID = nextClipID(in: timeline)
        let beatID = beatID(for: candidate, timeline: timeline, timelineInFrame: timelineInFrame)
        let operationTargetTrackID = targetTrackID == defaultTargetTrackID ? nil : targetTrackID
        let hasSourceRangeOverride = sourceInUS != candidate.src_in_us || sourceOutUS != candidate.src_out_us
        let operationSourceInUS = hasSourceRangeOverride ? sourceInUS : nil
        let operationSourceOutUS = hasSourceRangeOverride ? sourceOutUS : nil
        let operation = ReviewPatchOperation.insertSegment(
            beat_id: beatID,
            segment_id: candidate.segment_id,
            role: role,
            new_timeline_in_frame: timelineInFrame,
            new_duration_frames: durationFrames,
            target_track_id: operationTargetTrackID,
            new_src_in_us: operationSourceInUS,
            new_src_out_us: operationSourceOutUS,
            reason: reason
        )
        guard operation.isValidForStudioSession else { return nil }

        let clip = TimelineClip(
            id: insertedClipID,
            segmentID: candidate.segment_id,
            assetID: candidate.asset_id,
            sourceInUS: sourceInUS,
            sourceOutUS: sourceOutUS,
            timelineInFrame: timelineInFrame,
            timelineDurationFrames: durationFrames,
            role: role,
            motivation: "[studio:insert] \(candidate.why_it_matches)",
            confidence: candidate.confidence,
            beatID: beatID,
            fallbackSegmentIDs: [],
            qualityFlags: [],
            candidateRef: candidate.id
        )
        guard let updatedTimeline = timeline.insertingClip(
            clip,
            targetTrackID: targetTrackID,
            targetKind: targetKind
        ) else {
            return nil
        }

        return TimelineSourceInsertPlan(
            candidate: candidate,
            insertedClipID: insertedClipID,
            beatID: beatID,
            role: role,
            targetTrackID: targetTrackID,
            targetKind: targetKind,
            laneLift: laneLift,
            proposedTimelineInFrame: proposedTimelineInFrame,
            timelineInFrame: timelineInFrame,
            durationFrames: durationFrames,
            snap: snapResolution.snap,
            operation: operation,
            timeline: updatedTimeline
        )
    }

    public static func bestCandidate(
        in dataSource: CandidateBrowserDataSource,
        sourceAssetID: String,
        usedSegmentIDs: Set<String>
    ) -> BrowserCandidate? {
        insertCandidates(
            in: dataSource,
            sourceAssetID: sourceAssetID,
            usedSegmentIDs: usedSegmentIDs
        )
        .first
    }

    public static func insertCandidates(
        in dataSource: CandidateBrowserDataSource,
        sourceAssetID: String,
        usedSegmentIDs: Set<String>
    ) -> [BrowserCandidate] {
        dataSource.candidates
            .filter { $0.asset_id == sourceAssetID }
            .sorted { lhs, rhs in
                let lhsUsed = usedSegmentIDs.contains(lhs.segment_id)
                let rhsUsed = usedSegmentIDs.contains(rhs.segment_id)
                if lhsUsed != rhsUsed { return !lhsUsed }
                if lhs.confidence != rhs.confidence { return lhs.confidence > rhs.confidence }
                if lhs.src_in_us != rhs.src_in_us { return lhs.src_in_us < rhs.src_in_us }
                return lhs.segment_id.localizedStandardCompare(rhs.segment_id) == .orderedAscending
            }
    }

    public static func insertRole(for role: String) -> String {
        switch role {
        case "hero", "support", "transition", "texture", "dialogue", "music", "title":
            return role
        default:
            return "support"
        }
    }

    public static func targetTrackID(forRole role: String) -> TimelineTrack.ID {
        switch role {
        case "hero":
            return "V1"
        case "dialogue":
            return "A1"
        case "music":
            return "A2"
        default:
            return "V2"
        }
    }

    public static func targetKind(forRole role: String) -> TimelineTrackKind {
        switch role {
        case "dialogue", "music":
            return .audio
        default:
            return .video
        }
    }

    public static func isCompatibleTrackKind(_ trackKind: TimelineTrackKind, withRole role: String) -> Bool {
        targetKind(forRole: insertRole(for: role)) == trackKind
    }

    private static func resolvedTargetTrackID(
        in timeline: TimelineDocument,
        preferredTargetTrackID: TimelineTrack.ID?,
        defaultTargetTrackID: TimelineTrack.ID,
        targetKind: TimelineTrackKind
    ) -> TimelineTrack.ID? {
        guard let preferredTargetTrackID, !preferredTargetTrackID.isEmpty else {
            return defaultTargetTrackID
        }
        guard let targetTrack = timeline.displayTracks.first(where: { $0.id == preferredTargetTrackID }),
              targetTrack.kind == targetKind else {
            return nil
        }
        return preferredTargetTrackID
    }

    private static func resolveTargetForOverlap(
        in timeline: TimelineDocument,
        requestedTargetTrackID: TimelineTrack.ID,
        targetKind: TimelineTrackKind,
        timelineInFrame: Int,
        durationFrames: Int
    ) -> (targetTrackID: TimelineTrack.ID, laneLift: LaneLift?) {
        guard let requestedTrack = compatibleTracks(in: timeline, targetKind: targetKind)
            .first(where: { $0.id == requestedTargetTrackID })
        else {
            return (requestedTargetTrackID, nil)
        }
        let overlappedClipIDs = overlappingClipIDs(
            on: requestedTrack,
            timelineInFrame: timelineInFrame,
            durationFrames: durationFrames
        )
        guard !overlappedClipIDs.isEmpty else {
            return (requestedTargetTrackID, nil)
        }

        let tracks = compatibleTracks(in: timeline, targetKind: targetKind)
        if let openTrack = preferredLaneLiftTracks(
            tracks,
            requestedTargetTrackID: requestedTargetTrackID,
            targetKind: targetKind
        )
        .first(where: { track in
            overlappingClipIDs(
                on: track,
                timelineInFrame: timelineInFrame,
                durationFrames: durationFrames
            ).isEmpty
        }) {
            return (
                openTrack.id,
                LaneLift(
                    requestedTrackID: requestedTargetTrackID,
                    targetTrackID: openTrack.id,
                    createsTrack: false,
                    overlappedClipIDs: overlappedClipIDs
                )
            )
        }

        let newTrackID = nextTrackID(for: targetKind, existingTrackIDs: tracks.map(\.id))
        return (
            newTrackID,
            LaneLift(
                requestedTrackID: requestedTargetTrackID,
                targetTrackID: newTrackID,
                createsTrack: true,
                overlappedClipIDs: overlappedClipIDs
            )
        )
    }

    private static func resolveSnap(
        timeline: TimelineDocument,
        track: TimelineTrack?,
        proposedStart: Int,
        durationFrames: Int,
        snapThresholdFrames: Int,
        playheadFrame: Int?
    ) -> (start: Int, snap: TimelineSourceInsertSnap?) {
        guard snapThresholdFrames > 0, durationFrames > 0 else {
            return (proposedStart, nil)
        }
        let proposedEnd = proposedStart + durationFrames
        var candidates: [TimelineSourceInsertSnapCandidate] = [
            TimelineSourceInsertSnapCandidate(
                frame: 0,
                alignment: .start,
                kind: .timelineStart,
                label: "タイムライン先頭"
            )
        ]

        if let playheadFrame {
            let frame = max(0, min(playheadFrame, timeline.totalFrames))
            candidates.append(TimelineSourceInsertSnapCandidate(
                frame: frame,
                alignment: .start,
                kind: .playhead,
                label: "再生位置"
            ))
            candidates.append(TimelineSourceInsertSnapCandidate(
                frame: frame,
                alignment: .end,
                kind: .playhead,
                label: "再生位置"
            ))
        }

        for marker in timeline.markers.sorted(by: { $0.frame < $1.frame }) {
            let frame = max(0, min(marker.frame, timeline.totalFrames))
            let label = marker.label.isEmpty ? "マーカー" : marker.label
            candidates.append(TimelineSourceInsertSnapCandidate(
                frame: frame,
                alignment: .start,
                kind: .marker,
                label: label
            ))
            candidates.append(TimelineSourceInsertSnapCandidate(
                frame: frame,
                alignment: .end,
                kind: .marker,
                label: label
            ))
        }

        for other in track?.clips ?? [] where other.timelineDurationFrames > 0 {
            candidates.append(TimelineSourceInsertSnapCandidate(
                frame: other.timelineInFrame,
                alignment: .end,
                kind: .editPoint,
                label: "\(other.id) 先頭"
            ))
            candidates.append(TimelineSourceInsertSnapCandidate(
                frame: other.timelineOutFrame,
                alignment: .start,
                kind: .editPoint,
                label: "\(other.id) 末尾"
            ))
        }

        let matches = candidates.compactMap { candidate -> TimelineSourceInsertSnapMatch? in
            let movingFrame = candidate.alignment == .start ? proposedStart : proposedEnd
            let distance = abs(movingFrame - candidate.frame)
            guard distance <= snapThresholdFrames else { return nil }
            let snappedStart = candidate.alignment == .start
                ? candidate.frame
                : candidate.frame - durationFrames
            guard snappedStart >= 0 else { return nil }
            return TimelineSourceInsertSnapMatch(
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
            TimelineSourceInsertSnap(
                kind: match.candidate.kind,
                alignment: match.candidate.alignment,
                frame: match.candidate.frame,
                distanceFrames: match.distanceFrames,
                label: match.candidate.label
            )
        )
    }

    private static func preferredLaneLiftTracks(
        _ tracks: [TimelineTrack],
        requestedTargetTrackID: TimelineTrack.ID,
        targetKind: TimelineTrackKind
    ) -> [TimelineTrack] {
        let requestedIndex = trackIndex(for: requestedTargetTrackID, targetKind: targetKind)
        return tracks
            .filter { track in
                guard track.id != requestedTargetTrackID else { return false }
                guard let requestedIndex else { return true }
                guard let candidateIndex = trackIndex(for: track.id, targetKind: targetKind) else { return false }
                return candidateIndex >= requestedIndex
            }
            .sorted { lhs, rhs in
                let lhsIndex = trackIndex(for: lhs.id, targetKind: targetKind) ?? Int.max
                let rhsIndex = trackIndex(for: rhs.id, targetKind: targetKind) ?? Int.max
                if lhsIndex != rhsIndex { return lhsIndex < rhsIndex }
                return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
            }
    }

    private static func compatibleTracks(
        in timeline: TimelineDocument,
        targetKind: TimelineTrackKind
    ) -> [TimelineTrack] {
        switch targetKind {
        case .video:
            return timeline.tracks.video
        case .audio:
            return timeline.tracks.audio
        case .overlay:
            return timeline.tracks.overlay
        case .caption:
            return timeline.tracks.caption
        }
    }

    private static func overlappingClipIDs(
        on track: TimelineTrack,
        timelineInFrame: Int,
        durationFrames: Int
    ) -> [TimelineClip.ID] {
        let timelineOutFrame = timelineInFrame + durationFrames
        return track.clips
            .filter { clip in
                clip.timelineDurationFrames > 0
                    && clip.timelineInFrame < timelineOutFrame
                    && clip.timelineOutFrame > timelineInFrame
            }
            .map(\.id)
    }

    private static func trackIndex(
        for trackID: TimelineTrack.ID,
        targetKind: TimelineTrackKind
    ) -> Int? {
        let prefix: String
        switch targetKind {
        case .video:
            prefix = "V"
        case .audio:
            prefix = "A"
        case .overlay:
            prefix = "O"
        case .caption:
            prefix = "C"
        }
        guard trackID.uppercased().hasPrefix(prefix) else { return nil }
        return Int(trackID.dropFirst())
    }

    private static func nextTrackID(
        for targetKind: TimelineTrackKind,
        existingTrackIDs: [TimelineTrack.ID]
    ) -> TimelineTrack.ID {
        let prefix: String
        switch targetKind {
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

    static func durationFrames(sourceInUS: Int, sourceOutUS: Int, sequence: TimelineSequence) -> Int {
        let sourceDurationUS = max(1, sourceOutUS - sourceInUS)
        let frames = (Double(sourceDurationUS) / 1_000_000 * sequence.fps).rounded()
        return max(1, Int(frames))
    }

    static func beatID(
        for candidate: BrowserCandidate,
        timeline: TimelineDocument,
        timelineInFrame: Int
    ) -> String {
        if let selection = timeline.programSelection(atFrame: timelineInFrame),
           let beatID = selection.clip.beatID,
           !beatID.isEmpty {
            return beatID
        }
        if let beatID = candidate.eligible_beats.first(where: { !$0.isEmpty }) {
            return beatID
        }
        return "studio_insert_\(timelineInFrame)"
    }

    private static func nextClipID(in timeline: TimelineDocument) -> TimelineClip.ID {
        let maxNumber = (timeline.tracks.video + timeline.tracks.audio)
            .flatMap(\.clips)
            .compactMap { clip -> Int? in
                guard clip.id.hasPrefix("CLP_") else { return nil }
                return Int(clip.id.dropFirst(4))
            }
            .max() ?? 0
        return "CLP_\(String(format: "%04d", maxNumber + 1))"
    }
}

private struct TimelineSourceInsertSnapCandidate: Equatable {
    let frame: Int
    let alignment: TimelineSourceInsertSnapAlignment
    let kind: TimelineSourceInsertSnapKind
    let label: String
}

private struct TimelineSourceInsertSnapMatch: Equatable {
    let candidate: TimelineSourceInsertSnapCandidate
    let distanceFrames: Int
    let snappedStartFrame: Int
}
