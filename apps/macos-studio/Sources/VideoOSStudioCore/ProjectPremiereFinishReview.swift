import Foundation

// MARK: - Closed projection DTO

public struct ProjectPremiereFinishReviewProjection: Decodable, Equatable, Sendable {
    public let version: String
    public let projectID: String
    public let profileID: String
    public let baseTimelineSHA256: String
    public let hardwareVerified: Bool
    public let surfaces: [ProjectPremiereFinishReviewSurface]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case version
        case projectID = "project_id"
        case profileID = "profile_id"
        case baseTimelineSHA256 = "base_timeline_sha256"
        case hardwareVerified = "hardware_verified"
        case surfaces
    }

    public init(from decoder: Decoder) throws {
        try requireExactKeys(decoder, CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(String.self, forKey: .version)
        projectID = try container.decode(String.self, forKey: .projectID)
        profileID = try container.decode(String.self, forKey: .profileID)
        baseTimelineSHA256 = try container.decode(String.self, forKey: .baseTimelineSHA256)
        hardwareVerified = try container.decode(Bool.self, forKey: .hardwareVerified)
        surfaces = try container.decode([ProjectPremiereFinishReviewSurface].self, forKey: .surfaces)

        try require(version == "premiere-finish-review/v2", decoder, "unsupported projection version")
        try requireNonempty(projectID, decoder, "project_id")
        try require(profileID == "adobe_premiere_fcp7xml_v1", decoder, "unsupported profile_id")
        try requireSHA256(baseTimelineSHA256, decoder, "base_timeline_sha256")
        try require(hardwareVerified == false, decoder, "hardware_verified must remain false")
        try validateSurfaceOrderAndUniqueness(surfaces, decoder: decoder)
    }
}

public enum ProjectPremiereFinishReviewSurface: Decodable, Equatable, Sendable {
    case text(ProjectPremiereFinishReviewTextItem)
    case transition(ProjectPremiereFinishReviewTransitionItem)
    case audio(ProjectPremiereFinishReviewAudioItem)
    case visualEffect(ProjectPremiereFinishReviewVisualItem)

    private enum DiscriminatorKeys: String, CodingKey {
        case kind
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DiscriminatorKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "text":
            self = .text(try ProjectPremiereFinishReviewTextItem(from: decoder))
        case "transition":
            self = .transition(try ProjectPremiereFinishReviewTransitionItem(from: decoder))
        case "audio":
            self = .audio(try ProjectPremiereFinishReviewAudioItem(from: decoder))
        case "visual_effect":
            self = .visualEffect(try ProjectPremiereFinishReviewVisualItem(from: decoder))
        default:
            throw ProjectPremiereFinishReviewDecodeFailure.unknownValue
        }
    }
}

public struct ProjectPremiereFinishReviewTextItem: Decodable, Equatable, Sendable {
    public struct Target: Decodable, Equatable, Sendable {
        public let trackID: String
        public let clipID: String
        public let overlayID: String

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case trackID = "track_id"
            case clipID = "clip_id"
            case overlayID = "overlay_id"
        }

        public init(from decoder: Decoder) throws {
            try requireExactKeys(decoder, CodingKeys.self)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            trackID = try container.decode(String.self, forKey: .trackID)
            clipID = try container.decode(String.self, forKey: .clipID)
            overlayID = try container.decode(String.self, forKey: .overlayID)
            try requireNonempty(trackID, decoder, "track_id")
            try requireNonempty(clipID, decoder, "clip_id")
            try requireNonempty(overlayID, decoder, "overlay_id")
        }
    }

    public struct Source: Decodable, Equatable, Sendable {
        public let role: String
        public let text: String
        public let stylingClass: String
        public let writingMode: String?
        public let anchor: String?
        public let authoredSource: String?
        public let timelineInFrame: Int
        public let timelineDurationFrames: Int

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case role
            case text
            case stylingClass = "styling_class"
            case writingMode = "writing_mode"
            case anchor
            case authoredSource = "authored_source"
            case timelineInFrame = "timeline_in_frame"
            case timelineDurationFrames = "timeline_duration_frames"
        }

        public init(from decoder: Decoder) throws {
            try requireExactKeys(decoder, CodingKeys.self)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            role = try container.decode(String.self, forKey: .role)
            text = try container.decode(String.self, forKey: .text)
            stylingClass = try container.decode(String.self, forKey: .stylingClass)
            writingMode = try container.decodeRequiredNullable(String.self, forKey: .writingMode)
            anchor = try container.decodeRequiredNullable(String.self, forKey: .anchor)
            authoredSource = try container.decodeRequiredNullable(String.self, forKey: .authoredSource)
            timelineInFrame = try container.decode(Int.self, forKey: .timelineInFrame)
            timelineDurationFrames = try container.decode(Int.self, forKey: .timelineDurationFrames)
            try requireKnownValue(role, allowed: ["title"])
            try requireNonempty(stylingClass, decoder, "styling_class")
            try require(timelineInFrame >= 0, decoder, "timeline_in_frame must be nonnegative")
            try require(timelineDurationFrames > 0, decoder, "timeline_duration_frames must be positive")
        }
    }

    public let target: Target
    public let source: Source
    public let status: String
    public let rawStatus: String
    public let reasonCode: String
    public let actionCode: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case kind
        case target
        case source
        case status
        case rawStatus = "raw_status"
        case reasonCode = "reason_code"
        case actionCode = "action_code"
    }

    public init(from decoder: Decoder) throws {
        try requireExactKeys(decoder, CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        try requireKnownValue(kind, allowed: ["text"])
        target = try container.decode(Target.self, forKey: .target)
        source = try container.decode(Source.self, forKey: .source)
        status = try container.decode(String.self, forKey: .status)
        rawStatus = try container.decode(String.self, forKey: .rawStatus)
        reasonCode = try container.decode(String.self, forKey: .reasonCode)
        actionCode = try container.decode(String.self, forKey: .actionCode)
        try requireKnownValue(status, allowed: ["blocked"])
        try requireKnownValue(rawStatus, allowed: ["report_only"])
        try requireKnownValue(reasonCode, allowed: ["profile_text_export_blocked"])
        try requireKnownValue(actionCode, allowed: ["review_text_then_wait_for_full_handoff"])
    }
}

