import Foundation

public struct TimelineSourceOverwritePlan: Equatable, Sendable {
    public let candidate: BrowserCandidate
    public let insertedClipID: TimelineClip.ID
    public let beatID: String
    public let role: String
    public let targetTrackID: TimelineTrack.ID
    public let targetKind: TimelineTrackKind
    public let timelineInFrame: Int
    public let durationFrames: Int
    public let overwriteOutFrame: Int
    public let removedClipIDs: [TimelineClip.ID]
    public let trimmedClipIDs: [TimelineClip.ID]
    public let splitClipIDs: [TimelineClip.ID]
    public let operations: [ReviewPatchOperation]
    public let timeline: TimelineDocument

    public var changedClipIDs: [TimelineClip.ID] {
        uniquedClipIDs([insertedClipID] + trimmedClipIDs + splitClipIDs)
    }

    public static func make(
        timeline: TimelineDocument,
        dataSource: CandidateBrowserDataSource,
        sourceAssetID: String,
        playheadFrame: Int,
        reason: String,
        candidateID: BrowserCandidate.ID? = nil,
        preferredTargetTrackID: TimelineTrack.ID? = nil,
        sourceRangeOverride: TimelineSourceRangeOverride? = nil
    ) -> TimelineSourceOverwritePlan? {
        let insertPlan = makeInsertPlan(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: sourceAssetID,
            playheadFrame: playheadFrame,
            reason: reason,
            candidateID: candidateID,
            preferredTargetTrackID: preferredTargetTrackID,
            sourceRangeOverride: sourceRangeOverride
        )
        guard let insertPlan,
              let targetTrack = timeline.displayTracks.first(where: { $0.id == insertPlan.targetTrackID }),
              targetTrack.kind == insertPlan.targetKind else {
            return nil
        }

        let overwriteInFrame = insertPlan.timelineInFrame
        let overwriteOutFrame = overwriteInFrame + insertPlan.durationFrames
        guard overwriteOutFrame > overwriteInFrame else { return nil }

        var operations: [ReviewPatchOperation] = [insertPlan.operation]
        var removedClipIDs: [TimelineClip.ID] = []
        var trimmedClipIDs: [TimelineClip.ID] = []
        var splitClipIDs: [TimelineClip.ID] = []

        let sortedClips = targetTrack.clips.sorted {
            if $0.timelineInFrame != $1.timelineInFrame {
                return $0.timelineInFrame < $1.timelineInFrame
            }
            return $0.id.localizedStandardCompare($1.id) == .orderedAscending
        }

        for clip in sortedClips {
            guard clip.timelineInFrame < overwriteOutFrame,
                  clip.timelineOutFrame > overwriteInFrame else {
                continue
            }

            if clip.timelineInFrame >= overwriteInFrame && clip.timelineOutFrame <= overwriteOutFrame {
                operations.append(.removeSegment(
                    target_clip_id: clip.id,
                    reason: "Overwrite covered by \(insertPlan.candidate.segment_id)"
                ))
                removedClipIDs.append(clip.id)
                continue
            }

            let selection = TimelineClipSelection(trackID: targetTrack.id, trackKind: targetTrack.kind, clip: clip)
            if clip.timelineInFrame < overwriteInFrame && clip.timelineOutFrame <= overwriteOutFrame {
                guard let trimPlan = TimelinePlayheadTrimPlan.make(
                    selection: selection,
                    playheadFrame: overwriteInFrame,
                    edge: .end,
                    reason: "Overwrite trims outgoing edge before \(insertPlan.candidate.segment_id)"
                ) else {
                    return nil
                }
                operations.append(contentsOf: trimPlan.operations)
                trimmedClipIDs.append(clip.id)
                continue
            }

            if clip.timelineInFrame >= overwriteInFrame && clip.timelineOutFrame > overwriteOutFrame {
                guard let trimPlan = TimelinePlayheadTrimPlan.make(
                    selection: selection,
                    playheadFrame: overwriteOutFrame,
                    edge: .start,
                    reason: "Overwrite trims incoming edge after \(insertPlan.candidate.segment_id)"
                ) else {
                    return nil
                }
                operations.append(contentsOf: trimPlan.operations)
                trimmedClipIDs.append(clip.id)
                continue
            }

            guard let splitPlan = TimelineSplitPlan.make(
                selection: selection,
                playheadFrame: overwriteOutFrame,
                reason: "Overwrite preserves trailing remainder after \(insertPlan.candidate.segment_id)"
            ),
                let trimPlan = TimelinePlayheadTrimPlan.make(
                    selection: selection,
                    playheadFrame: overwriteInFrame,
                    edge: .end,
                    reason: "Overwrite trims middle span before \(insertPlan.candidate.segment_id)"
                ) else {
                return nil
            }
            operations.append(contentsOf: splitPlan.operations)
            operations.append(contentsOf: trimPlan.operations)
            splitClipIDs.append(clip.id)
            trimmedClipIDs.append(clip.id)
        }

        var previewTimeline = insertPlan.timeline
        for operation in operations.dropFirst() {
            switch operation {
            case let .splitSegment(targetClipID, splitTimelineFrame, reason):
                let rightClipID = nextClipID(in: previewTimeline)
                guard let updatedTimeline = previewTimeline.splittingClip(
                    targetClipID,
                    atTimelineFrame: splitTimelineFrame,
                    rightClipID: rightClipID,
                    reason: reason
                ) else {
                    return nil
                }
                previewTimeline = updatedTimeline
            case .trimSegment, .moveSegment:
                previewTimeline = previewTimeline.applyingTimelineTrimOperations([operation])
            case let .removeSegment(targetClipID, _):
                guard let updatedTimeline = previewTimeline.removingClips([targetClipID]) else {
                    return nil
                }
                previewTimeline = updatedTimeline
            default:
                continue
            }
        }

        return TimelineSourceOverwritePlan(
            candidate: insertPlan.candidate,
            insertedClipID: insertPlan.insertedClipID,
            beatID: insertPlan.beatID,
            role: insertPlan.role,
            targetTrackID: insertPlan.targetTrackID,
            targetKind: insertPlan.targetKind,
            timelineInFrame: insertPlan.timelineInFrame,
            durationFrames: insertPlan.durationFrames,
            overwriteOutFrame: overwriteOutFrame,
            removedClipIDs: removedClipIDs,
            trimmedClipIDs: trimmedClipIDs,
            splitClipIDs: splitClipIDs,
            operations: operations,
            timeline: previewTimeline
        )
    }

