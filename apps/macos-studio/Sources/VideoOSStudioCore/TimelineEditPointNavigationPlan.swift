import Foundation

public enum TimelineEditPointNavigationDirection: Sendable {
    case previous
    case next
}

public struct TimelineEditPointNavigationPlan: Equatable, Sendable {
    public let frame: Int
    public let timecode: String
    public let targetLabel: String
    public let statusMessage: String

    public static func make(
        timeline: TimelineDocument,
        playheadFrame: Int,
        direction: TimelineEditPointNavigationDirection
    ) -> TimelineEditPointNavigationPlan? {
        let targets = TimelineEditPointNavigationTarget.targets(in: timeline)
        guard !targets.isEmpty else { return nil }

        let boundedPlayheadFrame = max(0, min(playheadFrame, timeline.totalFrames))
        let target: TimelineEditPointNavigationTarget?
        switch direction {
        case .previous:
            target = targets.filter { $0.frame < boundedPlayheadFrame }.max(by: TimelineEditPointNavigationTarget.timelineOrder)
        case .next:
            target = targets.filter { $0.frame > boundedPlayheadFrame }.min(by: TimelineEditPointNavigationTarget.timelineOrder)
        }
        guard let target else { return nil }

        let timecode = timeline.sequence.framesToTimecode(target.frame)
        let directionLabel = direction == .next ? "次" : "前"
        return TimelineEditPointNavigationPlan(
            frame: target.frame,
            timecode: timecode,
            targetLabel: target.label,
            statusMessage: "\(directionLabel)の編集点 \(timecode) へ移動しました（\(target.label)）。"
        )
    }
}

private struct TimelineEditPointNavigationTarget: Equatable, Sendable {
    let frame: Int
    let label: String

    static func targets(in timeline: TimelineDocument) -> [TimelineEditPointNavigationTarget] {
        var labelsByFrame: [Int: Set<TimelineEditPointNavigationLabel>] = [:]

        func add(frame: Int, label: TimelineEditPointNavigationLabel) {
            let boundedFrame = max(0, min(frame, timeline.totalFrames))
            labelsByFrame[boundedFrame, default: []].insert(label)
        }

        add(frame: 0, label: .timelineStart)
        add(frame: timeline.totalFrames, label: .timelineEnd)

        for track in timeline.displayTracks {
            for clip in track.clips {
                add(frame: clip.timelineInFrame, label: .clipStart)
                add(frame: clip.timelineOutFrame, label: .clipEnd)
            }
        }

        for marker in timeline.markers {
            add(frame: marker.frame, label: .marker)
        }

        for transition in timeline.transitions where transition.isVisibleTimelineTransition {
            guard let track = timeline.displayTracks.first(where: { $0.id == transition.trackID }),
                  let fromClip = track.clips.first(where: { $0.id == transition.fromClipID }),
                  let toClip = track.clips.first(where: { $0.id == transition.toClipID }),
                  fromClip.timelineOutFrame == toClip.timelineInFrame
            else {
                continue
            }
            add(frame: toClip.timelineInFrame, label: .transition)
        }

        return labelsByFrame.map { frame, labels in
            TimelineEditPointNavigationTarget(
                frame: frame,
                label: labels.sorted(by: TimelineEditPointNavigationLabel.displayOrder).map(\.rawValue).joined(separator: " / ")
            )
        }
        .sorted(by: timelineOrder)
    }

    static func timelineOrder(_ lhs: TimelineEditPointNavigationTarget, _ rhs: TimelineEditPointNavigationTarget) -> Bool {
        if lhs.frame == rhs.frame { return lhs.label < rhs.label }
        return lhs.frame < rhs.frame
    }
}

private enum TimelineEditPointNavigationLabel: String, Sendable {
    case timelineStart = "タイムライン先頭"
    case timelineEnd = "タイムライン末尾"
    case transition = "トランジション"
    case marker = "マーカー"
    case clipStart = "クリップ開始"
    case clipEnd = "クリップ終了"

    static func displayOrder(_ lhs: TimelineEditPointNavigationLabel, _ rhs: TimelineEditPointNavigationLabel) -> Bool {
        priority(lhs) < priority(rhs)
    }

    private static func priority(_ label: TimelineEditPointNavigationLabel) -> Int {
        switch label {
        case .timelineStart:
            return 0
        case .timelineEnd:
            return 1
        case .transition:
            return 2
        case .marker:
            return 3
        case .clipStart:
            return 4
        case .clipEnd:
            return 5
        }
    }
}