public enum ProjectPremiereFinishReviewTransitionStatus: String, Decodable, Equatable, Sendable {
    case reportOnly = "report_only"
    case unsupported

    public init(from decoder: Decoder) throws {
        self = try decodeClosedEnum(Self.self, from: decoder)
    }
}

public enum ProjectPremiereFinishReviewTransitionRawStatus: String, Decodable, Equatable, Sendable {
    case allowedTypeReportOnly = "allowed_type_report_only"
    case typeNotAllowed = "type_not_allowed"

    public init(from decoder: Decoder) throws {
        self = try decodeClosedEnum(Self.self, from: decoder)
    }
}

public struct ProjectPremiereFinishReviewTransitionItem: Decodable, Equatable, Sendable {
    public struct Target: Decodable, Equatable, Sendable {
        public let transitionID: String
        public let trackID: String
        public let fromClipID: String
        public let toClipID: String

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case transitionID = "transition_id"
            case trackID = "track_id"
            case fromClipID = "from_clip_id"
            case toClipID = "to_clip_id"
        }

        public init(from decoder: Decoder) throws {
            try requireExactKeys(decoder, CodingKeys.self)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            transitionID = try container.decode(String.self, forKey: .transitionID)
            trackID = try container.decode(String.self, forKey: .trackID)
            fromClipID = try container.decode(String.self, forKey: .fromClipID)
            toClipID = try container.decode(String.self, forKey: .toClipID)
            try requireNonempty(transitionID, decoder, "transition_id")
            try requireNonempty(trackID, decoder, "track_id")
            try requireNonempty(fromClipID, decoder, "from_clip_id")
            try requireNonempty(toClipID, decoder, "to_clip_id")
        }
    }

    public struct Source: Decodable, Equatable, Sendable {
        public let transitionType: String
        public let transitionFrames: Int?
        public let appliedSkillID: String?
        public let degradedFromSkillID: String?
        public let confidence: Double?

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case transitionType = "transition_type"
            case transitionFrames = "transition_frames"
            case appliedSkillID = "applied_skill_id"
            case degradedFromSkillID = "degraded_from_skill_id"
            case confidence
        }

        public init(from decoder: Decoder) throws {
            try requireExactKeys(decoder, CodingKeys.self)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            transitionType = try container.decode(String.self, forKey: .transitionType)
            transitionFrames = try container.decodeRequiredNullable(Int.self, forKey: .transitionFrames)
            appliedSkillID = try container.decodeRequiredNullable(String.self, forKey: .appliedSkillID)
            degradedFromSkillID = try container.decodeRequiredNullable(String.self, forKey: .degradedFromSkillID)
            confidence = try container.decodeRequiredNullable(Double.self, forKey: .confidence)
            try requireNonempty(transitionType, decoder, "transition_type")
            try require(transitionFrames == nil || transitionFrames! > 0, decoder, "transition_frames must be positive or null")
            try require(confidence == nil || confidence!.isFinite, decoder, "confidence must be finite or null")
        }
    }

    public let target: Target
    public let source: Source
    public let status: ProjectPremiereFinishReviewTransitionStatus
    public let rawStatus: ProjectPremiereFinishReviewTransitionRawStatus
    public let reasonCode: String
    public let actionCode: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case kind
        case target
        case source
        case status
        case rawStatus = "raw_status"
        case reasonCode = "reason_code"
        case actionCode = "action_code"
    }

    public init(from decoder: Decoder) throws {
        try requireExactKeys(decoder, CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        try requireKnownValue(kind, allowed: ["transition"])
        target = try container.decode(Target.self, forKey: .target)
        source = try container.decode(Source.self, forKey: .source)
        status = try container.decode(ProjectPremiereFinishReviewTransitionStatus.self, forKey: .status)
        rawStatus = try container.decode(ProjectPremiereFinishReviewTransitionRawStatus.self, forKey: .rawStatus)
        reasonCode = try container.decode(String.self, forKey: .reasonCode)
        actionCode = try container.decode(String.self, forKey: .actionCode)
        try requireKnownValue(reasonCode, allowed: ["profile_transition_report_only", "transition_type_not_allowed"])
        try requireKnownValue(actionCode, allowed: ["review_transition_then_wait_for_full_handoff", "change_or_remove_transition"])

        let isReportOnly = status == .reportOnly
            && rawStatus == .allowedTypeReportOnly
            && reasonCode == "profile_transition_report_only"
            && actionCode == "review_transition_then_wait_for_full_handoff"
        let isUnsupported = status == .unsupported
            && rawStatus == .typeNotAllowed
            && reasonCode == "transition_type_not_allowed"
            && actionCode == "change_or_remove_transition"
        try require(isReportOnly || isUnsupported, decoder, "inconsistent transition status mapping")
    }
}

