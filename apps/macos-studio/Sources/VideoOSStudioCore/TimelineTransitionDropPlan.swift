import Foundation

public enum TimelineTransitionPreset: String, CaseIterable, Identifiable, Equatable, Sendable {
    case crossfade
    case dipToBlack = "dip_to_black"
    case matchCutSoft = "match_cut_soft"

    public static var defaultPreset: TimelineTransitionPreset { .crossfade }

    public var id: String { rawValue }

    public var isDefaultPreset: Bool {
        self == Self.defaultPreset
    }

    public var localizedLabel: String {
        switch self {
        case .crossfade: return "クロスフェード"
        case .dipToBlack: return "黒へディップ"
        case .matchCutSoft: return "ソフトカット"
        }
    }

    public var transitionType: String {
        switch self {
        case .crossfade: return "crossfade"
        case .dipToBlack: return "fade_to_black"
        case .matchCutSoft: return "match_cut"
        }
    }

    public var defaultFrames: Int {
        switch self {
        case .crossfade: return 12
        case .dipToBlack: return 18
        case .matchCutSoft: return 8
        }
    }

    public var appliedSkillID: String {
        switch self {
        case .crossfade: return "ui.crossfade_bridge"
        case .dipToBlack: return "ui.dip_to_black"
        case .matchCutSoft: return "ui.match_cut_soft"
        }
    }
}

public struct TimelineTransitionDropPlan: Equatable, Sendable {
    public let trackID: TimelineTrack.ID
    public let fromClipID: TimelineClip.ID
    public let toClipID: TimelineClip.ID
    public let boundaryFrame: Int
    public let preset: TimelineTransitionPreset
    public let transitionFrames: Int
    public let operations: [ReviewPatchOperation]

    public static func make(
        timeline: TimelineDocument,
        trackID: TimelineTrack.ID,
        fromClipID: TimelineClip.ID,
        toClipID: TimelineClip.ID,
        preset: TimelineTransitionPreset,
        reason: String
    ) -> TimelineTransitionDropPlan? {
        guard let track = timeline.displayTracks.first(where: { $0.id == trackID }) else { return nil }
        guard track.kind == .video || track.kind == .overlay else { return nil }
        guard let fromClip = track.clips.first(where: { $0.id == fromClipID }),
              let toClip = track.clips.first(where: { $0.id == toClipID }) else {
            return nil
        }
        guard fromClip.timelineOutFrame == toClip.timelineInFrame else { return nil }

        let handles = min(fromClip.timelineDurationFrames, toClip.timelineDurationFrames)
        guard handles > 0 else { return nil }
        let transitionFrames = min(preset.defaultFrames, handles)

        return TimelineTransitionDropPlan(
            trackID: trackID,
            fromClipID: fromClipID,
            toClipID: toClipID,
            boundaryFrame: fromClip.timelineOutFrame,
            preset: preset,
            transitionFrames: transitionFrames,
            operations: [
                .setTransition(
                    from_clip_id: fromClipID,
                    to_clip_id: toClipID,
                    track_id: trackID,
                    transition_type: preset.transitionType,
                    transition_frames: transitionFrames,
                    applied_skill_id: preset.appliedSkillID,
                    reason: reason
                )
            ]
        )
    }
}

public struct TimelineTransitionDurationPreview: Equatable, Sendable {
    public let transitionID: TimelineTransition.ID
    public let trackID: TimelineTrack.ID
    public let fromClipID: TimelineClip.ID
    public let toClipID: TimelineClip.ID
    public let transitionType: String
    public let transitionFrames: Int
    public let previewFrame: Int
    public let appliedSkillID: String?

    public init(
        transitionID: TimelineTransition.ID,
        trackID: TimelineTrack.ID,
        fromClipID: TimelineClip.ID,
        toClipID: TimelineClip.ID,
        transitionType: String,
        transitionFrames: Int,
        previewFrame: Int,
        appliedSkillID: String?
    ) {
        self.transitionID = transitionID
        self.trackID = trackID
        self.fromClipID = fromClipID
        self.toClipID = toClipID
        self.transitionType = transitionType
        self.transitionFrames = transitionFrames
        self.previewFrame = previewFrame
        self.appliedSkillID = appliedSkillID
    }
}

