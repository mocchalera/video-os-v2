import Foundation

public struct ProjectEvidenceStore: Sendable {
    public let assets: AnalysisAssetDocument?
    public let segments: AnalysisSegmentDocument?
    public let marlinEvents: MarlinEventDocument?
    public let audioEvents: AudioEventDocument?
    public let bgmAnalysis: BGMAnalysisDocument?
    public let audioStoryGraph: AudioStoryGraphDocument?
    public let transcripts: [String: TranscriptDocument]

    public static func load(projectURL: URL) -> ProjectEvidenceStore {
        let assets = try? AnalysisAssetDocument.load(from: projectURL.appendingPathComponent("03_analysis/assets.json"))
        let segments = try? AnalysisSegmentDocument.load(from: projectURL.appendingPathComponent("03_analysis/segments.json"))
        let marlinEvents = try? MarlinEventDocument.load(from: projectURL.appendingPathComponent("03_analysis/marlin_events.json"))
        let audioEvents = try? AudioEventDocument.load(from: projectURL.appendingPathComponent("03_analysis/audio_events.json"))
        let bgmAnalysis = try? BGMAnalysisDocument.load(from: projectURL.appendingPathComponent("03_analysis/bgm_analysis.json"))
        let audioStoryGraph = try? AudioStoryGraphDocument.load(from: projectURL.appendingPathComponent("03_analysis/audio_story_graph.json"))
        let transcripts = loadTranscripts(projectURL: projectURL, assets: assets)
        return ProjectEvidenceStore(
            assets: assets,
            segments: segments,
            marlinEvents: marlinEvents,
            audioEvents: audioEvents,
            bgmAnalysis: bgmAnalysis,
            audioStoryGraph: audioStoryGraph,
            transcripts: transcripts
        )
    }

    public func evidence(for clip: TimelineClip) -> ClipEvidence {
        let asset = assets?.items.first { $0.id == clip.assetID }
        let segment = segments?.items.first { $0.id == clip.segmentID }
        let transcriptRef = asset?.transcriptRef ?? segment?.transcriptRef
        let transcriptItems = transcriptRef
            .flatMap { transcripts[$0]?.items(overlapping: clip.sourceInUS ?? segment?.sourceInUS, clip.sourceOutUS ?? segment?.sourceOutUS) } ?? []
        let marlinAsset = marlinEvents?.items.first { $0.assetID == clip.assetID }
        let marlinEvents = marlinAsset?.events(overlapping: clip.sourceInUS ?? segment?.sourceInUS, clip.sourceOutUS ?? segment?.sourceOutUS) ?? []
        let marlinFindResults = marlinAsset?.findResults(overlapping: clip.sourceInUS ?? segment?.sourceInUS, clip.sourceOutUS ?? segment?.sourceOutUS) ?? []
        let audioEvents = audioEvents?.items(overlappingAssetID: clip.assetID, startUS: clip.sourceInUS ?? segment?.sourceInUS, endUS: clip.sourceOutUS ?? segment?.sourceOutUS) ?? []
        let audioNodes = audioStoryGraph?.nodes(overlappingAssetID: clip.assetID, startUS: clip.sourceInUS ?? segment?.sourceInUS, endUS: clip.sourceOutUS ?? segment?.sourceOutUS) ?? []
        let bgmSections = bgmAnalysis?.sections(overlappingStartUS: clip.sourceInUS ?? segment?.sourceInUS, endUS: clip.sourceOutUS ?? segment?.sourceOutUS) ?? []

        return ClipEvidence(
            asset: asset,
            segment: segment,
            transcriptItems: transcriptItems,
            marlinAsset: marlinAsset,
            marlinEvents: marlinEvents,
            marlinFindResults: marlinFindResults,
            audioEvents: audioEvents,
            audioStoryNodes: audioNodes,
            bgmSections: bgmSections
        )
    }

    private static func loadTranscripts(projectURL: URL, assets: AnalysisAssetDocument?) -> [String: TranscriptDocument] {
        let refs = Set(assets?.items.compactMap(\.transcriptRef) ?? [])
        let transcriptDir = projectURL.appendingPathComponent("03_analysis/transcripts")
        var loaded: [String: TranscriptDocument] = [:]

        for ref in refs {
            let url = transcriptDir.appendingPathComponent("\(ref).json")
            if let document = try? TranscriptDocument.load(from: url) {
                loaded[ref] = document
            }
        }
        return loaded
    }
}