public struct ProjectPremiereFinishReviewAudioItem: Decodable, Equatable, Sendable {
    public struct Target: Decodable, Equatable, Sendable {
        public let trackID: String
        public let clipID: String
        public let effectID: String

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case trackID = "track_id"
            case clipID = "clip_id"
            case effectID = "effect_id"
        }

        public init(from decoder: Decoder) throws {
            try requireExactKeys(decoder, CodingKeys.self)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            trackID = try container.decode(String.self, forKey: .trackID)
            clipID = try container.decode(String.self, forKey: .clipID)
            effectID = try container.decode(String.self, forKey: .effectID)
            try requireNonempty(trackID, decoder, "track_id")
            try requireNonempty(clipID, decoder, "clip_id")
            try requireKnownValue(effectID, allowed: ["audiolevels"])
        }
    }

    public struct Source: Decodable, Equatable, Sendable {
        public struct AudioPolicy: Decodable, Equatable, Sendable {
            public let mode: String?
            public let gainUnit: String?
            public let duckMusicDB: Double?
            public let natGain: Double?
            public let natSoundGain: Double?
            public let bgmGain: Double?
            public let a1Loudnorm: Bool?
            public let preserveNatSound: Bool?
            public let fadeInFrames: Int?
            public let fadeOutFrames: Int?
            public let natSoundFadeInFrames: Int?
            public let natSoundFadeOutFrames: Int?
            public let bgmFadeInFrames: Int?
            public let bgmFadeOutFrames: Int?

            private enum CodingKeys: String, CodingKey, CaseIterable {
                case mode
                case gainUnit = "gain_unit"
                case duckMusicDB = "duck_music_db"
                case natGain = "nat_gain"
                case natSoundGain = "nat_sound_gain"
                case bgmGain = "bgm_gain"
                case a1Loudnorm = "a1_loudnorm"
                case preserveNatSound = "preserve_nat_sound"
                case fadeInFrames = "fade_in_frames"
                case fadeOutFrames = "fade_out_frames"
                case natSoundFadeInFrames = "nat_sound_fade_in_frames"
                case natSoundFadeOutFrames = "nat_sound_fade_out_frames"
                case bgmFadeInFrames = "bgm_fade_in_frames"
                case bgmFadeOutFrames = "bgm_fade_out_frames"
            }

            public init(from decoder: Decoder) throws {
                try requireExactKeys(decoder, CodingKeys.self)
                let container = try decoder.container(keyedBy: CodingKeys.self)
                mode = try container.decodeRequiredNullable(String.self, forKey: .mode)
                gainUnit = try container.decodeRequiredNullable(String.self, forKey: .gainUnit)
                duckMusicDB = try container.decodeRequiredNullable(Double.self, forKey: .duckMusicDB)
                natGain = try container.decodeRequiredNullable(Double.self, forKey: .natGain)
                natSoundGain = try container.decodeRequiredNullable(Double.self, forKey: .natSoundGain)
                bgmGain = try container.decodeRequiredNullable(Double.self, forKey: .bgmGain)
                a1Loudnorm = try container.decodeRequiredNullable(Bool.self, forKey: .a1Loudnorm)
                preserveNatSound = try container.decodeRequiredNullable(Bool.self, forKey: .preserveNatSound)
                fadeInFrames = try container.decodeRequiredNullable(Int.self, forKey: .fadeInFrames)
                fadeOutFrames = try container.decodeRequiredNullable(Int.self, forKey: .fadeOutFrames)
                natSoundFadeInFrames = try container.decodeRequiredNullable(Int.self, forKey: .natSoundFadeInFrames)
                natSoundFadeOutFrames = try container.decodeRequiredNullable(Int.self, forKey: .natSoundFadeOutFrames)
                bgmFadeInFrames = try container.decodeRequiredNullable(Int.self, forKey: .bgmFadeInFrames)
                bgmFadeOutFrames = try container.decodeRequiredNullable(Int.self, forKey: .bgmFadeOutFrames)

                let gains = [duckMusicDB, natGain, natSoundGain, bgmGain].compactMap { $0 }
                try require(gains.allSatisfy(\.isFinite), decoder, "audio gains must be finite or null")
                let frames = [fadeInFrames, fadeOutFrames, natSoundFadeInFrames, natSoundFadeOutFrames,
                              bgmFadeInFrames, bgmFadeOutFrames].compactMap { $0 }
                try require(frames.allSatisfy { $0 >= 0 }, decoder, "audio fade frames must be nonnegative or null")
            }
        }

        public let audioPolicy: AudioPolicy

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case audioPolicy = "audio_policy"
        }

        public init(from decoder: Decoder) throws {
            try requireExactKeys(decoder, CodingKeys.self)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            audioPolicy = try container.decode(AudioPolicy.self, forKey: .audioPolicy)
        }
    }

    public let target: Target
    public let source: Source
    public let status: String
    public let rawStatus: String
    public let reasonCode: String
    public let actionCode: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case kind
        case target
        case source
        case status
        case rawStatus = "raw_status"
        case reasonCode = "reason_code"
        case actionCode = "action_code"
    }

    public init(from decoder: Decoder) throws {
        try requireExactKeys(decoder, CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        try requireKnownValue(kind, allowed: ["audio"])
        target = try container.decode(Target.self, forKey: .target)
        source = try container.decode(Source.self, forKey: .source)
        status = try container.decode(String.self, forKey: .status)
        rawStatus = try container.decode(String.self, forKey: .rawStatus)
        reasonCode = try container.decode(String.self, forKey: .reasonCode)
        actionCode = try container.decode(String.self, forKey: .actionCode)
        try requireKnownValue(status, allowed: ["provisional_roundtrip"])
        try requireKnownValue(rawStatus, allowed: ["provisional_roundtrip"])
        try requireKnownValue(reasonCode, allowed: ["profile_audiolevels_provisional"])
        try requireKnownValue(actionCode, allowed: ["review_audio_levels_then_wait_for_full_handoff"])
    }
}