public enum TimelineTransitionPreviewPublishing {
    public static func shouldPublish(
        previous: TimelineTransitionDurationPreview?,
        next: TimelineTransitionDurationPreview,
        currentSelectedTransitionID: TimelineTransition.ID?
    ) -> Bool {
        guard previous == next, currentSelectedTransitionID == next.transitionID else { return true }
        return false
    }

    public static func shouldClear(_ preview: TimelineTransitionDurationPreview?) -> Bool {
        preview != nil
    }
}

public enum TimelineTransitionSelectionPublishing {
    public static func shouldPublish(
        previous: TimelineTransition.ID?,
        next: TimelineTransition.ID?
    ) -> Bool {
        previous != next
    }
}

public enum TimelineTransitionDurationDragRegion {
    public static let defaultCenterHandleWidth = 26.0

    public static func allowsDurationDrag(
        startX: Double,
        hitAreaWidth: Double,
        displayWidth: Double,
        isSelected: Bool,
        centerHandleWidth: Double = defaultCenterHandleWidth
    ) -> Bool {
        let frameWidth = max(hitAreaWidth, displayWidth)
        let visualLeft = max(0, (frameWidth - displayWidth) / 2)
        let visualRight = min(frameWidth, visualLeft + displayWidth)
        guard startX >= visualLeft, startX <= visualRight else { return false }

        let edgeWidth = min(18, max(10, displayWidth * 0.28))
        if startX <= visualLeft + edgeWidth || startX >= visualRight - edgeWidth {
            return true
        }

        guard isSelected else { return false }

        let centerX = (visualLeft + visualRight) / 2
        let centerHalfWidth = min(displayWidth / 2, max(10, centerHandleWidth / 2))
        return startX < centerX - centerHalfWidth || startX > centerX + centerHalfWidth
    }
}

public struct TimelineTransitionRelocatePlan: Equatable, Sendable {
    public let sourceTransitionID: TimelineTransition.ID
    public let sourceTrackID: TimelineTrack.ID
    public let sourceFromClipID: TimelineClip.ID
    public let sourceToClipID: TimelineClip.ID
    public let targetTrackID: TimelineTrack.ID
    public let targetFromClipID: TimelineClip.ID
    public let targetToClipID: TimelineClip.ID
    public let boundaryFrame: Int
    public let transitionType: String
    public let transitionFrames: Int
    public let appliedSkillID: String?
    public let operations: [ReviewPatchOperation]
    public let timeline: TimelineDocument

    public static func make(
        timeline: TimelineDocument,
        sourceTransitionID: TimelineTransition.ID,
        targetTrackID: TimelineTrack.ID,
        targetFromClipID: TimelineClip.ID,
        targetToClipID: TimelineClip.ID,
        reason: String
    ) -> TimelineTransitionRelocatePlan? {
        guard let sourceTransition = timeline.transitions.first(where: {
            $0.id == sourceTransitionID && $0.isVisibleTimelineTransition
        }) else {
            return nil
        }
        guard sourceTransition.trackID != targetTrackID
            || sourceTransition.fromClipID != targetFromClipID
            || sourceTransition.toClipID != targetToClipID
        else {
            return nil
        }
        guard let targetTrack = timeline.displayTracks.first(where: { $0.id == targetTrackID }),
              targetTrack.kind == .video || targetTrack.kind == .overlay,
              let targetFromClip = targetTrack.clips.first(where: { $0.id == targetFromClipID }),
              let targetToClip = targetTrack.clips.first(where: { $0.id == targetToClipID }),
              targetFromClip.timelineOutFrame == targetToClip.timelineInFrame
        else {
            return nil
        }
        let handles = min(targetFromClip.timelineDurationFrames, targetToClip.timelineDurationFrames)
        guard handles > 0, let sourceFrames = sourceTransition.transitionFrames, sourceFrames > 0 else {
            return nil
        }
        let transitionFrames = min(sourceFrames, handles)
        let applyTarget = ReviewPatchOperation.setTransition(
            from_clip_id: targetFromClipID,
            to_clip_id: targetToClipID,
            track_id: targetTrackID,
            transition_type: sourceTransition.transitionType,
            transition_frames: transitionFrames,
            applied_skill_id: sourceTransition.appliedSkillID,
            reason: reason
        )
        let removeSource = ReviewPatchOperation.setTransition(
            from_clip_id: sourceTransition.fromClipID,
            to_clip_id: sourceTransition.toClipID,
            track_id: sourceTransition.trackID,
            transition_type: "cut",
            transition_frames: sourceFrames,
            applied_skill_id: nil,
            reason: "\(reason) remove source"
        )
        guard applyTarget.isValidForStudioSession, removeSource.isValidForStudioSession else {
            return nil
        }
        guard let targetTimeline = timeline.settingTransition(
            fromClipID: targetFromClipID,
            toClipID: targetToClipID,
            trackID: targetTrackID,
            transitionType: sourceTransition.transitionType,
            transitionFrames: transitionFrames,
            appliedSkillID: sourceTransition.appliedSkillID
        ),
              let updatedTimeline = targetTimeline.settingTransition(
                fromClipID: sourceTransition.fromClipID,
                toClipID: sourceTransition.toClipID,
                trackID: sourceTransition.trackID,
                transitionType: "cut",
                transitionFrames: sourceFrames,
                appliedSkillID: nil
              )
        else {
            return nil
        }

        return TimelineTransitionRelocatePlan(
            sourceTransitionID: sourceTransition.id,
            sourceTrackID: sourceTransition.trackID,
            sourceFromClipID: sourceTransition.fromClipID,
            sourceToClipID: sourceTransition.toClipID,
            targetTrackID: targetTrackID,
            targetFromClipID: targetFromClipID,
            targetToClipID: targetToClipID,
            boundaryFrame: targetFromClip.timelineOutFrame,
            transitionType: sourceTransition.transitionType,
            transitionFrames: transitionFrames,
            appliedSkillID: sourceTransition.appliedSkillID,
            operations: [applyTarget, removeSource],
            timeline: updatedTimeline
        )
    }
}

