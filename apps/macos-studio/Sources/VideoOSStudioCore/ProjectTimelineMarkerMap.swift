import Foundation

public struct ProjectTimelineMarkerMap: Equatable, Sendable {
    public let markers: [TimelineMarkerCue]

    public static func build(timeline: TimelineDocument) -> ProjectTimelineMarkerMap {
        let markers = timeline.markers
            .map { marker in
                let normalizedFrame = max(0, min(marker.frame, timeline.totalFrames))
                return TimelineMarkerCue(
                    id: marker.id,
                    frame: normalizedFrame,
                    timecode: timeline.sequence.framesToTimecode(normalizedFrame),
                    kind: TimelineMarkerCue.Kind(rawValue: marker.kind ?? "") ?? .marker,
                    label: marker.label.isEmpty ? "marker" : marker.label
                )
            }
            .sorted { lhs, rhs in
                if lhs.frame == rhs.frame { return lhs.id < rhs.id }
                return lhs.frame < rhs.frame
            }
        return ProjectTimelineMarkerMap(markers: markers)
    }
}

public struct TimelineMarkerCue: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case marker
        case beat
        case note
        case warning
        case chapter
    }

    public let id: String
    public let frame: Int
    public let timecode: String
    public let kind: Kind
    public let label: String
}