public enum ProjectPremiereFinishReviewVisualStatus: String, Decodable, Equatable, Sendable {
    case native
    case bakeRequired = "bake_required"
    case ready
    case stale
    case busy
    case conflict
    case sourceUnverified = "source_unverified"
    case rightsPrivacyBlocked = "rights_privacy_blocked"
    case unsupported
    case error

    public init(from decoder: Decoder) throws {
        self = try decodeClosedEnum(Self.self, from: decoder)
    }
}

public enum ProjectPremiereFinishReviewVisualRawStatus: String, Decodable, Equatable, Sendable {
    case native
    case bakeRequired = "bake_required"
    case reusable
    case stale
    case busy
    case conflict
    case sourceUnverified = "source_unverified"
    case rightsPrivacyBlocked = "rights_privacy_blocked"
    case unsupported
    case error

    public init(from decoder: Decoder) throws {
        self = try decodeClosedEnum(Self.self, from: decoder)
    }
}

public enum ProjectPremiereFinishReviewVisualAction: String, Decodable, Equatable, Sendable {
    case none
    case consentRequiredButExecutionBlocked = "consent_required_but_execution_blocked"
    case reuseAvailableButExecutionBlocked = "reuse_available_but_execution_blocked"
    case rebakeRequiredButExecutionBlocked = "rebake_required_but_execution_blocked"
    case retryAfterBusy = "retry_after_busy"
    case resolveConflict = "resolve_conflict"
    case verifySource = "verify_source"
    case resolveRightsPrivacy = "resolve_rights_privacy"
    case removeOrReplaceEffect = "remove_or_replace_effect"
    case inspectError = "inspect_error"

    public init(from decoder: Decoder) throws {
        self = try decodeClosedEnum(Self.self, from: decoder)
    }
}

public struct ProjectPremiereFinishReviewVisualItem: Decodable, Equatable, Sendable {
    public struct Target: Decodable, Equatable, Sendable {
        public let trackID: String
        public let clipID: String
        public let effectIDs: [String]?

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case trackID = "track_id"
            case clipID = "clip_id"
            case effectIDs = "effect_ids"
        }