public struct TimelineTransitionPlacementTarget: Equatable, Sendable {
    public let trackID: TimelineTrack.ID
    public let fromClipID: TimelineClip.ID
    public let toClipID: TimelineClip.ID
    public let boundaryFrame: Int
    public let transitionID: TimelineTransition.ID

    public init(
        trackID: TimelineTrack.ID,
        fromClipID: TimelineClip.ID,
        toClipID: TimelineClip.ID,
        boundaryFrame: Int,
        transitionID: TimelineTransition.ID
    ) {
        self.trackID = trackID
        self.fromClipID = fromClipID
        self.toClipID = toClipID
        self.boundaryFrame = boundaryFrame
        self.transitionID = transitionID
    }
}

public enum TimelineTransitionPlacementResolver {
    public static func resolve(
        timeline: TimelineDocument,
        selectedClipIDs: Set<TimelineClip.ID>,
        selectedTransitionID: TimelineTransition.ID?,
        playheadFrame: Int,
        blockedClipIDs: Set<TimelineClip.ID> = []
    ) -> TimelineTransitionPlacementTarget? {
        let boundedPlayheadFrame = max(0, min(playheadFrame, timeline.totalFrames))
        var candidates: [Candidate] = []

        for (trackIndex, track) in timeline.displayTracks.enumerated() where track.kind == .video || track.kind == .overlay {
            let clips = track.clips.sorted {
                if $0.timelineInFrame != $1.timelineInFrame {
                    return $0.timelineInFrame < $1.timelineInFrame
                }
                return $0.id.localizedStandardCompare($1.id) == .orderedAscending
            }
            guard clips.count > 1 else { continue }

            for clipIndex in 0..<(clips.count - 1) {
                let fromClip = clips[clipIndex]
                let toClip = clips[clipIndex + 1]
                guard fromClip.timelineOutFrame == toClip.timelineInFrame,
                      !blockedClipIDs.contains(fromClip.id),
                      !blockedClipIDs.contains(toClip.id) else {
                    continue
                }

                let transitionID = TimelineTransition.stableID(
                    trackID: track.id,
                    fromClipID: fromClip.id,
                    toClipID: toClip.id
                )
                let priority: Int
                if selectedTransitionID == transitionID {
                    priority = 0
                } else if selectedClipIDs.contains(fromClip.id) || selectedClipIDs.contains(toClip.id) {
                    priority = 1
                } else {
                    priority = 2
                }
                let target = TimelineTransitionPlacementTarget(
                    trackID: track.id,
                    fromClipID: fromClip.id,
                    toClipID: toClip.id,
                    boundaryFrame: fromClip.timelineOutFrame,
                    transitionID: transitionID
                )
                candidates.append(Candidate(
                    target: target,
                    priority: priority,
                    distance: abs(fromClip.timelineOutFrame - boundedPlayheadFrame),
                    trackIndex: trackIndex
                ))
            }
        }

        return candidates.sorted { lhs, rhs in
            if lhs.priority != rhs.priority { return lhs.priority < rhs.priority }
            if lhs.distance != rhs.distance { return lhs.distance < rhs.distance }
            if lhs.trackIndex != rhs.trackIndex { return lhs.trackIndex < rhs.trackIndex }
            if lhs.target.boundaryFrame != rhs.target.boundaryFrame {
                return lhs.target.boundaryFrame < rhs.target.boundaryFrame
            }
            return lhs.target.transitionID.localizedStandardCompare(rhs.target.transitionID) == .orderedAscending
        }
        .first?
        .target
    }

