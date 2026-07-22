import Foundation

public enum BGMMusicalFit: String, Codable, CaseIterable, Sendable {
    case pending
    case approved
    case rejected

    public var isResolved: Bool { self != .pending }
}

public enum BGMPassFailReview: String, Codable, CaseIterable, Sendable {
    case pending
    case passed
    case failed

    public var isResolved: Bool { self != .pending }
}

public enum BGMOriginalityReview: String, Codable, CaseIterable, Sendable {
    case pending
    case passed
    case concern

    public var isResolved: Bool { self != .pending }
}

public enum BGMRightsReview: String, Codable, CaseIterable, Sendable {
    case pending
    case operatorDeclaredOK = "operator_declared_ok"
    case licensed
    case blocked

    public var isResolved: Bool { self != .pending }
    public var permitsCandidatePromotion: Bool { self == .operatorDeclaredOK || self == .licensed }
}

public struct BGMShortlistHumanReview: Codable, Equatable, Sendable {
    public let musicalFit: BGMMusicalFit
    public let dialogueBed: BGMPassFailReview
    public let artifactQuality: BGMPassFailReview
    public let originality: BGMOriginalityReview
    public let rights: BGMRightsReview
    public let reviewerRef: String?
    public let reviewedAt: String?
    public let notes: [String]

    enum CodingKeys: String, CodingKey {
        case musicalFit = "musical_fit"
        case dialogueBed = "dialogue_bed"
        case artifactQuality = "artifact_quality"
        case originality
        case rights
        case reviewerRef = "reviewer_ref"
        case reviewedAt = "reviewed_at"
        case notes
    }

    public var isComplete: Bool {
        musicalFit.isResolved
            && dialogueBed.isResolved
            && artifactQuality.isResolved
            && originality.isResolved
            && rights.isResolved
            && !(reviewerRef?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
            && reviewedAt != nil
    }

    public var passesCandidateGate: Bool {
        musicalFit == .approved
            && dialogueBed == .passed
            && artifactQuality == .passed
            && originality == .passed
            && rights.permitsCandidatePromotion
    }
}

public struct BGMShortlistReviewCandidate: Codable, Equatable, Identifiable, Sendable {
    public var id: String { candidateID }
    public let candidateID: String
    public let technicalRank: Int
    public let batch: Int
    public let filename: String
    public let sourceRef: String
    public let contentHash: String
    public let sizeBytes: Int?
    public let sourceVerified: Bool
    public let targetDurationSeconds: Double
    public let durationSeconds: Double
    public let targetBPM: Double
    public let measuredBPM: Double
    public let normalizedBPM: Double
    public let technicalScore: Double
    public let sourceComment: String
    public let recommendedForAudition: Bool
    public let review: BGMShortlistHumanReview
    public let promotionEligible: Bool

    enum CodingKeys: String, CodingKey {
        case candidateID = "candidate_id"
        case technicalRank = "technical_rank"
        case batch
        case filename
        case sourceRef = "source_ref"
        case contentHash = "content_hash"
        case sizeBytes = "size_bytes"
        case sourceVerified = "source_verified"
        case targetDurationSeconds = "target_duration_sec"
        case durationSeconds = "duration_sec"
        case targetBPM = "target_bpm"
        case measuredBPM = "measured_bpm"
        case normalizedBPM = "normalized_bpm"
        case technicalScore = "technical_score"
        case sourceComment = "source_comment"
        case recommendedForAudition = "recommended_for_audition"
        case review
        case promotionEligible = "promotion_eligible"
    }
}

public struct BGMShortlistReviewTrack: Codable, Equatable, Identifiable, Sendable {
    public var id: String { trackID }
    public let trackID: String
    public let workingTitle: String
    public let family: String
    public let intensity: String
    public let useCases: [String]
    public let note: String
    public let candidates: [BGMShortlistReviewCandidate]

    enum CodingKeys: String, CodingKey {
        case trackID = "track_id"
        case workingTitle = "working_title"
        case family
        case intensity
        case useCases = "use_cases"
        case note
        case candidates
    }

    public init(
        trackID: String,
        workingTitle: String,
        family: String,
        intensity: String,
        useCases: [String],
        note: String,
        candidates: [BGMShortlistReviewCandidate]
    ) {
        self.trackID = trackID
        self.workingTitle = workingTitle
        self.family = family
        self.intensity = intensity
        self.useCases = useCases
        self.note = note
        self.candidates = candidates
    }
}

public struct BGMShortlistReviewCounts: Codable, Equatable, Sendable {
    public let tracks: Int
    public let shortlistedCandidates: Int
    public let sourceVerified: Int
    public let promotionEligible: Int
    public let errors: Int
    public let warnings: Int