        public init(from decoder: Decoder) throws {
            try requireExactKeys(decoder, CodingKeys.self)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            trackID = try container.decode(String.self, forKey: .trackID)
            clipID = try container.decode(String.self, forKey: .clipID)
            effectIDs = try container.decodeRequiredNullable([String].self, forKey: .effectIDs)
            try requireNonempty(trackID, decoder, "track_id")
            try requireNonempty(clipID, decoder, "clip_id")
            if let effectIDs {
                let precedence = [
                    "transform.zoom", "transform.crop", "transform.position", "effect.eq",
                    "effect.brightness", "effect.contrast", "effect.saturation"
                ]
                try require(effectIDs.allSatisfy { !$0.isEmpty }, decoder, "effect_ids must be nonempty strings")
                try require(Set(effectIDs).count == effectIDs.count, decoder, "effect_ids must be unique")
                try require(precedence.filter(Set(effectIDs).contains) == effectIDs, decoder, "effect_ids are not in canonical order")
            }
        }
    }

    public let target: Target
    public let status: ProjectPremiereFinishReviewVisualStatus
    public let rawStatus: ProjectPremiereFinishReviewVisualRawStatus
    public let reason: String?
    public let actionCode: ProjectPremiereFinishReviewVisualAction
    public let requestSHA256: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case kind
        case target
        case status
        case rawStatus = "raw_status"
        case reason
        case actionCode = "action_code"
        case requestSHA256 = "request_sha256"
    }

    public init(from decoder: Decoder) throws {
        try requireExactKeys(decoder, CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        try requireKnownValue(kind, allowed: ["visual_effect"])
        target = try container.decode(Target.self, forKey: .target)
        status = try container.decode(ProjectPremiereFinishReviewVisualStatus.self, forKey: .status)
        rawStatus = try container.decode(ProjectPremiereFinishReviewVisualRawStatus.self, forKey: .rawStatus)
        reason = try container.decodeRequiredNullable(String.self, forKey: .reason)
        actionCode = try container.decode(ProjectPremiereFinishReviewVisualAction.self, forKey: .actionCode)
        requestSHA256 = try container.decodeRequiredNullable(String.self, forKey: .requestSHA256)
        if let requestSHA256 {
            try requireSHA256(requestSHA256, decoder, "request_sha256")
        }

        let expected: (ProjectPremiereFinishReviewVisualStatus, ProjectPremiereFinishReviewVisualAction)
        switch rawStatus {
        case .native: expected = (.native, .none)
        case .bakeRequired: expected = (.bakeRequired, .consentRequiredButExecutionBlocked)
        case .reusable: expected = (.ready, .reuseAvailableButExecutionBlocked)
        case .stale: expected = (.stale, .rebakeRequiredButExecutionBlocked)
        case .busy: expected = (.busy, .retryAfterBusy)
        case .conflict: expected = (.conflict, .resolveConflict)
        case .sourceUnverified: expected = (.sourceUnverified, .verifySource)
        case .rightsPrivacyBlocked: expected = (.rightsPrivacyBlocked, .resolveRightsPrivacy)
        case .unsupported: expected = (.unsupported, .removeOrReplaceEffect)
        case .error: expected = (.error, .inspectError)
        }
        try require(status == expected.0 && actionCode == expected.1, decoder, "inconsistent visual status mapping")
        if rawStatus == .native {
            try require(target.effectIDs == [], decoder, "native visual surface must have empty effect_ids")
        }
    }
}

// MARK: - Validated local projection client

public enum ProjectPremiereFinishReviewFailure: Error, Equatable, Sendable {
    case invalidProjection
    case unknownValue
    case unsupportedProfile
    case duplicateTarget
    case toolUnavailable
    case preflightContractError
    case timelineRevisionChanged
    case unsupportedExit(Int32)
    case selectedProjectMismatch
    case timelineRevisionMismatch
}

public enum ProjectPremiereFinishReviewDecoder {
    public static func decode(_ data: Data) throws -> ProjectPremiereFinishReviewProjection {
        do {
            return try JSONDecoder().decode(ProjectPremiereFinishReviewProjection.self, from: data)
        } catch ProjectPremiereFinishReviewDecodeFailure.unknownValue {
            throw ProjectPremiereFinishReviewFailure.unknownValue
        } catch {
            throw ProjectPremiereFinishReviewFailure.invalidProjection
        }
    }
}

public struct ProjectPremiereFinishReviewProjectGeneration: Equatable, Sendable {
    public let projectURL: URL
    public let projectID: String
    public let timelineSHA256: String
    public let revision: UInt64

    public init(projectURL: URL, projectID: String, timelineSHA256: String, revision: UInt64) {
        self.projectURL = projectURL.standardizedFileURL
        self.projectID = projectID
        self.timelineSHA256 = timelineSHA256
        self.revision = revision
    }
}

public struct ProjectPremiereFinishReviewRequest: Equatable, Sendable {
    public let id: UInt64
    public let projectGeneration: ProjectPremiereFinishReviewProjectGeneration

    public init(id: UInt64, projectGeneration: ProjectPremiereFinishReviewProjectGeneration) {
        self.id = id
        self.projectGeneration = projectGeneration
    }
}

public struct ProjectPremiereFinishReviewInvocation: Equatable, Sendable {
    public let executableURL: URL
    public let arguments: [String]
    public let workingDirectoryURL: URL
}

public struct ProjectPremiereFinishReviewProcessResult: Equatable, Sendable {
    public let status: Int32
    public let stdout: String
    public let stderr: String

    public init(status: Int32, stdout: String, stderr: String) {
        self.status = status
        self.stdout = stdout
        self.stderr = stderr
    }
}

public enum ProjectPremiereFinishReviewClient {
    public typealias Runner = (_ invocation: ProjectPremiereFinishReviewInvocation) throws -> ProjectPremiereFinishReviewProcessResult