public struct ClipEvidence: Equatable, Sendable {
    public let asset: AnalysisAsset?
    public let segment: AnalysisSegment?
    public let transcriptItems: [TranscriptItem]
    public let marlinAsset: MarlinAssetEvents?
    public let marlinEvents: [MarlinEvent]
    public let marlinFindResults: [MarlinFindResult]
    public let audioEvents: [AudioEvent]
    public let audioStoryNodes: [AudioStoryNode]
    public let bgmSections: [BGMSection]

    public var hasAnalysis: Bool {
        asset != nil || segment != nil || !transcriptItems.isEmpty || marlinAsset != nil || !audioEvents.isEmpty || !audioStoryNodes.isEmpty || !bgmSections.isEmpty
    }
}

public struct AnalysisAssetDocument: Decodable, Equatable, Sendable {
    public let projectID: String
    public let artifactVersion: String
    public let items: [AnalysisAsset]

    enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case artifactVersion = "artifact_version"
        case items
    }

    public static func load(from url: URL) throws -> AnalysisAssetDocument {
        try JSONDecoder().decode(AnalysisAssetDocument.self, from: Data(contentsOf: url))
    }
}

public struct AnalysisAsset: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let filename: String
    public let roleGuess: String?
    public let durationUS: Int?
    public let sourceLocator: String?
    public let posterPath: String?
    public let keyFramePath: String?
    public let hasTranscript: Bool
    public let transcriptRef: String?
    public let segmentIDs: [String]
    public let qualityFlags: [String]
    public let tags: [String]

    enum CodingKeys: String, CodingKey {
        case id = "asset_id"
        case filename
        case roleGuess = "role_guess"
        case durationUS = "duration_us"
        case sourceLocator = "source_locator"
        case posterPath = "poster_path"
        case keyFramePath = "key_frame_path"
        case hasTranscript = "has_transcript"
        case transcriptRef = "transcript_ref"
        case segmentIDs = "segment_ids"
        case qualityFlags = "quality_flags"
        case tags
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        filename = try container.decode(String.self, forKey: .filename)
        roleGuess = try container.decodeIfPresent(String.self, forKey: .roleGuess)
        durationUS = try container.decodeIfPresent(Int.self, forKey: .durationUS)
        sourceLocator = try container.decodeIfPresent(String.self, forKey: .sourceLocator)
        posterPath = try container.decodeIfPresent(String.self, forKey: .posterPath)
        keyFramePath = try container.decodeIfPresent(String.self, forKey: .keyFramePath)
        hasTranscript = try container.decodeIfPresent(Bool.self, forKey: .hasTranscript) ?? false
        transcriptRef = try container.decodeIfPresent(String.self, forKey: .transcriptRef)
        segmentIDs = try container.decodeIfPresent([String].self, forKey: .segmentIDs) ?? []
        qualityFlags = try container.decodeIfPresent([String].self, forKey: .qualityFlags) ?? []
        tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
    }
}

public struct AnalysisSegmentDocument: Decodable, Equatable, Sendable {
    public let projectID: String
    public let artifactVersion: String
    public let items: [AnalysisSegment]

    enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case artifactVersion = "artifact_version"
        case items
    }

    public static func load(from url: URL) throws -> AnalysisSegmentDocument {
        try JSONDecoder().decode(AnalysisSegmentDocument.self, from: Data(contentsOf: url))
    }
}

public struct AnalysisSegment: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let assetID: String
    public let sourceInUS: Int
    public let sourceOutUS: Int
    public let summary: String
    public let transcriptExcerpt: String
    public let transcriptRef: String?
    public let qualityFlags: [String]
    public let tags: [String]
    public let interestPoints: [SegmentInterestPoint]
    public let peakAnalysis: SegmentPeakAnalysis?

    enum CodingKeys: String, CodingKey {
        case id = "segment_id"
        case assetID = "asset_id"
        case sourceInUS = "src_in_us"
        case sourceOutUS = "src_out_us"
        case summary
        case transcriptExcerpt = "transcript_excerpt"
        case transcriptRef = "transcript_ref"
        case qualityFlags = "quality_flags"
        case tags
        case interestPoints = "interest_points"
        case peakAnalysis = "peak_analysis"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        assetID = try container.decode(String.self, forKey: .assetID)
        sourceInUS = try container.decode(Int.self, forKey: .sourceInUS)
        sourceOutUS = try container.decode(Int.self, forKey: .sourceOutUS)
        summary = try container.decodeIfPresent(String.self, forKey: .summary) ?? ""
        transcriptExcerpt = try container.decodeIfPresent(String.self, forKey: .transcriptExcerpt) ?? ""
        transcriptRef = try container.decodeIfPresent(String.self, forKey: .transcriptRef)
        qualityFlags = try container.decodeIfPresent([String].self, forKey: .qualityFlags) ?? []
        tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
        interestPoints = try container.decodeIfPresent([SegmentInterestPoint].self, forKey: .interestPoints) ?? []
        peakAnalysis = try container.decodeIfPresent(SegmentPeakAnalysis.self, forKey: .peakAnalysis)
    }
}

