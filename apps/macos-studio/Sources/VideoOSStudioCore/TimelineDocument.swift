import Foundation

public struct TimelineDocument: Decodable, Equatable, Sendable {
    public let version: String
    public let projectID: String
    public let sequence: TimelineSequence
    public let tracks: TimelineTrackCollection
    public let markers: [TimelineMarker]
    public let sourceHash: String?

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case sequence
        case tracks
        case markers
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(String.self, forKey: .version)
        projectID = try container.decode(String.self, forKey: .projectID)
        sequence = try container.decode(TimelineSequence.self, forKey: .sequence)
        tracks = try container.decode(TimelineTrackCollection.self, forKey: .tracks)
        markers = try container.decodeIfPresent([TimelineMarker].self, forKey: .markers) ?? []
        sourceHash = nil
    }

    public init(
        version: String,
        projectID: String,
        sequence: TimelineSequence,
        tracks: TimelineTrackCollection,
        markers: [TimelineMarker],
        sourceHash: String? = nil
    ) {
        self.version = version
        self.projectID = projectID
        self.sequence = sequence
        self.tracks = tracks
        self.markers = markers
        self.sourceHash = sourceHash
    }

    public var displayTracks: [TimelineTrack] {
        tracks.video + tracks.overlay + tracks.caption + tracks.audio
    }

    public var totalFrames: Int {
        let clipMax = displayTracks
            .flatMap(\.clips)
            .map { $0.timelineInFrame + $0.timelineDurationFrames }
            .max() ?? 0
        let markerMax = markers.map(\.frame).max() ?? 0
        return max(clipMax, markerMax, 1)
    }

    public var totalSeconds: Double {
        sequence.framesToSeconds(totalFrames)
    }

    public func clipSelection(for clipID: TimelineClip.ID?) -> TimelineClipSelection? {
        guard let clipID else { return nil }
        for track in displayTracks {
            if let clip = track.clips.first(where: { $0.id == clipID }) {
                return TimelineClipSelection(trackID: track.id, trackKind: track.kind, clip: clip)
            }
        }
        return nil
    }

    public func programSelection(atFrame frame: Int) -> TimelineClipSelection? {
        let normalizedFrame = max(0, min(frame, totalFrames))
        if let visualSelection = visualProgramSelection(atFrame: normalizedFrame) {
            return visualSelection
        }
        return audioProgramSelection(atFrame: normalizedFrame)
    }

    public func visualProgramSelection(atFrame frame: Int) -> TimelineClipSelection? {
        let normalizedFrame = max(0, min(frame, totalFrames))
        let visualTracks = Array((tracks.overlay + tracks.video).reversed())
        return selection(in: visualTracks, atFrame: normalizedFrame)
    }

    public func audioProgramSelection(atFrame frame: Int) -> TimelineClipSelection? {
        let normalizedFrame = max(0, min(frame, totalFrames))
        return selection(in: Array(tracks.audio.reversed()), atFrame: normalizedFrame)
    }

    private func selection(in orderedTracks: [TimelineTrack], atFrame frame: Int) -> TimelineClipSelection? {
        for track in orderedTracks {
            if let clip = track.clips
                .sorted(by: { $0.timelineInFrame < $1.timelineInFrame })
                .first(where: { $0.containsTimelineFrame(frame) }) {
                return TimelineClipSelection(trackID: track.id, trackKind: track.kind, clip: clip)
            }
        }
        return nil
    }

    public func programSelection(afterFrame frame: Int) -> TimelineClipSelection? {
        let normalizedFrame = max(0, min(frame, totalFrames))
        let currentClipID = programSelection(atFrame: normalizedFrame)?.clip.id
        let boundaries = Set(displayTracks.flatMap { track in
            track.clips.flatMap { clip in
                [clip.timelineInFrame, clip.timelineOutFrame]
            }
        })
        .filter { $0 > normalizedFrame && $0 <= totalFrames }
        .sorted()

        for boundary in boundaries {
            guard let selection = programSelection(atFrame: boundary) else { continue }
            if selection.clip.id != currentClipID {
                return selection
            }
        }

        return nil
    }

    public func monitorSnapshot(atFrame frame: Int) -> TimelineMonitorSnapshot {
        let normalizedFrame = max(0, min(frame, totalFrames))
        return TimelineMonitorSnapshot(
            frame: normalizedFrame,
            timecode: sequence.framesToTimecode(normalizedFrame),
            visual: visualProgramSelection(atFrame: normalizedFrame).map {
                TimelineMonitorClip(selection: $0, sourceTimeUS: $0.clip.sourceTimeUS(atTimelineFrame: normalizedFrame))
            },
            audio: audioProgramSelection(atFrame: normalizedFrame).map {
                TimelineMonitorClip(selection: $0, sourceTimeUS: $0.clip.sourceTimeUS(atTimelineFrame: normalizedFrame))
            },
            program: programSelection(atFrame: normalizedFrame).map {
                TimelineMonitorClip(selection: $0, sourceTimeUS: $0.clip.sourceTimeUS(atTimelineFrame: normalizedFrame))
            },
            nextProgram: programSelection(afterFrame: normalizedFrame).map {
                TimelineMonitorClip(selection: $0, sourceTimeUS: $0.clip.sourceTimeUS(atTimelineFrame: $0.clip.timelineInFrame))
            }
        )
    }

    public static func timelineURL(for projectURL: URL) -> URL {
        projectURL.appendingPathComponent("05_timeline/timeline.json")
    }

    public static func load(projectURL: URL) throws -> TimelineDocument {
        try load(from: timelineURL(for: projectURL))
    }

    public static func load(from url: URL) throws -> TimelineDocument {
        let data = try Data(contentsOf: url)
        let decoder = JSONDecoder()
        let document = try decoder.decode(TimelineDocument.self, from: data)
        return TimelineDocument(
            version: document.version,
            projectID: document.projectID,
            sequence: document.sequence,
            tracks: document.tracks,
            markers: document.markers,
            sourceHash: ProjectPlaybackContractStatusReader.fileHash16(data)
        )
    }
}