    public static func invocation(
        repositoryRoot: URL,
        projectURL: URL
    ) throws -> ProjectPremiereFinishReviewInvocation {
        let root = repositoryRoot.resolvingSymlinksInPath().standardizedFileURL
        guard isDirectDirectory(root) else { throw ProjectPremiereFinishReviewFailure.toolUnavailable }

        let nodeModules = root.appendingPathComponent("node_modules").standardizedFileURL
        let binaryDirectory = nodeModules.appendingPathComponent(".bin").standardizedFileURL
        guard isDirectDirectory(nodeModules), isDirectDirectory(binaryDirectory) else {
            throw ProjectPremiereFinishReviewFailure.toolUnavailable
        }

        let binaryCandidate = binaryDirectory.appendingPathComponent("tsx").standardizedFileURL
        let executable = binaryCandidate.resolvingSymlinksInPath().standardizedFileURL
        guard isContained(executable, in: nodeModules),
              hasNoSymlinkComponents(executable, below: nodeModules),
              isRegularFile(executable),
              FileManager.default.isExecutableFile(atPath: executable.path)
        else { throw ProjectPremiereFinishReviewFailure.toolUnavailable }

        let scriptsDirectory = root.appendingPathComponent("scripts").standardizedFileURL
        let script = root.appendingPathComponent("scripts/premiere-finish-review.ts").standardizedFileURL
        guard isDirectDirectory(scriptsDirectory), isDirectRegularSingleLinkFile(script) else {
            throw ProjectPremiereFinishReviewFailure.toolUnavailable
        }

        let project = projectURL.resolvingSymlinksInPath().standardizedFileURL
        let projectsRoot = root.appendingPathComponent("projects").standardizedFileURL
        guard isDirectDirectory(projectsRoot), isDirectDirectory(project), isContained(project, in: projectsRoot) else {
            throw ProjectPremiereFinishReviewFailure.invalidProjection
        }

        return ProjectPremiereFinishReviewInvocation(
            executableURL: executable,
            arguments: [script.path, project.path, "--json"],
            workingDirectoryURL: root
        )
    }

    public static func load(
        repositoryRoot: URL,
        request: ProjectPremiereFinishReviewRequest
    ) throws -> ProjectPremiereFinishReviewProjection {
        try load(repositoryRoot: repositoryRoot, request: request) { invocation in
            let output = try SubprocessRunner.run(
                executablePath: invocation.executableURL.path,
                arguments: invocation.arguments,
                currentDirectoryURL: invocation.workingDirectoryURL
            )
            return ProjectPremiereFinishReviewProcessResult(
                status: output.exitCode,
                stdout: output.stdout,
                stderr: output.stderr
            )
        }
    }

    public static func load(
        repositoryRoot: URL,
        request: ProjectPremiereFinishReviewRequest,
        runner: Runner
    ) throws -> ProjectPremiereFinishReviewProjection {
        guard !request.projectGeneration.projectID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              isSHA256(request.projectGeneration.timelineSHA256)
        else { throw ProjectPremiereFinishReviewFailure.invalidProjection }

        let invocation = try invocation(
            repositoryRoot: repositoryRoot,
            projectURL: request.projectGeneration.projectURL
        )
        let result: ProjectPremiereFinishReviewProcessResult
        do {
            result = try runner(invocation)
        } catch let failure as ProjectPremiereFinishReviewFailure {
            throw failure
        } catch {
            throw ProjectPremiereFinishReviewFailure.toolUnavailable
        }

        guard result.status == 0 else {
            guard result.status == 1 else {
                throw ProjectPremiereFinishReviewFailure.unsupportedExit(result.status)
            }
            guard result.stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let data = result.stderr.data(using: .utf8)
            else { throw ProjectPremiereFinishReviewFailure.invalidProjection }
            let envelope: ProjectPremiereFinishReviewErrorEnvelope
            do {
                envelope = try JSONDecoder().decode(ProjectPremiereFinishReviewErrorEnvelope.self, from: data)
            } catch ProjectPremiereFinishReviewDecodeFailure.unknownValue {
                throw ProjectPremiereFinishReviewFailure.unknownValue
            } catch {
                throw ProjectPremiereFinishReviewFailure.invalidProjection
            }
            throw envelope.failure
        }

        guard let data = result.stdout.data(using: .utf8) else {
            throw ProjectPremiereFinishReviewFailure.invalidProjection
        }
        let projection = try ProjectPremiereFinishReviewDecoder.decode(data)
        guard projection.projectID == request.projectGeneration.projectID else {
            throw ProjectPremiereFinishReviewFailure.selectedProjectMismatch
        }
        guard projection.baseTimelineSHA256 == request.projectGeneration.timelineSHA256 else {
            throw ProjectPremiereFinishReviewFailure.timelineRevisionMismatch
        }
        return projection
    }

    private static func isDirectDirectory(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
              values.isDirectory == true,
              values.isSymbolicLink != true,
              let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              attributes[.type] as? FileAttributeType == .typeDirectory
        else { return false }
        return true
    }

