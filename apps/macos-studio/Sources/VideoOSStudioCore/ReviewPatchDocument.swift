import Foundation

public struct ReviewPatchDocument: Codable, Equatable, Sendable {
    public let timeline_version: String
    public let operations: [ReviewPatchOperation]

    public init(timeline_version: String, operations: [ReviewPatchOperation]) {
        self.timeline_version = timeline_version
        self.operations = operations
    }
}

public struct ReviewVisualTransform: Codable, Equatable, Sendable {
    public struct Crop: Codable, Equatable, Sendable {
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double

        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }
    }

    public struct Position: Codable, Equatable, Sendable {
        public let x: Double
        public let y: Double

        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    public let zoom: Double?
    public let crop: Crop?
    public let position: Position?

    public init(zoom: Double? = nil, crop: Crop? = nil, position: Position? = nil) {
        self.zoom = zoom
        self.crop = crop
        self.position = position
    }

    var isValid: Bool {
        let zoomValid = zoom.map { $0.isFinite && (0.1...8).contains($0) } ?? true
        let cropValid = crop.map {
            $0.x.isFinite && $0.x >= 0
                && $0.y.isFinite && $0.y >= 0
                && $0.width.isFinite && $0.width > 0
                && $0.height.isFinite && $0.height > 0
        } ?? true
        let positionValid = position.map { $0.x.isFinite && $0.y.isFinite } ?? true
        return zoom != nil || crop != nil || position != nil
            ? zoomValid && cropValid && positionValid
            : false
    }
}

public struct ReviewAudioFinish: Codable, Equatable, Sendable {
    public let preset: String
    public let loudness_target_lufs: Double?
    public let lra_target: Double?
    public let true_peak_target_dbtp: Double?
    public let codec_headroom_db: Double?
    public let highpass_hz: Double?
    public let lowpass_hz: Double?
    public let noise_reduction_db: Double?
    public let noise_floor_db: Double?
    public let mud_cut_db: Double?
    public let presence_gain_db: Double?
    public let compressor_threshold_db: Double?
    public let compressor_ratio: Double?
    public let compressor_attack_ms: Double?
    public let compressor_release_ms: Double?
    public let compressor_makeup_db: Double?

    public init(
        preset: String,
        loudness_target_lufs: Double? = nil,
        lra_target: Double? = nil,
        true_peak_target_dbtp: Double? = nil,
        codec_headroom_db: Double? = nil,
        highpass_hz: Double? = nil,
        lowpass_hz: Double? = nil,
        noise_reduction_db: Double? = nil,
        noise_floor_db: Double? = nil,
        mud_cut_db: Double? = nil,
        presence_gain_db: Double? = nil,
        compressor_threshold_db: Double? = nil,
        compressor_ratio: Double? = nil,
        compressor_attack_ms: Double? = nil,
        compressor_release_ms: Double? = nil,
        compressor_makeup_db: Double? = nil
    ) {
        self.preset = preset
        self.loudness_target_lufs = loudness_target_lufs
        self.lra_target = lra_target
        self.true_peak_target_dbtp = true_peak_target_dbtp
        self.codec_headroom_db = codec_headroom_db
        self.highpass_hz = highpass_hz
        self.lowpass_hz = lowpass_hz
        self.noise_reduction_db = noise_reduction_db
        self.noise_floor_db = noise_floor_db
        self.mud_cut_db = mud_cut_db
        self.presence_gain_db = presence_gain_db
        self.compressor_threshold_db = compressor_threshold_db
        self.compressor_ratio = compressor_ratio
        self.compressor_attack_ms = compressor_attack_ms
        self.compressor_release_ms = compressor_release_ms
        self.compressor_makeup_db = compressor_makeup_db
    }

