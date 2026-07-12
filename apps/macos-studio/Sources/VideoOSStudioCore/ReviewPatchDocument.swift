import Foundation

public struct ReviewPatchDocument: Codable, Equatable, Sendable {
    public let timeline_version: String
    public let operations: [ReviewPatchOperation]

    public init(timeline_version: String, operations: [ReviewPatchOperation]) {
        self.timeline_version = timeline_version
        self.operations = operations
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
             let .addNote(targetClipID, _):
            return targetClipID
        case .setTransition, .insertSegment, .addMarker:
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
        if case let .setTransition(fromClipID, toClipID, trackID, _, _, _, _) = self {
            return "\(opName):\(trackID):\(fromClipID):\(toClipID)"
        }
        guard let targetClipID else { return nil }
        switch self {
        case .replaceSegment, .trimSegment, .moveSegment, .splitSegment, .removeSegment, .changeAudioPolicy:
            return "\(opName):\(targetClipID)"
        case .setTransition, .addNote, .insertSegment, .addMarker:
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