    private static func isRegularFile(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else { return false }
        return values.isRegularFile == true && values.isSymbolicLink != true
    }

    private static func isDirectRegularSingleLinkFile(_ url: URL) -> Bool {
        guard isRegularFile(url),
              let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.referenceCount] as? NSNumber)?.intValue == 1
        else { return false }
        return true
    }

    private static func isContained(_ candidate: URL, in root: URL) -> Bool {
        let rootPath = root.standardizedFileURL.path.hasSuffix("/")
            ? root.standardizedFileURL.path
            : root.standardizedFileURL.path + "/"
        return candidate.standardizedFileURL.path.hasPrefix(rootPath)
    }

    private static func hasNoSymlinkComponents(_ candidate: URL, below root: URL) -> Bool {
        guard isContained(candidate, in: root) else { return false }
        let rootPath = root.standardizedFileURL.path.hasSuffix("/")
            ? root.standardizedFileURL.path
            : root.standardizedFileURL.path + "/"
        let relativePath = String(candidate.standardizedFileURL.path.dropFirst(rootPath.count))
        var current = root.standardizedFileURL
        for component in relativePath.split(separator: "/") {
            current.appendPathComponent(String(component))
            guard let values = try? current.resourceValues(forKeys: [.isSymbolicLinkKey]),
                  values.isSymbolicLink != true
            else { return false }
        }
        return true
    }
}

private struct ProjectPremiereFinishReviewErrorEnvelope: Decodable {
    let failure: ProjectPremiereFinishReviewFailure

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case version
        case code
        case message
    }

    init(from decoder: Decoder) throws {
        try requireExactKeys(decoder, CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(String.self, forKey: .version)
        let code = try container.decode(String.self, forKey: .code)
        let message = try container.decode(String.self, forKey: .message)
        try require(version == "premiere-finish-review-error/v1", decoder, "unsupported error version")
        try requireNonempty(message, decoder, "message")
        switch code {
        case "invalid_projection": failure = .invalidProjection
        case "unknown_value": failure = .unknownValue
        case "unsupported_profile": failure = .unsupportedProfile
        case "duplicate_target": failure = .duplicateTarget
        case "tool_unavailable": failure = .toolUnavailable
        case "preflight_contract_error": failure = .preflightContractError
        case "timeline_revision_changed": failure = .timelineRevisionChanged
        default: throw ProjectPremiereFinishReviewDecodeFailure.unknownValue
        }
    }
}

// MARK: - Refresh state

public enum ProjectPremiereFinishReviewState: Equatable, Sendable {
    case idle
    case loading(request: ProjectPremiereFinishReviewRequest)
    case loaded(request: ProjectPremiereFinishReviewRequest, projection: ProjectPremiereFinishReviewProjection)
    case failed(request: ProjectPremiereFinishReviewRequest, error: ProjectPremiereFinishReviewFailure)
}

public struct ProjectPremiereFinishReviewReducer: Equatable, Sendable {
    public private(set) var state: ProjectPremiereFinishReviewState

    public init(state: ProjectPremiereFinishReviewState = .idle) {
        self.state = state
    }

    public mutating func refresh(_ request: ProjectPremiereFinishReviewRequest) {
        state = .loading(request: request)
    }

    public mutating func cancel() {
        state = .idle
    }

    @discardableResult
    public mutating func receive(
        _ result: Result<ProjectPremiereFinishReviewProjection, ProjectPremiereFinishReviewFailure>,
        for request: ProjectPremiereFinishReviewRequest,
        selectedProjectID: String?,
        timelineSHA256: String?
    ) -> Bool {
        guard case let .loading(activeRequest) = state, activeRequest == request else {
            return false
        }
        guard selectedProjectID == request.projectGeneration.projectID else {
            state = .failed(request: request, error: .selectedProjectMismatch)
            return true
        }
        guard timelineSHA256 == request.projectGeneration.timelineSHA256 else {
            state = .failed(request: request, error: .timelineRevisionMismatch)
            return true
        }
        switch result {
        case .failure(let error):
            state = .failed(request: request, error: error)
        case .success(let projection):
            guard projection.projectID == request.projectGeneration.projectID else {
                state = .failed(request: request, error: .selectedProjectMismatch)
                return true
            }
            guard projection.baseTimelineSHA256 == request.projectGeneration.timelineSHA256 else {
                state = .failed(request: request, error: .timelineRevisionMismatch)
                return true
            }
            state = .loaded(request: request, projection: projection)
        }
        return true
    }
}

// MARK: - Common read-only route adapter