public struct TimelineSequence: Decodable, Equatable, Sendable {
    public let name: String
    public let fpsNum: Int
    public let fpsDen: Int
    public let width: Int
    public let height: Int
    public let startFrame: Int
    public let outputAspectRatio: String?

    enum CodingKeys: String, CodingKey {
        case name
        case fpsNum = "fps_num"
        case fpsDen = "fps_den"
        case width
        case height
        case startFrame = "start_frame"
        case outputAspectRatio = "output_aspect_ratio"
    }

    public var fps: Double {
        guard fpsDen > 0 else { return 30 }
        return Double(fpsNum) / Double(fpsDen)
    }

    public func framesToSeconds(_ frames: Int) -> Double {
        guard fps > 0 else { return 0 }
        return Double(frames) / fps
    }

    public func framesToTimecode(_ frames: Int) -> String {
        let fpsInt = max(1, Int(fps.rounded()))
        let normalized = max(0, frames + startFrame)
        let framePart = normalized % fpsInt
        let totalSeconds = normalized / fpsInt
        let seconds = totalSeconds % 60
        let minutes = (totalSeconds / 60) % 60
        let hours = totalSeconds / 3600
        return String(format: "%02d:%02d:%02d:%02d", hours, minutes, seconds, framePart)
    }
}

public struct TimelineTrackCollection: Decodable, Equatable, Sendable {
    public let video: [TimelineTrack]
    public let audio: [TimelineTrack]
    public let overlay: [TimelineTrack]
    public let caption: [TimelineTrack]

    enum CodingKeys: String, CodingKey {
        case video
        case audio
        case overlay
        case caption
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        video = try container.decodeIfPresent([TimelineTrack].self, forKey: .video) ?? []
        audio = try container.decodeIfPresent([TimelineTrack].self, forKey: .audio) ?? []
        overlay = try container.decodeIfPresent([TimelineTrack].self, forKey: .overlay) ?? []
        caption = try container.decodeIfPresent([TimelineTrack].self, forKey: .caption) ?? []
    }
}

public struct TimelineTrack: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: TimelineTrackKind
    public let clips: [TimelineClip]

    enum CodingKeys: String, CodingKey {
        case id = "track_id"
        case kind
        case clips
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decodeIfPresent(TimelineTrackKind.self, forKey: .kind) ?? TimelineTrackKind(inferredFromTrackID: id)
        clips = try container.decodeIfPresent([TimelineClip].self, forKey: .clips) ?? []
    }
}

public enum TimelineTrackKind: String, Decodable, Equatable, Sendable {
    case video
    case audio
    case overlay
    case caption

    init(inferredFromTrackID trackID: String) {
        switch trackID.uppercased().first {
        case "A": self = .audio
        case "O": self = .overlay
        case "C": self = .caption
        default: self = .video
        }
    }
}