public struct SegmentInterestPoint: Decodable, Equatable, Sendable {
    public let frameUS: Int?
    public let label: String
    public let confidence: Double?
    public let source: String?

    enum CodingKeys: String, CodingKey {
        case frameUS = "frame_us"
        case label
        case confidence
        case source
    }
}

public struct SegmentPeakAnalysis: Decodable, Equatable, Sendable {
    public let selectedPeakUS: Int?
    public let confidence: Double?
    public let supportSignals: SegmentPeakSupportSignals?
    public let provenance: SegmentPeakProvenance?

    enum CodingKeys: String, CodingKey {
        case selectedPeakUS = "selected_peak_us"
        case confidence
        case supportSignals = "support_signals"
        case provenance
    }
}

public struct SegmentPeakSupportSignals: Decodable, Equatable, Sendable {
    public let fusedPeakScore: Double?

    enum CodingKeys: String, CodingKey {
        case fusedPeakScore = "fused_peak_score"
    }
}

public struct SegmentPeakProvenance: Decodable, Equatable, Sendable {
    public let precisionMode: String?
    public let fusionVersion: String?

    enum CodingKeys: String, CodingKey {
        case precisionMode = "precision_mode"
        case fusionVersion = "fusion_version"
    }
}

public struct TranscriptDocument: Decodable, Equatable, Sendable {
    public let projectID: String
    public let artifactVersion: String
    public let transcriptRef: String
    public let assetID: String
    public let items: [TranscriptItem]

    enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case artifactVersion = "artifact_version"
        case transcriptRef = "transcript_ref"
        case assetID = "asset_id"
        case items
    }

    public static func load(from url: URL) throws -> TranscriptDocument {
        try JSONDecoder().decode(TranscriptDocument.self, from: Data(contentsOf: url))
    }

    public func items(overlapping startUS: Int?, _ endUS: Int?) -> [TranscriptItem] {
        guard let startUS, let endUS else { return [] }
        return items.filter { $0.overlaps(startUS: startUS, endUS: endUS) }
    }
}

public struct TranscriptItem: Decodable, Identifiable, Equatable, Sendable {
    public var id: String { "\(speaker):\(startUS)-\(endUS)" }
    public let speaker: String
    public let speakerKey: String?
    public let startUS: Int
    public let endUS: Int
    public let text: String

    enum CodingKeys: String, CodingKey {
        case speaker
        case speakerKey = "speaker_key"
        case startUS = "start_us"
        case endUS = "end_us"
        case text
    }

    public func overlaps(startUS: Int, endUS: Int) -> Bool {
        self.startUS < endUS && self.endUS > startUS
    }
}

public struct MarlinEventDocument: Decodable, Equatable, Sendable {
    public let projectID: String
    public let artifactVersion: String
    public let model: MarlinModelRecord
    public let items: [MarlinAssetEvents]

    enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case artifactVersion = "artifact_version"
        case model
        case items
    }

    public static func load(from url: URL) throws -> MarlinEventDocument {
        try JSONDecoder().decode(MarlinEventDocument.self, from: Data(contentsOf: url))
    }
}

public struct MarlinModelRecord: Decodable, Equatable, Sendable {
    public let provider: String
    public let modelAlias: String
    public let modelSnapshot: String
    public let connectorVersion: String?
    public let inferenceMode: String?

    enum CodingKeys: String, CodingKey {
        case provider
        case modelAlias = "model_alias"
        case modelSnapshot = "model_snapshot"
        case connectorVersion = "connector_version"
        case inferenceMode = "inference_mode"
    }
}