public enum ProjectPremiereFinishReviewEntry: String, CaseIterable, Equatable, Sendable {
    case menuPremiereXML = "menu.premiere_xml"
    case menuEditorPacket = "menu.editor_packet"
    case menuRevealPacket = "menu.reveal_packet"
    case commandPalettePremiereXML = "command_palette.premiere_xml"
    case commandPaletteEditorPacket = "command_palette.editor_packet"
    case projectInspectorPremiereXML = "project_inspector.premiere_xml"
    case projectInspectorEditorPacket = "project_inspector.editor_packet"
    case projectInspectorRevealPacket = "project_inspector.reveal_packet"
    case mediaPanelPremiereXML = "media_panel.premiere_xml"
    case mediaPanelEditorPacket = "media_panel.editor_packet"
    case mediaPanelRevealPacket = "media_panel.reveal_packet"
    case studioReadinessHandoffExportPacket = "studio_readiness.handoff_export_packet"
    case studioReadinessHandoffPacketStatus = "studio_readiness.handoff_packet_status"
}

public struct ProjectPremiereFinishReviewRouteAdapter {
    public typealias OpenReview = (_ entry: ProjectPremiereFinishReviewEntry) -> Void
    private let openReview: OpenReview

    public init(openReview: @escaping OpenReview) {
        self.openReview = openReview
    }

    public func route(_ entry: ProjectPremiereFinishReviewEntry) {
        openReview(entry)
    }
}

// MARK: - Strict decoding helpers

private enum ProjectPremiereFinishReviewDecodeFailure: Error {
    case unknownValue
}

private func decodeClosedEnum<Value: RawRepresentable>(
    _ type: Value.Type,
    from decoder: Decoder
) throws -> Value where Value.RawValue == String {
    let container = try decoder.singleValueContainer()
    let rawValue = try container.decode(String.self)
    guard let value = Value(rawValue: rawValue) else {
        throw ProjectPremiereFinishReviewDecodeFailure.unknownValue
    }
    return value
}

private func requireKnownValue(_ value: String, allowed: Set<String>) throws {
    guard allowed.contains(value) else {
        throw ProjectPremiereFinishReviewDecodeFailure.unknownValue
    }
}

private struct ProjectPremiereFinishReviewAnyCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

private func requireExactKeys<Key: CodingKey & CaseIterable>(
    _ decoder: Decoder,
    _ keyType: Key.Type
) throws where Key.AllCases: Collection {
    let container = try decoder.container(keyedBy: ProjectPremiereFinishReviewAnyCodingKey.self)
    let actual = Set(container.allKeys.map(\.stringValue))
    let expected = Set(Key.allCases.map(\.stringValue))
    guard actual == expected else {
        throw strictDecodingError(decoder, "object fields are not exact")
    }
}

private extension KeyedDecodingContainer {
    func decodeRequiredNullable<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T? {
        guard contains(key) else {
            throw DecodingError.keyNotFound(
                key,
                DecodingError.Context(codingPath: codingPath, debugDescription: "required nullable field is missing")
            )
        }
        if try decodeNil(forKey: key) { return nil }
        return try decode(type, forKey: key)
    }
}

private func strictDecodingError(_ decoder: Decoder, _ description: String) -> DecodingError {
    .dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: description))
}

private func require(_ condition: @autoclosure () -> Bool, _ decoder: Decoder, _ description: String) throws {
    guard condition() else { throw strictDecodingError(decoder, description) }
}

private func requireNonempty(_ value: String, _ decoder: Decoder, _ field: String) throws {
    try require(!value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, decoder, "\(field) must be nonempty")
}

private func requireSHA256(_ value: String, _ decoder: Decoder, _ field: String) throws {
    try require(isSHA256(value), decoder, "\(field) must be sha256:<64 lowercase hex>")
}

private func isSHA256(_ value: String) -> Bool {
    value.range(of: #"^sha256:[0-9a-f]{64}$"#, options: .regularExpression) != nil
}

private func validateSurfaceOrderAndUniqueness(
    _ surfaces: [ProjectPremiereFinishReviewSurface],
    decoder: Decoder
) throws {
    var previousGroup = -1
    var previousKeyByGroup: [Int: [String]] = [:]
    for surface in surfaces {
        let group: Int
        let key: [String]
        switch surface {
        case .text(let item):
            group = 0
            key = [item.target.trackID, item.target.clipID, item.target.overlayID]
        case .transition(let item):
            group = 1
            key = [item.target.trackID, item.target.transitionID, item.target.fromClipID, item.target.toClipID]
        case .audio(let item):
            group = 2
            key = [item.target.trackID, item.target.clipID, item.target.effectID]
        case .visualEffect(let item):
            group = 3
            key = [item.target.trackID, item.target.clipID]
        }
        try require(group >= previousGroup, decoder, "surface kinds are not in canonical order")
        if let previous = previousKeyByGroup[group] {
            try require(compareUTF8Tuples(previous, key) < 0, decoder, "surface targets are duplicate or unsorted")
        }
        previousKeyByGroup[group] = key
        previousGroup = group
    }
}

private func compareUTF8Tuples(_ left: [String], _ right: [String]) -> Int {
    for (lhs, rhs) in zip(left, right) {
        if lhs == rhs { continue }
        return lhs.utf8.lexicographicallyPrecedes(rhs.utf8) ? -1 : 1
    }
    if left.count == right.count { return 0 }
    return left.count < right.count ? -1 : 1
}