    var isValid: Bool {
        guard ["dialogue-clean", "loudness-only", "none"].contains(preset) else { return false }
        return Self.inRange(loudness_target_lufs, -24 ... -8)
            && Self.inRange(lra_target, 1 ... 20)
            && Self.inRange(true_peak_target_dbtp, -6 ... -0.1)
            && Self.inRange(codec_headroom_db, 0 ... 3)
            && Self.inRange(highpass_hz, 20 ... 300)
            && Self.inRange(lowpass_hz, 5_000 ... 22_000)
            && Self.inRange(noise_reduction_db, 0 ... 30)
            && Self.inRange(noise_floor_db, -80 ... -20)
            && Self.inRange(mud_cut_db, -12 ... 0)
            && Self.inRange(presence_gain_db, 0 ... 8)
            && Self.inRange(compressor_threshold_db, -60 ... -1)
            && Self.inRange(compressor_ratio, 1 ... 12)
            && Self.inRange(compressor_attack_ms, 0.1 ... 500)
            && Self.inRange(compressor_release_ms, 10 ... 3_000)
            && Self.inRange(compressor_makeup_db, 0 ... 18)
    }

    private static func inRange(_ value: Double?, _ range: ClosedRange<Double>) -> Bool {
        value.map { $0.isFinite && range.contains($0) } ?? true
    }
}

public enum ReviewPatchOperation: Codable, Equatable, Sendable {
    case replaceSegment(target_clip_id: String, with_segment_id: String, with_candidate_ref: String?, new_src_in_us: Int?, new_src_out_us: Int?, reason: String)
    case trimSegment(target_clip_id: String, new_src_in_us: Int, new_src_out_us: Int, reason: String)
    case moveSegment(target_clip_id: String, new_timeline_in_frame: Int, new_duration_frames: Int?, target_track_id: String?, reason: String)
    case splitSegment(target_clip_id: String, split_timeline_frame: Int, reason: String)
    case setTransition(from_clip_id: String, to_clip_id: String, track_id: String, transition_type: String, transition_frames: Int, applied_skill_id: String?, reason: String)
    case insertSegment(beat_id: String, segment_id: String, role: String, new_timeline_in_frame: Int, new_duration_frames: Int, target_track_id: String?, new_src_in_us: Int?, new_src_out_us: Int?, reason: String)
    case removeSegment(target_clip_id: String, reason: String)
    case changeAudioPolicy(target_clip_id: String, audio_policy: [String: JSONValue], reason: String)
    case changeVisualTransform(target_clip_id: String, visual_transform: ReviewVisualTransform, confidence: Double?, reason: String)
    case changeAudioFinish(audio_finish: ReviewAudioFinish, reason: String)
    case addMarker(frame: Int, label: String, kind: String)
    case addNote(target_clip_id: String, text: String)