public struct MarlinAssetEvents: Decodable, Equatable, Sendable {
    public let assetID: String
    public let sourcePath: String
    public let scene: String
    public let caption: String?
    public let events: [MarlinEvent]
    public let findResults: [MarlinFindResult]

    enum CodingKeys: String, CodingKey {
        case assetID = "asset_id"
        case sourcePath = "source_path"
        case scene
        case caption
        case events
        case findResults = "find_results"
    }

    public func events(overlapping startUS: Int?, _ endUS: Int?) -> [MarlinEvent] {
        guard let startUS, let endUS else { return [] }
        return events.filter { $0.overlaps(startUS: startUS, endUS: endUS) }
    }

    public func findResults(overlapping startUS: Int?, _ endUS: Int?) -> [MarlinFindResult] {
        guard let startUS, let endUS else { return [] }
        return findResults.filter { $0.overlaps(startUS: startUS, endUS: endUS) }
    }
}

public struct MarlinEvent: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let startUS: Int
    public let endUS: Int
    public let description: String
    public let confidence: Double?
    public let sourcePass: String?
    public let chunkIndex: Int?

    enum CodingKeys: String, CodingKey {
        case id = "event_id"
        case startUS = "start_us"
        case endUS = "end_us"
        case description
        case confidence
        case sourcePass = "source_pass"
        case chunkIndex = "chunk_index"
    }

    public func overlaps(startUS: Int, endUS: Int) -> Bool {
        self.startUS < endUS && self.endUS > startUS
    }
}

public struct MarlinFindResult: Decodable, Identifiable, Equatable, Sendable {
    public var id: String { "\(query):\(spanStartUS ?? -1)-\(spanEndUS ?? -1)" }
    public let query: String
    public let spanStartUS: Int?
    public let spanEndUS: Int?
    public let formatOK: Bool
    public let confidence: Double?
    public let raw: String?

    enum CodingKeys: String, CodingKey {
        case query
        case spanStartUS = "span_start_us"
        case spanEndUS = "span_end_us"
        case formatOK = "format_ok"
        case confidence
        case raw
    }

    public func overlaps(startUS: Int, endUS: Int) -> Bool {
        guard let spanStartUS, let spanEndUS else { return false }
        return spanStartUS < endUS && spanEndUS > startUS
    }
}

public struct AudioEventDocument: Decodable, Equatable, Sendable {
    public let projectID: String
    public let artifactVersion: String
    public let items: [AudioEvent]

    enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case artifactVersion = "artifact_version"
        case items
    }

    public static func load(from url: URL) throws -> AudioEventDocument {
        try JSONDecoder().decode(AudioEventDocument.self, from: Data(contentsOf: url))
    }

    public func items(overlappingAssetID assetID: String, startUS: Int?, endUS: Int?) -> [AudioEvent] {
        guard let startUS, let endUS else { return [] }
        return items.filter { $0.assetID == assetID && $0.overlaps(startUS: startUS, endUS: endUS) }
    }
}

public struct AudioEvent: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let assetID: String
    public let type: String
    public let startUS: Int
    public let endUS: Int
    public let label: String?
    public let confidence: ConfidenceRecord?

    enum CodingKeys: String, CodingKey {
        case id = "event_id"
        case assetID = "asset_id"
        case type
        case startUS = "start_us"
        case endUS = "end_us"
        case label
        case confidence
    }

    public func overlaps(startUS: Int, endUS: Int) -> Bool {
        self.startUS < endUS && self.endUS > startUS
    }
}

public struct ConfidenceRecord: Decodable, Equatable, Sendable {
    public let score: Double?
    public let source: String?
    public let status: String?
    public let label: String?
}