    public static func resolveNearestOnTrack(
        timeline: TimelineDocument,
        trackID: TimelineTrack.ID,
        proposedFrame: Int,
        blockedClipIDs: Set<TimelineClip.ID> = []
    ) -> TimelineTransitionPlacementTarget? {
        nearestTargetsOnTrack(
            timeline: timeline,
            trackID: trackID,
            proposedFrame: proposedFrame,
            blockedClipIDs: blockedClipIDs
        )
        .first
    }

    public static func resolveNearestRelocationOnTrack(
        timeline: TimelineDocument,
        sourceTransitionID: TimelineTransition.ID,
        trackID: TimelineTrack.ID,
        proposedFrame: Int,
        blockedClipIDs: Set<TimelineClip.ID> = []
    ) -> TimelineTransitionPlacementTarget? {
        nearestTargetsOnTrack(
            timeline: timeline,
            trackID: trackID,
            proposedFrame: proposedFrame,
            blockedClipIDs: blockedClipIDs
        )
        .first { target in
            guard target.transitionID != sourceTransitionID else { return false }
            return TimelineTransitionRelocatePlan.make(
                timeline: timeline,
                sourceTransitionID: sourceTransitionID,
                targetTrackID: target.trackID,
                targetFromClipID: target.fromClipID,
                targetToClipID: target.toClipID,
                reason: "timeline transition nearest relocation probe"
            ) != nil
        }
    }

    private static func nearestTargetsOnTrack(
        timeline: TimelineDocument,
        trackID: TimelineTrack.ID,
        proposedFrame: Int,
        blockedClipIDs: Set<TimelineClip.ID>
    ) -> [TimelineTransitionPlacementTarget] {
        guard let track = timeline.displayTracks.first(where: { $0.id == trackID }),
              track.kind == .video || track.kind == .overlay
        else { return [] }

        let boundedFrame = max(0, min(proposedFrame, timeline.totalFrames))
        let clips = track.clips.sorted {
            if $0.timelineInFrame != $1.timelineInFrame {
                return $0.timelineInFrame < $1.timelineInFrame
            }
            return $0.id.localizedStandardCompare($1.id) == .orderedAscending
        }
        guard clips.count > 1 else { return [] }

        var candidates: [TimelineTransitionPlacementTarget] = []
        for clipIndex in 0..<(clips.count - 1) {
            let fromClip = clips[clipIndex]
            let toClip = clips[clipIndex + 1]
            guard fromClip.timelineOutFrame == toClip.timelineInFrame,
                  !blockedClipIDs.contains(fromClip.id),
                  !blockedClipIDs.contains(toClip.id)
            else {
                continue
            }
            candidates.append(TimelineTransitionPlacementTarget(
                trackID: track.id,
                fromClipID: fromClip.id,
                toClipID: toClip.id,
                boundaryFrame: fromClip.timelineOutFrame,
                transitionID: TimelineTransition.stableID(
                    trackID: track.id,
                    fromClipID: fromClip.id,
                    toClipID: toClip.id
                )
            ))
        }

        return candidates.sorted { lhs, rhs in
            let lhsDistance = abs(lhs.boundaryFrame - boundedFrame)
            let rhsDistance = abs(rhs.boundaryFrame - boundedFrame)
            if lhsDistance != rhsDistance { return lhsDistance < rhsDistance }
            if lhs.boundaryFrame != rhs.boundaryFrame { return lhs.boundaryFrame < rhs.boundaryFrame }
            return lhs.transitionID.localizedStandardCompare(rhs.transitionID) == .orderedAscending
        }
    }

    private struct Candidate: Equatable {
        let target: TimelineTransitionPlacementTarget
        let priority: Int
        let distance: Int
        let trackIndex: Int
    }
}