    private enum CodingKeys: String, CodingKey {
        case op
        case target_clip_id
        case with_segment_id
        case with_candidate_ref
        case new_src_in_us
        case new_src_out_us
        case new_timeline_in_frame
        case new_duration_frames
        case target_track_id
        case from_clip_id
        case to_clip_id
        case track_id
        case transition_type
        case transition_frames
        case applied_skill_id
        case reason
        case audio_policy
        case visual_transform
        case audio_finish
        case confidence
        case beat_id
        case role
        case label
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let op = try container.decode(String.self, forKey: .op)
        switch op {
        case "replace_segment":
            self = .replaceSegment(
                target_clip_id: try container.decode(String.self, forKey: .target_clip_id),
                with_segment_id: try container.decode(String.self, forKey: .with_segment_id),
                with_candidate_ref: try container.decodeIfPresent(String.self, forKey: .with_candidate_ref),
                new_src_in_us: try container.decodeIfPresent(Int.self, forKey: .new_src_in_us),
                new_src_out_us: try container.decodeIfPresent(Int.self, forKey: .new_src_out_us),
                reason: try container.decode(String.self, forKey: .reason)
            )
        case "trim_segment":
            self = .trimSegment(
                target_clip_id: try container.decode(String.self, forKey: .target_clip_id),
                new_src_in_us: try container.decode(Int.self, forKey: .new_src_in_us),
                new_src_out_us: try container.decode(Int.self, forKey: .new_src_out_us),
                reason: try container.decode(String.self, forKey: .reason)
            )
        case "move_segment":
            self = .moveSegment(
                target_clip_id: try container.decode(String.self, forKey: .target_clip_id),
                new_timeline_in_frame: try container.decode(Int.self, forKey: .new_timeline_in_frame),
                new_duration_frames: try container.decodeIfPresent(Int.self, forKey: .new_duration_frames),
                target_track_id: try container.decodeIfPresent(String.self, forKey: .target_track_id),
                reason: try container.decode(String.self, forKey: .reason)
            )
        case "split_segment":
            self = .splitSegment(
                target_clip_id: try container.decode(String.self, forKey: .target_clip_id),
                split_timeline_frame: try container.decode(Int.self, forKey: .new_timeline_in_frame),
                reason: try container.decode(String.self, forKey: .reason)
            )
        case "set_transition":
            self = .setTransition(
                from_clip_id: try container.decode(String.self, forKey: .from_clip_id),
                to_clip_id: try container.decode(String.self, forKey: .to_clip_id),
                track_id: try container.decode(String.self, forKey: .track_id),
                transition_type: try container.decode(String.self, forKey: .transition_type),
                transition_frames: try container.decode(Int.self, forKey: .transition_frames),
                applied_skill_id: try container.decodeIfPresent(String.self, forKey: .applied_skill_id),
                reason: try container.decode(String.self, forKey: .reason)
            )
        case "insert_segment":
            self = .insertSegment(
                beat_id: try container.decode(String.self, forKey: .beat_id),
                segment_id: try container.decode(String.self, forKey: .with_segment_id),
                role: try container.decode(String.self, forKey: .role),
                new_timeline_in_frame: try container.decode(Int.self, forKey: .new_timeline_in_frame),
                new_duration_frames: try container.decode(Int.self, forKey: .new_duration_frames),
                target_track_id: try container.decodeIfPresent(String.self, forKey: .target_track_id),
                new_src_in_us: try container.decodeIfPresent(Int.self, forKey: .new_src_in_us),
                new_src_out_us: try container.decodeIfPresent(Int.self, forKey: .new_src_out_us),
                reason: try container.decode(String.self, forKey: .reason)
            )
        case "remove_segment":
            self = .removeSegment(
                target_clip_id: try container.decode(String.self, forKey: .target_clip_id),
                reason: try container.decode(String.self, forKey: .reason)
            )
        case "change_audio_policy":
            self = .changeAudioPolicy(
                target_clip_id: try container.decode(String.self, forKey: .target_clip_id),
                audio_policy: try container.decode([String: JSONValue].self, forKey: .audio_policy),
                reason: try container.decode(String.self, forKey: .reason)
            )
        case "change_visual_transform":
            self = .changeVisualTransform(
                target_clip_id: try container.decode(String.self, forKey: .target_clip_id),
                visual_transform: try container.decode(ReviewVisualTransform.self, forKey: .visual_transform),
                confidence: try container.decodeIfPresent(Double.self, forKey: .confidence),
                reason: try container.decode(String.self, forKey: .reason)
            )
        case "change_audio_finish":
            self = .changeAudioFinish(
                audio_finish: try container.decode(ReviewAudioFinish.self, forKey: .audio_finish),
                reason: try container.decode(String.self, forKey: .reason)
            )
        case "add_marker":
            self = .addMarker(
                frame: try container.decode(Int.self, forKey: .new_timeline_in_frame),
                label: try container.decode(String.self, forKey: .label),
                kind: try container.decode(String.self, forKey: .reason)
            )
        case "add_note":
            let text = try container.decodeIfPresent(String.self, forKey: .label)
                ?? container.decode(String.self, forKey: .reason)
            self = .addNote(
                target_clip_id: try container.decode(String.self, forKey: .target_clip_id),
                text: text
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .op,
                in: container,
                debugDescription: "Unknown review patch operation: \(op)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .replaceSegment(targetClipID, segmentID, candidateRef, sourceInUS, sourceOutUS, reason):
            try container.encode("replace_segment", forKey: .op)
            try container.encode(targetClipID, forKey: .target_clip_id)
            try container.encode(segmentID, forKey: .with_segment_id)
            try container.encodeIfPresent(candidateRef, forKey: .with_candidate_ref)
            try container.encodeIfPresent(sourceInUS, forKey: .new_src_in_us)
            try container.encodeIfPresent(sourceOutUS, forKey: .new_src_out_us)
            try container.encode(reason, forKey: .reason)
        case let .trimSegment(targetClipID, sourceInUS, sourceOutUS, reason):
            try container.encode("trim_segment", forKey: .op)
            try container.encode(targetClipID, forKey: .target_clip_id)
            try container.encode(sourceInUS, forKey: .new_src_in_us)
            try container.encode(sourceOutUS, forKey: .new_src_out_us)
            try container.encode(reason, forKey: .reason)
        case let .moveSegment(targetClipID, timelineInFrame, durationFrames, targetTrackID, reason):
            try container.encode("move_segment", forKey: .op)
            try container.encode(targetClipID, forKey: .target_clip_id)
            try container.encode(timelineInFrame, forKey: .new_timeline_in_frame)
            try container.encodeIfPresent(durationFrames, forKey: .new_duration_frames)
            try container.encodeIfPresent(targetTrackID, forKey: .target_track_id)
            try container.encode(reason, forKey: .reason)
        case let .splitSegment(targetClipID, splitTimelineFrame, reason):
            try container.encode("split_segment", forKey: .op)
            try container.encode(targetClipID, forKey: .target_clip_id)
            try container.encode(splitTimelineFrame, forKey: .new_timeline_in_frame)
            try container.encode(reason, forKey: .reason)
        case let .setTransition(fromClipID, toClipID, trackID, transitionType, transitionFrames, appliedSkillID, reason):
            try container.encode("set_transition", forKey: .op)
            try container.encode(fromClipID, forKey: .from_clip_id)
            try container.encode(toClipID, forKey: .to_clip_id)
            try container.encode(trackID, forKey: .track_id)
            try container.encode(transitionType, forKey: .transition_type)
            try container.encode(transitionFrames, forKey: .transition_frames)
            try container.encodeIfPresent(appliedSkillID, forKey: .applied_skill_id)
            try container.encode(reason, forKey: .reason)
        case let .insertSegment(beatID, segmentID, role, timelineInFrame, durationFrames, targetTrackID, sourceInUS, sourceOutUS, reason):
            try container.encode("insert_segment", forKey: .op)
            try container.encode(beatID, forKey: .beat_id)
            try container.encode(segmentID, forKey: .with_segment_id)
            try container.encode(role, forKey: .role)
            try container.encode(timelineInFrame, forKey: .new_timeline_in_frame)
            try container.encode(durationFrames, forKey: .new_duration_frames)
            try container.encodeIfPresent(targetTrackID, forKey: .target_track_id)
            try container.encodeIfPresent(sourceInUS, forKey: .new_src_in_us)
            try container.encodeIfPresent(sourceOutUS, forKey: .new_src_out_us)
            try container.encode(reason, forKey: .reason)
        case let .removeSegment(targetClipID, reason):
            try container.encode("remove_segment", forKey: .op)
            try container.encode(targetClipID, forKey: .target_clip_id)
            try container.encode(reason, forKey: .reason)
        case let .changeAudioPolicy(targetClipID, audioPolicy, reason):
            try container.encode("change_audio_policy", forKey: .op)
            try container.encode(targetClipID, forKey: .target_clip_id)
            try container.encode(audioPolicy, forKey: .audio_policy)
            try container.encode(reason, forKey: .reason)
        case let .changeVisualTransform(targetClipID, visualTransform, confidence, reason):
            try container.encode("change_visual_transform", forKey: .op)
            try container.encode(targetClipID, forKey: .target_clip_id)
            try container.encode(visualTransform, forKey: .visual_transform)
            try container.encodeIfPresent(confidence, forKey: .confidence)
            try container.encode(reason, forKey: .reason)
        case let .changeAudioFinish(audioFinish, reason):
            try container.encode("change_audio_finish", forKey: .op)
            try container.encode(audioFinish, forKey: .audio_finish)
            try container.encode(reason, forKey: .reason)
        case let .addMarker(frame, label, kind):
            try container.encode("add_marker", forKey: .op)
            try container.encode(frame, forKey: .new_timeline_in_frame)
            try container.encode(label, forKey: .label)
            try container.encode(kind, forKey: .reason)
        case let .addNote(targetClipID, text):
            try container.encode("add_note", forKey: .op)
            try container.encode(targetClipID, forKey: .target_clip_id)
            try container.encode(text, forKey: .label)
            try container.encode(text, forKey: .reason)
        }
    }

