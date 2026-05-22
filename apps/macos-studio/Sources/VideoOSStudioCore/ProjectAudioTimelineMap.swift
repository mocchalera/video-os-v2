import Foundation

public struct ProjectAudioTimelineMap: Equatable, Sendable {
    public let cues: [TimelineAudioCue]

    public static func build(timeline: TimelineDocument, evidence: ProjectEvidenceStore?) -> ProjectAudioTimelineMap {
        guard let evidence else { return ProjectAudioTimelineMap(cues: []) }

        var cues: [TimelineAudioCue] = []
        let downbeatUS = Set(evidence.bgmAnalysis?.downbeatsSec.map { microseconds(fromSeconds: $0) } ?? [])

        for track in timeline.tracks.audio {
            for clip in track.clips {
                guard let sourceInUS = clip.sourceInUS, let sourceOutUS = clip.sourceOutUS, sourceOutUS > sourceInUS else {
                    continue
                }

                for event in evidence.audioEvents?.items(overlappingAssetID: clip.assetID, startUS: sourceInUS, endUS: sourceOutUS) ?? [] {
                    cues.append(TimelineAudioCue(
                        id: "audio-event:\(track.id):\(clip.id):\(event.id)",
                        kind: .audioEvent,
                        trackID: track.id,
                        clipID: clip.id,
                        assetID: clip.assetID,
                        frame: frame(forSourceUS: event.startUS, clip: clip, sourceInUS: sourceInUS, sourceOutUS: sourceOutUS),
                        endFrame: frame(forSourceUS: event.endUS, clip: clip, sourceInUS: sourceInUS, sourceOutUS: sourceOutUS),
                        label: event.label?.isEmpty == false ? event.label ?? event.type : event.type,
                        detail: event.type,
                        intensity: event.confidence?.score
                    ))
                }

                for node in evidence.audioStoryGraph?.nodes(overlappingAssetID: clip.assetID, startUS: sourceInUS, endUS: sourceOutUS) ?? [] {
                    cues.append(TimelineAudioCue(
                        id: "audio-story:\(track.id):\(clip.id):\(node.id)",
                        kind: .audioStory,
                        trackID: track.id,
                        clipID: clip.id,
                        assetID: clip.assetID,
                        frame: frame(forSourceUS: node.startUS, clip: clip, sourceInUS: sourceInUS, sourceOutUS: sourceOutUS),
                        endFrame: frame(forSourceUS: node.endUS, clip: clip, sourceInUS: sourceInUS, sourceOutUS: sourceOutUS),
                        label: node.text?.isEmpty == false ? node.text ?? node.id : node.id,
                        detail: [node.type, node.storyRole].compactMap { $0 }.joined(separator: " / "),
                        intensity: node.confidence.score
                    ))
                }

                if let bgm = evidence.bgmAnalysis, bgm.musicAsset.assetID == clip.assetID {
                    for section in bgm.sections(overlappingStartUS: sourceInUS, endUS: sourceOutUS) {
                        let startUS = microseconds(fromSeconds: section.startSec)
                        let endUS = microseconds(fromSeconds: section.endSec)
                        cues.append(TimelineAudioCue(
                            id: "bgm-section:\(track.id):\(clip.id):\(section.id)",
                            kind: .bgmSection,
                            trackID: track.id,
                            clipID: clip.id,
                            assetID: clip.assetID,
                            frame: frame(forSourceUS: startUS, clip: clip, sourceInUS: sourceInUS, sourceOutUS: sourceOutUS),
                            endFrame: frame(forSourceUS: endUS, clip: clip, sourceInUS: sourceInUS, sourceOutUS: sourceOutUS),
                            label: section.label,
                            detail: "BGM section",
                            intensity: section.energy
                        ))
                    }

                    for (index, beat) in bgm.beats.enumerated() {
                        let beatUS = microseconds(fromSeconds: beat.timeSec)
                        guard beatUS >= sourceInUS, beatUS <= sourceOutUS else { continue }
                        let isDownbeat = downbeatUS.contains(beatUS)
                        cues.append(TimelineAudioCue(
                            id: "bgm-beat:\(track.id):\(clip.id):\(index + 1)",
                            kind: isDownbeat ? .bgmDownbeat : .bgmBeat,
                            trackID: track.id,
                            clipID: clip.id,
                            assetID: clip.assetID,
                            frame: frame(forSourceUS: beatUS, clip: clip, sourceInUS: sourceInUS, sourceOutUS: sourceOutUS),
                            endFrame: nil,
                            label: isDownbeat ? "downbeat \(index + 1)" : "beat \(index + 1)",
                            detail: beat.strength.map { "strength \($0)" },
                            intensity: beat.strength
                        ))
                    }
                }
            }
        }

        return ProjectAudioTimelineMap(cues: cues.sorted { lhs, rhs in
            if lhs.frame == rhs.frame { return lhs.id < rhs.id }
            return lhs.frame < rhs.frame
        })
    }

    private static func frame(forSourceUS sourceUS: Int, clip: TimelineClip, sourceInUS: Int, sourceOutUS: Int) -> Int {
        let sourceDurationUS = max(1, sourceOutUS - sourceInUS)
        let clampedSourceUS = max(sourceInUS, min(sourceUS, sourceOutUS))
        let ratio = Double(clampedSourceUS - sourceInUS) / Double(sourceDurationUS)
        let frame = clip.timelineInFrame + Int((Double(clip.timelineDurationFrames) * ratio).rounded())
        return max(clip.timelineInFrame, min(frame, clip.timelineOutFrame))
    }

    private static func microseconds(fromSeconds seconds: Double) -> Int {
        Int((seconds * 1_000_000).rounded())
    }
}

public struct TimelineAudioCue: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case audioEvent = "audio-event"
        case audioStory = "audio-story"
        case bgmBeat = "bgm-beat"
        case bgmDownbeat = "bgm-downbeat"
        case bgmSection = "bgm-section"
    }

    public let id: String
    public let kind: Kind
    public let trackID: String
    public let clipID: String
    public let assetID: String
    public let frame: Int
    public let endFrame: Int?
    public let label: String
    public let detail: String?
    public let intensity: Double?
}
