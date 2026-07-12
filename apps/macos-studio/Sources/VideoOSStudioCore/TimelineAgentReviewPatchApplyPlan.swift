import Foundation

public struct TimelineAgentReviewPatchPreviewDiff: Equatable, Identifiable, Sendable {
    public let id: String
    public let operationName: String
    public let targetLabel: String
    public let beforeLabel: String
    public let afterLabel: String
}

public struct TimelineAgentReviewPatchApplyPlan: Equatable, Sendable {
    public let operations: [ReviewPatchOperation]
    public let updatedTimeline: TimelineDocument
    public let changedClipIDs: [TimelineClip.ID]
    public let selectedClipID: TimelineClip.ID?
    public let selectedTransitionID: TimelineTransition.ID?
    public let focusFrame: Int?
    public let previewDiffs: [TimelineAgentReviewPatchPreviewDiff]
    public let blockedReasons: [String]

    public var canApply: Bool {
        blockedReasons.isEmpty && !operations.isEmpty
    }

    public var summaryLabel: String {
        if canApply {
            return "\(operations.count)件をTimeline表示へ反映できます"
        }
        if blockedReasons.isEmpty {
            return "Timeline表示へ反映できる操作がありません"
        }
        return blockedReasons[0]
    }

    public static func evaluate(
        draft: TimelineAgentReviewPatchDraft,
        timeline: TimelineDocument,
        candidateDataSource: CandidateBrowserDataSource? = nil
    ) -> TimelineAgentReviewPatchApplyPlan {
        var blockedReasons: [String] = []
        guard draft.patch.timeline_version == timeline.version else {
            return TimelineAgentReviewPatchApplyPlan(
                operations: [],
                updatedTimeline: timeline,
                changedClipIDs: [],
                selectedClipID: nil,
                selectedTransitionID: nil,
                focusFrame: nil,
                previewDiffs: [],
                blockedReasons: ["timeline_versionが現在のタイムラインと異なるため表示へ反映できません。"]
            )
        }

        var document = timeline
        var acceptedOperations: [ReviewPatchOperation] = []
        var changedClipIDs: [TimelineClip.ID] = []
        var selectedClipID: TimelineClip.ID?
        var selectedTransitionID: TimelineTransition.ID?
        var focusFrame: Int?
        var previewDiffs: [TimelineAgentReviewPatchPreviewDiff] = []

        for (index, operation) in draft.patch.operations.enumerated() {
            guard operation.isValidForCompilerSchema else {
                blockedReasons.append("\(operation.opName) はtimeline.jsonへ保存できる形式ではありません。")
                continue
            }
            guard operation.isSupportedForAgentTimelinePreview else {
                blockedReasons.append("\(operation.opName) はまだTimeline表示への直接反映に対応していません。")
                continue
            }

            switch operation {
            case let .replaceSegment(targetClipID, segmentID, candidateRef, sourceInUS, sourceOutUS, reason):
                guard let dataSource = candidateDataSource else {
                    blockedReasons.append("replace_segment を表示反映するにはselect候補の読み込みが必要です。")
                    continue
                }
                guard let targetSelection = document.clipSelection(for: targetClipID) else {
                    blockedReasons.append("\(targetClipID) を置換対象として確認できません。")
                    continue
                }
                guard let candidate = dataSource.agentReviewPatchCandidate(
                    segmentID: segmentID,
                    candidateRef: candidateRef
                ) else {
                    blockedReasons.append("\(segmentID) に対応するselect候補を確認できません。")
                    continue
                }
                guard TimelineSourceReplacePlan.isCompatible(candidate: candidate, with: targetSelection.trackKind) else {
                    blockedReasons.append("\(segmentID) は\(targetSelection.trackID)のclip種別と互換ではありません。")
                    continue
                }
                let sourceRangeOverride: TimelineSourceRangeOverride?
                switch (sourceInUS, sourceOutUS) {
                case (nil, nil):
                    sourceRangeOverride = nil
                case let (sourceInUS?, sourceOutUS?):
                    guard sourceInUS >= candidate.src_in_us,
                          sourceOutUS <= candidate.src_out_us,
                          let range = TimelineSourceRangeOverride(sourceInUS: sourceInUS, sourceOutUS: sourceOutUS) else {
                        blockedReasons.append("\(segmentID) の指定source rangeを反映できません。")
                        continue
                    }
                    sourceRangeOverride = range
                default:
                    blockedReasons.append("\(segmentID) の指定source rangeを反映できません。")
                    continue
                }
                guard let updatedDocument = document.replacingClip(
                    targetClipID,
                    with: candidate,
                    reason: reason,
                    sourceRangeOverride: sourceRangeOverride
                ) else {
                    blockedReasons.append("\(targetClipID) を \(segmentID) で置換できません。")
                    continue
                }
                previewDiffs.append(clipPreviewDiff(
                    id: "\(index)-\(operation.opName)-\(targetClipID)",
                    operationName: operation.opName,
                    targetLabel: targetClipID,
                    before: targetSelection,
                    after: updatedDocument.clipSelection(for: targetClipID)
                ))
                document = updatedDocument
                acceptedOperations.append(operation)
                changedClipIDs.append(targetClipID)
                selectedClipID = targetClipID
                focusFrame = targetSelection.clip.timelineInFrame

            case let .trimSegment(targetClipID, sourceInUS, sourceOutUS, _):
                let beforeSelection = document.clipSelection(for: targetClipID)
                guard let updatedDocument = document.trimmingClip(
                    targetClipID,
                    sourceInUS: sourceInUS,
                    sourceOutUS: sourceOutUS
                ) else {
                    blockedReasons.append("\(targetClipID) を指定範囲へトリムできません。")
                    continue
                }
                previewDiffs.append(clipPreviewDiff(
                    id: "\(index)-\(operation.opName)-\(targetClipID)",
                    operationName: operation.opName,
                    targetLabel: targetClipID,
                    before: beforeSelection,
                    after: updatedDocument.clipSelection(for: targetClipID)
                ))
                document = updatedDocument
                acceptedOperations.append(operation)
                changedClipIDs.append(targetClipID)
                selectedClipID = targetClipID
                focusFrame = document.clipSelection(for: targetClipID)?.clip.timelineInFrame ?? focusFrame

            case let .moveSegment(targetClipID, timelineInFrame, durationFrames, targetTrackID, _):
                let beforeSelection = document.clipSelection(for: targetClipID)
                guard let updatedDocument = document.movingClip(
                    targetClipID,
                    toTimelineInFrame: timelineInFrame,
                    durationFrames: durationFrames,
                    targetTrackID: targetTrackID
                ) else {
                    blockedReasons.append("\(targetClipID) を指定位置へ移動できません。")
                    continue
                }
                previewDiffs.append(clipPreviewDiff(
                    id: "\(index)-\(operation.opName)-\(targetClipID)",
                    operationName: operation.opName,
                    targetLabel: targetClipID,
                    before: beforeSelection,
                    after: updatedDocument.clipSelection(for: targetClipID)
                ))
                document = updatedDocument
                acceptedOperations.append(operation)
                changedClipIDs.append(targetClipID)
                selectedClipID = targetClipID
                focusFrame = timelineInFrame

            case let .splitSegment(targetClipID, splitFrame, reason):
                let rightClipID = TimelineSplitPlan.nextClipID(in: document)
                let beforeSelection = document.clipSelection(for: targetClipID)
                guard let updatedDocument = document.splittingClip(
                    targetClipID,
                    atTimelineFrame: splitFrame,
                    rightClipID: rightClipID,
                    reason: reason
                ) else {
                    blockedReasons.append("\(targetClipID) を指定位置で分割できません。")
                    continue
                }
                previewDiffs.append(TimelineAgentReviewPatchPreviewDiff(
                    id: "\(index)-\(operation.opName)-\(targetClipID)",
                    operationName: operation.opName,
                    targetLabel: targetClipID,
                    beforeLabel: clipStateLabel(beforeSelection),
                    afterLabel: [
                        splitClipStateLabel(updatedDocument.clipSelection(for: targetClipID)),
                        splitClipStateLabel(updatedDocument.clipSelection(for: rightClipID)),
                    ]
                    .compactMap { $0 }
                    .joined(separator: " + ")
                ))
                document = updatedDocument
                acceptedOperations.append(operation)
                changedClipIDs.append(targetClipID)
                changedClipIDs.append(rightClipID)
                selectedClipID = rightClipID
                focusFrame = splitFrame

            case let .removeSegment(targetClipID, _):
                let beforeSelection = document.clipSelection(for: targetClipID)
                guard let updatedDocument = document.removingClips([targetClipID]) else {
                    blockedReasons.append("\(targetClipID) を削除できません。")
                    continue
                }
                previewDiffs.append(TimelineAgentReviewPatchPreviewDiff(
                    id: "\(index)-\(operation.opName)-\(targetClipID)",
                    operationName: operation.opName,
                    targetLabel: targetClipID,
                    beforeLabel: clipStateLabel(beforeSelection),
                    afterLabel: "removed"
                ))
                document = updatedDocument
                acceptedOperations.append(operation)
                changedClipIDs.append(targetClipID)
                if selectedClipID == targetClipID {
                    selectedClipID = nil
                }

            case let .setTransition(fromClipID, toClipID, trackID, transitionType, transitionFrames, appliedSkillID, _):
                if transitionType.lowercased() != "cut",
                   document.transitionHandles(trackID: trackID, fromClipID: fromClipID, toClipID: toClipID) == nil {
                    blockedReasons.append("\(fromClipID) → \(toClipID) は隣接していないためトランジションを反映できません。")
                    continue
                }
                guard let updatedDocument = document.settingTransition(
                    fromClipID: fromClipID,
                    toClipID: toClipID,
                    trackID: trackID,
                    transitionType: transitionType,
                    transitionFrames: transitionFrames,
                    appliedSkillID: appliedSkillID
                ) else {
                    blockedReasons.append("\(fromClipID) → \(toClipID) のトランジションを反映できません。")
                    continue
                }
                let targetLabel = "\(trackID):\(fromClipID)->\(toClipID)"
                previewDiffs.append(TimelineAgentReviewPatchPreviewDiff(
                    id: "\(index)-\(operation.opName)-\(targetLabel)",
                    operationName: operation.opName,
                    targetLabel: targetLabel,
                    beforeLabel: transitionStateLabel(
                        in: document,
                        trackID: trackID,
                        fromClipID: fromClipID,
                        toClipID: toClipID
                    ),
                    afterLabel: transitionStateLabel(
                        in: updatedDocument,
                        trackID: trackID,
                        fromClipID: fromClipID,
                        toClipID: toClipID
                    )
                ))
                document = updatedDocument
                acceptedOperations.append(operation)
                changedClipIDs.append(fromClipID)
                changedClipIDs.append(toClipID)
                selectedClipID = nil
                selectedTransitionID = transitionType.lowercased() == "cut"
                    ? nil
                    : TimelineTransition.stableID(trackID: trackID, fromClipID: fromClipID, toClipID: toClipID)
                focusFrame = document.clipSelection(for: fromClipID)?.clip.timelineOutFrame ?? focusFrame

            case .insertSegment, .changeAudioPolicy, .addMarker, .addNote:
                blockedReasons.append("\(operation.opName) はまだTimeline表示への直接反映に対応していません。")
            }
        }

        if !blockedReasons.isEmpty {
            return TimelineAgentReviewPatchApplyPlan(
                operations: [],
                updatedTimeline: timeline,
                changedClipIDs: [],
                selectedClipID: nil,
                selectedTransitionID: nil,
                focusFrame: nil,
                previewDiffs: [],
                blockedReasons: blockedReasons
            )
        }

        return TimelineAgentReviewPatchApplyPlan(
            operations: acceptedOperations,
            updatedTimeline: document,
            changedClipIDs: Array(Set(changedClipIDs)).sorted(),
            selectedClipID: selectedClipID,
            selectedTransitionID: selectedTransitionID,
            focusFrame: focusFrame,
            previewDiffs: previewDiffs,
            blockedReasons: []
        )
    }