    public var opName: String {
        switch self {
        case .replaceSegment: return "replace_segment"
        case .trimSegment: return "trim_segment"
        case .moveSegment: return "move_segment"
        case .splitSegment: return "split_segment"
        case .setTransition: return "set_transition"
        case .insertSegment: return "insert_segment"
        case .removeSegment: return "remove_segment"
        case .changeAudioPolicy: return "change_audio_policy"
        case .changeVisualTransform: return "change_visual_transform"
        case .changeAudioFinish: return "change_audio_finish"
        case .addMarker: return "add_marker"
        case .addNote: return "add_note"
        }
    }

    public var targetClipID: String? {
        switch self {
        case let .replaceSegment(targetClipID, _, _, _, _, _),
             let .trimSegment(targetClipID, _, _, _),
             let .moveSegment(targetClipID, _, _, _, _),
             let .splitSegment(targetClipID, _, _),
             let .removeSegment(targetClipID, _),
             let .changeAudioPolicy(targetClipID, _, _),
             let .changeVisualTransform(targetClipID, _, _, _),
             let .addNote(targetClipID, _):
            return targetClipID
        case .setTransition, .insertSegment, .changeAudioFinish, .addMarker:
            return nil
        }
    }

    public var changedClipID: String? {
        switch self {
        case let .insertSegment(beatID, _, _, _, _, _, _, _, _):
            return beatID
        case let .setTransition(fromClipID, _, _, _, _, _, _):
            return fromClipID
        default:
            return targetClipID
        }
    }