public struct BGMAnalysisDocument: Decodable, Equatable, Sendable {
    public let version: String
    public let projectID: String
    public let analysisStatus: String
    public let musicAsset: BGMMusicAsset
    public let bpm: Double
    public let meter: String
    public let durationSec: Double
    public let beatsSec: [Double]
    public let downbeatsSec: [Double]
    public let sections: [BGMSection]
    public let beats: [BGMBeat]

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case analysisStatus = "analysis_status"
        case musicAsset = "music_asset"
        case bpm
        case meter
        case durationSec = "duration_sec"
        case beatsSec = "beats_sec"
        case downbeatsSec = "downbeats_sec"
        case sections
        case beats
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(String.self, forKey: .version)
        projectID = try container.decode(String.self, forKey: .projectID)
        analysisStatus = try container.decode(String.self, forKey: .analysisStatus)
        musicAsset = try container.decode(BGMMusicAsset.self, forKey: .musicAsset)
        bpm = try container.decode(Double.self, forKey: .bpm)
        meter = try container.decode(String.self, forKey: .meter)
        durationSec = try container.decode(Double.self, forKey: .durationSec)
        beatsSec = try container.decode([Double].self, forKey: .beatsSec)
        downbeatsSec = try container.decode([Double].self, forKey: .downbeatsSec)
        sections = try container.decode([BGMSection].self, forKey: .sections)
        beats = try container.decodeIfPresent([BGMBeat].self, forKey: .beats) ?? beatsSec.map { BGMBeat(timeSec: $0, strength: nil) }
    }

    public static func load(from url: URL) throws -> BGMAnalysisDocument {
        try JSONDecoder().decode(BGMAnalysisDocument.self, from: Data(contentsOf: url))
    }

    public func sections(overlappingStartUS startUS: Int?, endUS: Int?) -> [BGMSection] {
        guard let startUS, let endUS else { return [] }
        let startSec = Double(startUS) / 1_000_000
        let endSec = Double(endUS) / 1_000_000
        return sections.filter { $0.startSec < endSec && $0.endSec > startSec }
    }
}

public struct BGMMusicAsset: Decodable, Equatable, Sendable {
    public let assetID: String
    public let path: String
    public let sourceHash: String?

    enum CodingKeys: String, CodingKey {
        case assetID = "asset_id"
        case path
        case sourceHash = "source_hash"
    }
}

public struct BGMSection: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let startSec: Double
    public let endSec: Double
    public let energy: Double

    enum CodingKeys: String, CodingKey {
        case id
        case label
        case startSec = "start_sec"
        case endSec = "end_sec"
        case energy
    }
}

public struct BGMBeat: Decodable, Equatable, Sendable {
    public let timeSec: Double
    public let strength: Double?

    enum CodingKeys: String, CodingKey {
        case timeSec = "time_sec"
        case strength
    }

    public init(timeSec: Double, strength: Double?) {
        self.timeSec = timeSec
        self.strength = strength
    }
}

public struct AudioStoryGraphDocument: Decodable, Equatable, Sendable {
    public let version: String
    public let projectID: String
    public let artifactVersion: String
    public let nodes: [AudioStoryNode]
    public let edges: [AudioStoryEdge]

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case artifactVersion = "artifact_version"
        case nodes
        case edges
    }

    public static func load(from url: URL) throws -> AudioStoryGraphDocument {
        try JSONDecoder().decode(AudioStoryGraphDocument.self, from: Data(contentsOf: url))
    }

    public func nodes(overlappingAssetID assetID: String, startUS: Int?, endUS: Int?) -> [AudioStoryNode] {
        guard let startUS, let endUS else { return [] }
        return nodes.filter { $0.assetID == assetID && $0.overlaps(startUS: startUS, endUS: endUS) }
    }
}

public struct AudioStoryNode: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let type: String
    public let assetID: String
    public let startUS: Int
    public let endUS: Int
    public let text: String?
    public let storyRole: String?
    public let refs: AudioStoryRefs
    public let confidence: ConfidenceRecord

    enum CodingKeys: String, CodingKey {
        case id = "node_id"
        case type = "node_type"
        case assetID = "asset_id"
        case startUS = "start_us"
        case endUS = "end_us"
        case text
        case storyRole = "story_role"
        case refs
        case confidence
    }

    public func overlaps(startUS: Int, endUS: Int) -> Bool {
        self.startUS < endUS && self.endUS > startUS
    }
}

public struct AudioStoryRefs: Decodable, Equatable, Sendable {
    public let transcriptRef: String?
    public let speakerRef: String?
    public let audioEventRef: String?
    public let bgmRef: String?

    enum CodingKeys: String, CodingKey {
        case transcriptRef = "transcript_ref"
        case speakerRef = "speaker_ref"
        case audioEventRef = "audio_event_ref"
        case bgmRef = "bgm_ref"
    }
}

public struct AudioStoryEdge: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let fromNodeID: String
    public let toNodeID: String
    public let type: String

    enum CodingKeys: String, CodingKey {
        case id = "edge_id"
        case fromNodeID = "from_node_id"
        case toNodeID = "to_node_id"
        case type
    }
}
