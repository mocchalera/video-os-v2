import Foundation

public enum TimelineClipSelectionNavigationDirection: Sendable {
    case previous
    case next
}

public struct TimelineClipSelectionNavigationPlan: Equatable, Sendable {
    public let primaryClipID: TimelineClip.ID
    public let selectedClipIDs: Set<TimelineClip.ID>
    public let playheadFrame: Int
    public let statusMessage: String

    public static func make(
        timeline: TimelineDocument,
        currentPrimaryClipID: TimelineClip.ID?,
        currentSelectedClipIDs: Set<TimelineClip.ID>,
        playheadFrame: Int,
        direction: TimelineClipSelectionNavigationDirection,
        extendingSelection: Bool
    ) -> TimelineClipSelectionNavigationPlan? {
        let entries = TimelineClipNavigationEntry.entries(in: timeline)
        guard !entries.isEmpty else { return nil }

        var activeIDs = currentSelectedClipIDs
        if let currentPrimaryClipID {
            activeIDs.insert(currentPrimaryClipID)
        }

        if !activeIDs.isEmpty {
            return makeFromExistingSelection(
                timeline: timeline,
                entries: entries,
                currentPrimaryClipID: currentPrimaryClipID,
                activeIDs: activeIDs,
                direction: direction,
                extendingSelection: extendingSelection
            )
        }

        return makeFromPlayhead(
            timeline: timeline,
            entries: entries,
            playheadFrame: playheadFrame,
            direction: direction
        )
    }

    private static func makeFromExistingSelection(
        timeline: TimelineDocument,
        entries: [TimelineClipNavigationEntry],
        currentPrimaryClipID: TimelineClip.ID?,
        activeIDs: Set<TimelineClip.ID>,
        direction: TimelineClipSelectionNavigationDirection,
        extendingSelection: Bool
    ) -> TimelineClipSelectionNavigationPlan? {
        guard let primaryEntry = currentPrimaryClipID.flatMap({ id in entries.first { $0.clip.id == id } })
            ?? entries.first(where: { activeIDs.contains($0.clip.id) })
        else {
            return nil
        }

        let trackEntries = entries.filter { $0.trackID == primaryEntry.trackID }
        guard let primaryIndex = trackEntries.firstIndex(where: { $0.clip.id == primaryEntry.clip.id }) else {
            return nil
        }

        let selectedIndices = trackEntries.indices.filter { activeIDs.contains(trackEntries[$0].clip.id) }
        let pivotIndex: Int
        if extendingSelection, !selectedIndices.isEmpty {
            pivotIndex = direction == .next ? (selectedIndices.max() ?? primaryIndex) : (selectedIndices.min() ?? primaryIndex)
        } else {
            pivotIndex = primaryIndex
        }

        let targetIndex = pivotIndex + (direction == .next ? 1 : -1)
        guard trackEntries.indices.contains(targetIndex) else { return nil }

        let target = trackEntries[targetIndex]
        if extendingSelection {
            let rangeStart = min((selectedIndices.min() ?? primaryIndex), targetIndex)
            let rangeEnd = max((selectedIndices.max() ?? primaryIndex), targetIndex)
            let ids = Set(trackEntries[rangeStart...rangeEnd].map { $0.clip.id })
            return plan(
                timeline: timeline,
                primary: target,
                selectedIDs: ids,
                statusPrefix: "\(target.trackID) の \(ids.count)件を範囲選択"
            )
        }

        return plan(
            timeline: timeline,
            primary: target,
            selectedIDs: [target.clip.id],
            statusPrefix: "\(target.trackID) の \(target.clip.id) を選択"
        )
    }

    private static func makeFromPlayhead(
        timeline: TimelineDocument,
        entries: [TimelineClipNavigationEntry],
        playheadFrame: Int,
        direction: TimelineClipSelectionNavigationDirection
    ) -> TimelineClipSelectionNavigationPlan? {
        let target: TimelineClipNavigationEntry?
        switch direction {
        case .next:
            target = entries
                .filter { $0.clip.timelineInFrame >= playheadFrame || $0.clip.containsTimelineFrame(playheadFrame) }
                .sorted(by: TimelineClipNavigationEntry.timelineOrder)
                .first
        case .previous:
            target = entries
                .filter { $0.clip.timelineInFrame < playheadFrame || $0.clip.containsTimelineFrame(playheadFrame) }
                .sorted(by: TimelineClipNavigationEntry.reverseTimelineOrder)
                .first
        }
        guard let target else { return nil }

        return plan(
            timeline: timeline,
            primary: target,
            selectedIDs: [target.clip.id],
            statusPrefix: "\(target.trackID) の \(target.clip.id) を選択"
        )
    }

    private static func plan(
        timeline: TimelineDocument,
        primary: TimelineClipNavigationEntry,
        selectedIDs: Set<TimelineClip.ID>,
        statusPrefix: String
    ) -> TimelineClipSelectionNavigationPlan {
        let start = primary.clip.timelineInFrame
        let end = primary.clip.timelineOutFrame
        return TimelineClipSelectionNavigationPlan(
            primaryClipID: primary.clip.id,
            selectedClipIDs: selectedIDs,
            playheadFrame: start,
            statusMessage: "\(statusPrefix)しました（\(timeline.sequence.framesToTimecode(start))-\(timeline.sequence.framesToTimecode(end))）。"
        )
    }
}

private struct TimelineClipNavigationEntry: Equatable, Sendable {
    let trackIndex: Int
    let trackID: TimelineTrack.ID
    let clip: TimelineClip

    static func entries(in timeline: TimelineDocument) -> [TimelineClipNavigationEntry] {
        timeline.displayTracks.enumerated().flatMap { trackIndex, track in
            track.clips
                .sorted(by: { lhs, rhs in
                    if lhs.timelineInFrame == rhs.timelineInFrame { return lhs.id < rhs.id }
                    return lhs.timelineInFrame < rhs.timelineInFrame
                })
                .map { clip in
                    TimelineClipNavigationEntry(trackIndex: trackIndex, trackID: track.id, clip: clip)
                }
        }
    }

    static func timelineOrder(_ lhs: TimelineClipNavigationEntry, _ rhs: TimelineClipNavigationEntry) -> Bool {
        if lhs.clip.timelineInFrame != rhs.clip.timelineInFrame {
            return lhs.clip.timelineInFrame < rhs.clip.timelineInFrame
        }
        if lhs.trackIndex != rhs.trackIndex {
            return lhs.trackIndex < rhs.trackIndex
        }
        return lhs.clip.id < rhs.clip.id
    }

    static func reverseTimelineOrder(_ lhs: TimelineClipNavigationEntry, _ rhs: TimelineClipNavigationEntry) -> Bool {
        if lhs.clip.timelineInFrame != rhs.clip.timelineInFrame {
            return lhs.clip.timelineInFrame > rhs.clip.timelineInFrame
        }
        if lhs.trackIndex != rhs.trackIndex {
            return lhs.trackIndex < rhs.trackIndex
        }
        return lhs.clip.id < rhs.clip.id
    }
}