public struct TimelineClip: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let segmentID: String
    public let assetID: String
    public let sourceInUS: Int?
    public let sourceOutUS: Int?
    public let timelineInFrame: Int
    public let timelineDurationFrames: Int
    public let role: String
    public let motivation: String
    public let confidence: Double?
    public let beatID: String?
    public let fallbackSegmentIDs: [String]
    public let qualityFlags: [String]
    public let candidateRef: String?

    enum CodingKeys: String, CodingKey {
        case id = "clip_id"
        case segmentID = "segment_id"
        case assetID = "asset_id"
        case sourceInUS = "src_in_us"
        case sourceOutUS = "src_out_us"
        case timelineInFrame = "timeline_in_frame"
        case timelineDurationFrames = "timeline_duration_frames"
        case role
        case motivation
        case confidence
        case beatID = "beat_id"
        case fallbackSegmentIDs = "fallback_segment_ids"
        case qualityFlags = "quality_flags"
        case candidateRef = "candidate_ref"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        segmentID = try container.decode(String.self, forKey: .segmentID)
        assetID = try container.decode(String.self, forKey: .assetID)
        sourceInUS = try container.decodeIfPresent(Int.self, forKey: .sourceInUS)
        sourceOutUS = try container.decodeIfPresent(Int.self, forKey: .sourceOutUS)
        timelineInFrame = try container.decode(Int.self, forKey: .timelineInFrame)
        timelineDurationFrames = try container.decode(Int.self, forKey: .timelineDurationFrames)
        role = try container.decode(String.self, forKey: .role)
        motivation = try container.decode(String.self, forKey: .motivation)
        confidence = try container.decodeIfPresent(Double.self, forKey: .confidence)
        beatID = try container.decodeIfPresent(String.self, forKey: .beatID)
        fallbackSegmentIDs = try container.decodeIfPresent([String].self, forKey: .fallbackSegmentIDs) ?? []
        qualityFlags = try container.decodeIfPresent([String].self, forKey: .qualityFlags) ?? []
        candidateRef = try container.decodeIfPresent(String.self, forKey: .candidateRef)
    }

    public var timelineOutFrame: Int {
        timelineInFrame + timelineDurationFrames
    }

    public var sourceDurationSeconds: Double? {
        guard let sourceInUS, let sourceOutUS, sourceOutUS >= sourceInUS else { return nil }
        return Double(sourceOutUS - sourceInUS) / 1_000_000
    }

    public func containsTimelineFrame(_ frame: Int) -> Bool {
        timelineInFrame <= frame && frame < timelineOutFrame
    }

    public func sourceTimeUS(atTimelineFrame frame: Int) -> Int? {
        guard let sourceInUS, let sourceOutUS else { return sourceInUS }
        let sourceDurationUS = max(0, sourceOutUS - sourceInUS)
        guard sourceDurationUS > 0, timelineDurationFrames > 0 else { return sourceInUS }
        let frameOffset = max(0, min(frame - timelineInFrame, timelineDurationFrames))
        let ratio = Double(frameOffset) / Double(timelineDurationFrames)
        return sourceInUS + Int((Double(sourceDurationUS) * ratio).rounded())
    }
}

public struct TimelineClipSelection: Equatable, Sendable {
    public let trackID: String
    public let trackKind: TimelineTrackKind
    public let clip: TimelineClip
}

public struct TimelineMonitorSnapshot: Equatable, Sendable {
    public let frame: Int
    public let timecode: String
    public let visual: TimelineMonitorClip?
    public let audio: TimelineMonitorClip?
    public let program: TimelineMonitorClip?
    public let nextProgram: TimelineMonitorClip?
}

public struct TimelineMonitorClip: Equatable, Sendable {
    public let trackID: String
    public let trackKind: TimelineTrackKind
    public let clipID: String
    public let assetID: String
    public let sourceTimeUS: Int?

    public init(selection: TimelineClipSelection, sourceTimeUS: Int?) {
        trackID = selection.trackID
        trackKind = selection.trackKind
        clipID = selection.clip.id
        assetID = selection.clip.assetID
        self.sourceTimeUS = sourceTimeUS
    }
}

public struct TimelinePlaybackSyncState: Equatable, Sendable {
    public private(set) var generation: Int
    public private(set) var lastProgramClipID: TimelineClip.ID?

    public init(generation: Int = 0, lastProgramClipID: TimelineClip.ID? = nil) {
        self.generation = generation
        self.lastProgramClipID = lastProgramClipID
    }

    @discardableResult
    public mutating func update(timeline: TimelineDocument?, frame: Int, forceSeek: Bool) -> Int {
        let currentClipID = timeline?.programSelection(atFrame: frame)?.clip.id
        return update(currentClipID: currentClipID, forceSeek: forceSeek)
    }

    @discardableResult
    public mutating func update(currentClipID: TimelineClip.ID?, forceSeek: Bool) -> Int {
        if forceSeek || currentClipID != lastProgramClipID {
            generation &+= 1
        }
        lastProgramClipID = currentClipID
        return generation
    }
}

public struct TimelineMarker: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let frame: Int
    public let label: String
    public let kind: String?

    enum CodingKeys: String, CodingKey {
        case id = "marker_id"
        case frame
        case label
        case kind
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        frame = try container.decode(Int.self, forKey: .frame)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? ""
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? "\(kind ?? "marker")-\(frame)-\(label)"
    }
}