    var deduplicationKey: String? {
        if case .changeAudioFinish = self {
            return opName
        }
        if case let .setTransition(fromClipID, toClipID, trackID, _, _, _, _) = self {
            return "\(opName):\(trackID):\(fromClipID):\(toClipID)"
        }
        guard let targetClipID else { return nil }
        switch self {
        case .replaceSegment, .trimSegment, .moveSegment, .splitSegment, .removeSegment, .changeAudioPolicy, .changeVisualTransform:
            return "\(opName):\(targetClipID)"
        case .setTransition, .changeAudioFinish, .addNote, .insertSegment, .addMarker:
            return nil
        }
    }

    var referencedClipIDs: Set<String> {
        switch self {
        case let .setTransition(fromClipID, toClipID, _, _, _, _, _):
            return [fromClipID, toClipID]
        default:
            return targetClipID.map { [$0] } ?? []
        }
    }

    var isValidForCompilerSchema: Bool {
        switch self {
        case let .replaceSegment(targetClipID, segmentID, _, sourceInUS, sourceOutUS, reason):
            return !targetClipID.isEmpty
                && !segmentID.isEmpty
                && Self.validOptionalSourceRange(sourceInUS: sourceInUS, sourceOutUS: sourceOutUS)
                && !reason.isEmpty
        case let .trimSegment(targetClipID, sourceInUS, sourceOutUS, reason):
            return !targetClipID.isEmpty && sourceInUS >= 0 && sourceOutUS > sourceInUS && !reason.isEmpty
        case let .moveSegment(targetClipID, timelineInFrame, durationFrames, targetTrackID, reason):
            return !targetClipID.isEmpty
                && timelineInFrame >= 0
                && (durationFrames.map { $0 > 0 } ?? true)
                && (targetTrackID.map { !$0.isEmpty } ?? true)
                && !reason.isEmpty
        case let .splitSegment(targetClipID, splitTimelineFrame, reason):
            return !targetClipID.isEmpty
                && splitTimelineFrame >= 0
                && !reason.isEmpty
        case let .setTransition(fromClipID, toClipID, trackID, transitionType, transitionFrames, appliedSkillID, reason):
            return !fromClipID.isEmpty
                && !toClipID.isEmpty
                && fromClipID != toClipID
                && !trackID.isEmpty
                && !transitionType.isEmpty
                && transitionFrames > 0
                && (appliedSkillID.map { !$0.isEmpty } ?? true)
                && !reason.isEmpty
        case let .insertSegment(beatID, segmentID, role, timelineInFrame, durationFrames, targetTrackID, sourceInUS, sourceOutUS, reason):
            return !beatID.isEmpty
                && !segmentID.isEmpty
                && Self.allowedInsertRoles.contains(role)
                && timelineInFrame >= 0
                && durationFrames > 0
                && (targetTrackID.map { !$0.isEmpty } ?? true)
                && Self.validOptionalSourceRange(sourceInUS: sourceInUS, sourceOutUS: sourceOutUS)
                && !reason.isEmpty
        case let .removeSegment(targetClipID, reason):
            return !targetClipID.isEmpty && !reason.isEmpty
        case let .changeAudioPolicy(targetClipID, audioPolicy, reason):
            return !targetClipID.isEmpty
                && !audioPolicy.isEmpty
                && Set(audioPolicy.keys).isSubset(of: Self.allowedAudioPolicyKeys)
                && !reason.isEmpty
        case let .changeVisualTransform(targetClipID, visualTransform, confidence, reason):
            return !targetClipID.isEmpty
                && visualTransform.isValid
                && (confidence.map { $0.isFinite && (0 ... 1).contains($0) } ?? true)
                && !reason.isEmpty
        case let .changeAudioFinish(audioFinish, reason):
            return audioFinish.isValid && !reason.isEmpty
        case let .addMarker(frame, label, kind):
            return frame >= 0 && !label.isEmpty && !kind.isEmpty
        case .addNote:
            return false
        }
    }