    private static func clipPreviewDiff(
        id: String,
        operationName: String,
        targetLabel: String,
        before: TimelineClipSelection?,
        after: TimelineClipSelection?
    ) -> TimelineAgentReviewPatchPreviewDiff {
        TimelineAgentReviewPatchPreviewDiff(
            id: id,
            operationName: operationName,
            targetLabel: targetLabel,
            beforeLabel: clipStateLabel(before),
            afterLabel: clipStateLabel(after)
        )
    }

    private static func clipStateLabel(_ selection: TimelineClipSelection?) -> String {
        guard let selection else { return "missing" }
        let clip = selection.clip
        var parts = ["\(selection.trackID) frame \(clip.timelineInFrame)-\(clip.timelineOutFrame)"]
        if let sourceInUS = clip.sourceInUS,
           let sourceOutUS = clip.sourceOutUS {
            parts.append("src \(formatMicroseconds(sourceInUS))-\(formatMicroseconds(sourceOutUS))")
        }
        parts.append(clip.segmentID)
        return parts.joined(separator: " / ")
    }

    private static func splitClipStateLabel(_ selection: TimelineClipSelection?) -> String? {
        guard let selection else { return nil }
        return "\(selection.clip.id) \(clipStateLabel(selection))"
    }

    private static func transitionStateLabel(
        in document: TimelineDocument,
        trackID: TimelineTrack.ID,
        fromClipID: TimelineClip.ID,
        toClipID: TimelineClip.ID
    ) -> String {
        guard let transition = document.transitions.first(where: {
            $0.trackID == trackID
                && $0.fromClipID == fromClipID
                && $0.toClipID == toClipID
        }) else {
            return "cut"
        }
        var parts = ["\(transition.trackID) \(transition.transitionType)"]
        if let transitionFrames = transition.transitionFrames {
            parts.append("\(transitionFrames)f")
        }
        if let appliedSkillID = transition.appliedSkillID {
            parts.append(appliedSkillID)
        }
        return parts.joined(separator: " / ")
    }

    private static func formatMicroseconds(_ value: Int) -> String {
        String(format: "%.3fs", Double(value) / 1_000_000)
    }

}

private extension ReviewPatchOperation {
    var isSupportedForAgentTimelinePreview: Bool {
        switch self {
        case .replaceSegment, .trimSegment, .moveSegment, .splitSegment, .removeSegment, .setTransition:
            return true
        case .insertSegment, .changeAudioPolicy, .addMarker, .addNote:
            return false
        }
    }
}

private extension CandidateBrowserDataSource {
    func agentReviewPatchCandidate(
        segmentID: String,
        candidateRef: String?
    ) -> BrowserCandidate? {
        candidates.first { candidate in
            if candidate.segment_id == segmentID {
                return true
            }
            guard let candidateRef else {
                return false
            }
            return candidate.id == candidateRef
                || candidate.candidate_id == candidateRef
        }
    }
}