    enum CodingKeys: String, CodingKey {
        case tracks
        case shortlistedCandidates = "shortlisted_candidates"
        case sourceVerified = "source_verified"
        case promotionEligible = "promotion_eligible"
        case errors
        case warnings
    }
}

public struct BGMShortlistReviewSource: Codable, Equatable, Sendable {
    public let shortlistHash: String
    public let shortlistCreatedAt: String
    public let candidateCountConsidered: Int
    public let methodWarning: String

    enum CodingKeys: String, CodingKey {
        case shortlistHash = "shortlist_hash"
        case shortlistCreatedAt = "shortlist_created_at"
        case candidateCountConsidered = "candidate_count_considered"
        case methodWarning = "method_warning"
    }
}

public struct BGMShortlistReviewCatalog: Codable, Equatable, Sendable {
    public let packID: String
    public let schemaVersion: String
    public let contentHash: String

    enum CodingKeys: String, CodingKey {
        case packID = "pack_id"
        case schemaVersion = "schema_version"
        case contentHash = "content_hash"
    }
}

public struct BGMShortlistReviewIssue: Codable, Equatable, Identifiable, Sendable {
    public var id: String { "\(code):\(affectedRef)" }
    public let code: String
    public let severity: String
    public let affectedRef: String
    public let message: String
    public let suggestedAction: String

    enum CodingKeys: String, CodingKey {
        case code
        case severity
        case affectedRef = "affected_ref"
        case message
        case suggestedAction = "suggested_action"
    }
}

public struct BGMShortlistReviewDocument: Codable, Equatable, Sendable {
    public let version: String
    public let artifactKind: String
    public let createdAt: String
    public let source: BGMShortlistReviewSource
    public let catalog: BGMShortlistReviewCatalog
    public let status: String
    public let counts: BGMShortlistReviewCounts
    public let tracks: [BGMShortlistReviewTrack]
    public let issues: [BGMShortlistReviewIssue]

    enum CodingKeys: String, CodingKey {
        case version
        case artifactKind = "artifact_kind"
        case createdAt = "created_at"
        case source
        case catalog
        case status
        case counts
        case tracks
        case issues
    }

    public var candidates: [BGMShortlistReviewCandidate] {
        tracks.flatMap(\.candidates)
    }

    public var completedReviewCount: Int {
        candidates.filter { $0.review.isComplete }.count
    }

    public func track(containing candidateID: String) -> BGMShortlistReviewTrack? {
        tracks.first { track in track.candidates.contains { $0.candidateID == candidateID } }
    }

    public func candidate(id: String?) -> BGMShortlistReviewCandidate? {
        guard let id else { return nil }
        return candidates.first { $0.candidateID == id }
    }
}

public struct BGMReviewDocumentError: Error, Equatable, LocalizedError, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

public enum BGMReviewDocumentLoader {
    public static func load(from queueURL: URL) throws -> BGMShortlistReviewDocument {
        let data = try Data(contentsOf: queueURL)
        let document = try JSONDecoder().decode(BGMShortlistReviewDocument.self, from: data)
        try validate(document)
        return document
    }

    public static func validate(_ document: BGMShortlistReviewDocument) throws {
        guard document.version == "1.0.0", document.artifactKind == "bgm-shortlist-review" else {
            throw BGMReviewDocumentError("対応していないBGMレビューキューです。")
        }
        let candidates = document.candidates
        guard !document.tracks.isEmpty, !candidates.isEmpty else {
            throw BGMReviewDocumentError("BGMレビュー候補がありません。")
        }
        guard Set(document.tracks.map(\.trackID)).count == document.tracks.count,
              Set(candidates.map(\.candidateID)).count == candidates.count else {
            throw BGMReviewDocumentError("BGMレビューキューに重複IDがあります。")
        }
        guard document.counts.tracks == document.tracks.count,
              document.counts.shortlistedCandidates == candidates.count,
              document.counts.sourceVerified == candidates.filter(\.sourceVerified).count,
              document.counts.promotionEligible == candidates.filter(\.promotionEligible).count else {
            throw BGMReviewDocumentError("BGMレビューキューの集計値が候補データと一致しません。")
        }
        guard candidates.allSatisfy({ $0.sourceVerified && $0.contentHash.hasPrefix("sha256:") }) else {
            throw BGMReviewDocumentError("元音源の検証が完了していない候補が含まれています。")
        }
    }
}