    private static func makeInsertPlan(
        timeline: TimelineDocument,
        dataSource: CandidateBrowserDataSource,
        sourceAssetID: String,
        playheadFrame: Int,
        reason: String,
        candidateID: BrowserCandidate.ID?,
        preferredTargetTrackID: TimelineTrack.ID?,
        sourceRangeOverride: TimelineSourceRangeOverride?
    ) -> TimelineSourceInsertPlan? {
        if let preferredTargetTrackID {
            guard let targetTrack = timeline.displayTracks.first(where: { $0.id == preferredTargetTrackID }) else {
                return nil
            }
            return makeInsertPlanForExistingTrack(
                timeline: timeline,
                dataSource: dataSource,
                sourceAssetID: sourceAssetID,
                playheadFrame: playheadFrame,
                reason: reason,
                candidateID: candidateID,
                targetTrack: targetTrack,
                sourceRangeOverride: sourceRangeOverride
            )
        }

        return TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: sourceAssetID,
            playheadFrame: playheadFrame,
            reason: reason,
            candidateID: candidateID,
            sourceRangeOverride: sourceRangeOverride
        )
    }

    private static func makeInsertPlanForExistingTrack(
        timeline: TimelineDocument,
        dataSource: CandidateBrowserDataSource,
        sourceAssetID: String,
        playheadFrame: Int,
        reason: String,
        candidateID: BrowserCandidate.ID?,
        targetTrack: TimelineTrack,
        sourceRangeOverride: TimelineSourceRangeOverride?
    ) -> TimelineSourceInsertPlan? {
        let usedSegmentIDs = Set(timeline.displayTracks.flatMap(\.clips).map(\.segmentID))
        let candidates = TimelineSourceInsertPlan.insertCandidates(
            in: dataSource,
            sourceAssetID: sourceAssetID,
            usedSegmentIDs: usedSegmentIDs
        )
        let candidate = candidateID.flatMap { id in
            candidates.first { $0.id == id }
        } ?? candidates.first { TimelineSourceInsertPlan.isCompatibleTrackKind(targetTrack.kind, withRole: $0.role) }
        guard let candidate,
              TimelineSourceInsertPlan.isCompatibleTrackKind(targetTrack.kind, withRole: candidate.role) else {
            return nil
        }

        let sourceInUS = sourceRangeOverride?.sourceInUS ?? candidate.src_in_us
        let sourceOutUS = sourceRangeOverride?.sourceOutUS ?? candidate.src_out_us
        guard sourceInUS >= candidate.src_in_us,
              sourceOutUS <= candidate.src_out_us,
              sourceOutUS > sourceInUS else {
            return nil
        }

        let role = TimelineSourceInsertPlan.insertRole(for: candidate.role)
        let timelineInFrame = max(0, min(playheadFrame, timeline.totalFrames))
        let durationFrames = TimelineSourceInsertPlan.durationFrames(
            sourceInUS: sourceInUS,
            sourceOutUS: sourceOutUS,
            sequence: timeline.sequence
        )
        let insertedClipID = nextClipID(in: timeline)
        let beatID = TimelineSourceInsertPlan.beatID(for: candidate, timeline: timeline, timelineInFrame: timelineInFrame)
        let hasSourceRangeOverride = sourceInUS != candidate.src_in_us || sourceOutUS != candidate.src_out_us
        let operation = ReviewPatchOperation.insertSegment(
            beat_id: beatID,
            segment_id: candidate.segment_id,
            role: role,
            new_timeline_in_frame: timelineInFrame,
            new_duration_frames: durationFrames,
            target_track_id: targetTrack.id,
            new_src_in_us: hasSourceRangeOverride ? sourceInUS : nil,
            new_src_out_us: hasSourceRangeOverride ? sourceOutUS : nil,
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
            motivation: "[studio:overwrite] \(candidate.why_it_matches)",
            confidence: candidate.confidence,
            beatID: beatID,
            fallbackSegmentIDs: [],
            qualityFlags: [],
            candidateRef: candidate.id
        )
        guard let updatedTimeline = timeline.insertingClip(
            clip,
            targetTrackID: targetTrack.id,
            targetKind: targetTrack.kind
        ) else {
            return nil
        }

        return TimelineSourceInsertPlan(
            candidate: candidate,
            insertedClipID: insertedClipID,
            beatID: beatID,
            role: role,
            targetTrackID: targetTrack.id,
            targetKind: targetTrack.kind,
            laneLift: nil,
            proposedTimelineInFrame: timelineInFrame,
            timelineInFrame: timelineInFrame,
            durationFrames: durationFrames,
            snap: nil,
            operation: operation,
            timeline: updatedTimeline
        )
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

    private func uniquedClipIDs(_ clipIDs: [TimelineClip.ID]) -> [TimelineClip.ID] {
        var seen: Set<TimelineClip.ID> = []
        return clipIDs.filter { seen.insert($0).inserted }
    }
}