    var isValidForStudioSession: Bool {
        switch self {
        case let .addNote(targetClipID, text):
            return !targetClipID.isEmpty && !text.isEmpty
        default:
            return isValidForCompilerSchema
        }
    }

    private static let allowedInsertRoles: Set<String> = [
        "hero",
        "support",
        "transition",
        "texture",
        "dialogue",
        "music",
        "title"
    ]

    private static let allowedAudioPolicyKeys: Set<String> = [
        "duck_music_db",
        "preserve_nat_sound",
        "fade_in_frames",
        "fade_out_frames"
    ]

    private static func validOptionalSourceRange(sourceInUS: Int?, sourceOutUS: Int?) -> Bool {
        switch (sourceInUS, sourceOutUS) {
        case (nil, nil):
            return true
        case let (sourceInUS?, sourceOutUS?):
            return sourceInUS >= 0 && sourceOutUS > sourceInUS
        default:
            return false
        }
    }
}

public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let single = try decoder.singleValueContainer()
        if single.decodeNil() {
            self = .null
            return
        }
        if let bool = try? single.decode(Bool.self) {
            self = .bool(bool)
            return
        }
        if let int = try? single.decode(Int.self) {
            self = .int(int)
            return
        }
        if let double = try? single.decode(Double.self) {
            self = .double(double)
            return
        }
        if let string = try? single.decode(String.self) {
            self = .string(string)
            return
        }
        if var array = try? decoder.unkeyedContainer() {
            var values: [JSONValue] = []
            while !array.isAtEnd {
                values.append(try array.decode(JSONValue.self))
            }
            self = .array(values)
            return
        }
        if let object = try? decoder.container(keyedBy: ReviewPatchDynamicCodingKey.self) {
            var values: [String: JSONValue] = [:]
            for key in object.allKeys {
                values[key.stringValue] = try object.decode(JSONValue.self, forKey: key)
            }
            self = .object(values)
            return
        }
        throw DecodingError.dataCorruptedError(in: single, debugDescription: "Unsupported JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case let .string(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case let .int(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case let .double(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case let .bool(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case let .object(value):
            var container = encoder.container(keyedBy: ReviewPatchDynamicCodingKey.self)
            for key in value.keys.sorted() {
                guard let nestedValue = value[key] else { continue }
                try container.encode(nestedValue, forKey: ReviewPatchDynamicCodingKey(stringValue: key))
            }
        case let .array(value):
            var container = encoder.unkeyedContainer()
            for item in value {
                try container.encode(item)
            }
        case .null:
            var container = encoder.singleValueContainer()
            try container.encodeNil()
        }
    }
}

private struct ReviewPatchDynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init(intValue: Int) {
        stringValue = "\(intValue)"
        self.intValue = intValue
    }
}
