import Foundation

public enum CaptionReviewState: String, Codable, CaseIterable, Sendable {
    case unreviewed
    case verified
    case flagged

    public var localizedLabel: String {
        switch self {
        case .unreviewed: return "未確認"
        case .verified: return "確認済み"
        case .flagged: return "要確認"
        }
    }
}

public enum CaptionReviewSeverity: String, Codable, CaseIterable, Sendable {
    case info
    case warn
    case block

    public var localizedLabel: String {
        switch self {
        case .info: return "情報"
        case .warn: return "注意"
        case .block: return "修正必須"
        }
    }
}

public struct CaptionReviewIssue: Codable, Equatable, Identifiable, Sendable {
    public var id: String { "\(code):\(message)" }
    public let code: String
    public let severity: CaptionReviewSeverity
    public let message: String
    public let evidence: [String]?

    public init(
        code: String,
        severity: CaptionReviewSeverity,
        message: String,
        evidence: [String]? = nil
    ) {
        self.code = code
        self.severity = severity
        self.message = message
        self.evidence = evidence
    }
}

public struct CaptionReviewQueueItem: Codable, Equatable, Identifiable, Sendable {
    public var id: String { captionID }
    public let captionID: String
    public let timelineInFrame: Int
    public let timelineDurationFrames: Int
    public let text: String
    public let sourceText: String?
    public let textHash: String
    public let reviewState: CaptionReviewState
    public let riskScore: Double
    public let issues: [CaptionReviewIssue]

    enum CodingKeys: String, CodingKey {
        case captionID = "caption_id"
        case timelineInFrame = "timeline_in_frame"
        case timelineDurationFrames = "timeline_duration_frames"
        case text
        case sourceText = "source_text"
        case textHash = "text_hash"
        case reviewState = "review_state"
        case riskScore = "risk_score"
        case issues
    }

    public init(
        captionID: String,
        timelineInFrame: Int,
        timelineDurationFrames: Int,
        text: String,
        sourceText: String? = nil,
        textHash: String,
        reviewState: CaptionReviewState,
        riskScore: Double,
        issues: [CaptionReviewIssue]
    ) {
        self.captionID = captionID
        self.timelineInFrame = timelineInFrame
        self.timelineDurationFrames = timelineDurationFrames
        self.text = text
        self.sourceText = sourceText
        self.textHash = textHash
        self.reviewState = reviewState
        self.riskScore = riskScore
        self.issues = issues
    }

    public var hasBlockingIssue: Bool {
        issues.contains { $0.severity == .block }
    }

    public var hasWarning: Bool {
        issues.contains { $0.severity == .warn }
    }

    public var timelineOutFrame: Int {
        timelineInFrame + timelineDurationFrames
    }
}

public struct CaptionGlossaryProposal: Codable, Equatable, Identifiable, Sendable {
    public var id: String { "\(canonical):\(sourceCaptionIDs.joined(separator: ","))" }
    public let canonical: String
    public let variants: [String]
    public let sourceCaptionIDs: [String]

    enum CodingKeys: String, CodingKey {
        case canonical
        case variants
        case sourceCaptionIDs = "source_caption_ids"
    }

    public init(canonical: String, variants: [String], sourceCaptionIDs: [String]) {
        self.canonical = canonical
        self.variants = variants
        self.sourceCaptionIDs = sourceCaptionIDs
    }
}

public struct CaptionReviewQueueDocument: Codable, Equatable, Sendable {
    public let version: String
    public let project: String
    public let fps: Double
    public let captionStyle: CaptionReviewPreviewStyle
    public let canUndo: Bool
    public let undoDepth: Int
    public let glossaryProposals: [CaptionGlossaryProposal]
    public let totalCaptionCount: Int
    public let matchedCaptionCount: Int
    public let exportedCaptionCount: Int
    public let items: [CaptionReviewQueueItem]
    public let status: String
    public let baseCaptionDraftHash: String?
    public let recoveryAction: CaptionReviewRecoveryAction?
    public let approvalReadiness: CaptionApprovalReadiness
    public let safeBulkReview: CaptionSafeBulkReview
    public let fontContract: CaptionFontContract?
    public let currentApproval: CaptionCurrentApproval?
    public let approvalWarning: CaptionApprovalWarning?

    enum CodingKeys: String, CodingKey {
        case version
        case project
        case fps
        case captionStyle = "caption_style"
        case canUndo = "can_undo"
        case undoDepth = "undo_depth"
        case glossaryProposals = "glossary_proposals"
        case totalCaptionCount = "total_caption_count"
        case matchedCaptionCount = "matched_caption_count"
        case exportedCaptionCount = "exported_caption_count"
        case items
        case status
        case baseCaptionDraftHash = "base_caption_draft_hash"
        case recoveryAction = "recovery_action"
        case approvalReadiness = "approval_readiness"
        case safeBulkReview = "safe_bulk_review"
        case fontContract = "font_contract"
        case currentApproval = "current_approval"
        case approvalWarning = "approval_warning"
    }

    public init(
        version: String = "caption-review-queue/v1",
        project: String,
        fps: Double = 24,
        captionStyle: CaptionReviewPreviewStyle = .default,
        canUndo: Bool = false,
        undoDepth: Int = 0,
        glossaryProposals: [CaptionGlossaryProposal] = [],
        totalCaptionCount: Int,
        matchedCaptionCount: Int,
        exportedCaptionCount: Int,
        items: [CaptionReviewQueueItem],
        status: String = "ready",
        baseCaptionDraftHash: String? = nil,
        recoveryAction: CaptionReviewRecoveryAction? = nil,
        approvalReadiness: CaptionApprovalReadiness? = nil,
        safeBulkReview: CaptionSafeBulkReview = .empty,
        fontContract: CaptionFontContract? = nil,
        currentApproval: CaptionCurrentApproval? = nil,
        approvalWarning: CaptionApprovalWarning? = nil
    ) {
        self.version = version
        self.project = project
        self.fps = fps
        self.captionStyle = captionStyle
        self.canUndo = canUndo
        self.undoDepth = undoDepth
        self.glossaryProposals = glossaryProposals
        self.totalCaptionCount = totalCaptionCount
        self.matchedCaptionCount = matchedCaptionCount
        self.exportedCaptionCount = exportedCaptionCount
        self.items = items
        self.status = status
        self.baseCaptionDraftHash = baseCaptionDraftHash
        self.recoveryAction = recoveryAction
        self.approvalReadiness = approvalReadiness ?? .legacy(items: items)
        self.safeBulkReview = safeBulkReview
        self.fontContract = fontContract
        self.currentApproval = currentApproval
        self.approvalWarning = approvalWarning
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(String.self, forKey: .version)
        project = try values.decode(String.self, forKey: .project)
        fps = try values.decodeIfPresent(Double.self, forKey: .fps) ?? 24
        captionStyle = try values.decodeIfPresent(CaptionReviewPreviewStyle.self, forKey: .captionStyle) ?? .default
        canUndo = try values.decodeIfPresent(Bool.self, forKey: .canUndo) ?? false
        undoDepth = try values.decodeIfPresent(Int.self, forKey: .undoDepth) ?? (canUndo ? 1 : 0)
        glossaryProposals = try values.decodeIfPresent([CaptionGlossaryProposal].self, forKey: .glossaryProposals) ?? []
        totalCaptionCount = try values.decode(Int.self, forKey: .totalCaptionCount)
        matchedCaptionCount = try values.decode(Int.self, forKey: .matchedCaptionCount)
        exportedCaptionCount = try values.decode(Int.self, forKey: .exportedCaptionCount)
        items = try values.decode([CaptionReviewQueueItem].self, forKey: .items)
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? "ready"
        baseCaptionDraftHash = try values.decodeIfPresent(String.self, forKey: .baseCaptionDraftHash)
        recoveryAction = try values.decodeIfPresent(CaptionReviewRecoveryAction.self, forKey: .recoveryAction)
        approvalReadiness = try values.decodeIfPresent(CaptionApprovalReadiness.self, forKey: .approvalReadiness)
            ?? .legacy(items: items)
        safeBulkReview = try values.decodeIfPresent(CaptionSafeBulkReview.self, forKey: .safeBulkReview) ?? .empty
        fontContract = try values.decodeIfPresent(CaptionFontContract.self, forKey: .fontContract)
        currentApproval = try values.decodeIfPresent(CaptionCurrentApproval.self, forKey: .currentApproval)
        approvalWarning = try values.decodeIfPresent(CaptionApprovalWarning.self, forKey: .approvalWarning)
    }

    public var blockingCount: Int {
        items.filter(\.hasBlockingIssue).count
    }

    public var warningCount: Int {
        items.filter { !$0.hasBlockingIssue && $0.hasWarning }.count
    }

    public var verifiedCount: Int {
        items.filter { $0.reviewState == .verified }.count
    }

    public var flaggedCount: Int {
        items.filter { $0.reviewState == .flagged }.count
    }
}

public struct CaptionCurrentApproval: Codable, Equatable, Sendable {
    public let status: String
    public let hash: String
}

public struct CaptionApprovalWarning: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
}

public struct CaptionReviewRecoveryAction: Codable, Equatable, Sendable {
    public let code: String
    public let label: String
    public let command: [String]
    public let safeToRun: Bool
    public let message: String
    enum CodingKeys: String, CodingKey { case code, label, command, message; case safeToRun = "safe_to_run" }
}

public struct CaptionApprovalReadiness: Codable, Equatable, Sendable {
    public struct Blocker: Codable, Equatable, Identifiable, Sendable {
        public var id: String { code }
        public let code: String
        public let message: String
    }
    public let canApprove: Bool
    public let blockers: [Blocker]
    public let warningIssueCount: Int
    public let warningsAcknowledged: Bool
    enum CodingKeys: String, CodingKey {
        case canApprove = "can_approve"; case blockers
        case warningIssueCount = "warning_issue_count"; case warningsAcknowledged = "warnings_acknowledged"
    }
    static func legacy(items: [CaptionReviewQueueItem]) -> Self {
        let canApprove = !items.isEmpty && items.allSatisfy { $0.reviewState == .verified && !$0.hasBlockingIssue }
        return Self(canApprove: canApprove, blockers: [], warningIssueCount: 0, warningsAcknowledged: canApprove)
    }
}

public struct CaptionSafeBulkReview: Codable, Equatable, Sendable {
    public struct Excluded: Codable, Equatable, Identifiable, Sendable {
        public var id: String { captionID }
        public let captionID: String
        public let reasons: [String]
        enum CodingKeys: String, CodingKey { case captionID = "caption_id"; case reasons }
    }
    public let eligibleCaptionIDs: [String]
    public let eligibleCount: Int
    public let excluded: [Excluded]
    public let exclusionReasonCounts: [String: Int]
    enum CodingKeys: String, CodingKey {
        case eligibleCaptionIDs = "eligible_caption_ids"; case eligibleCount = "eligible_count"
        case excluded; case exclusionReasonCounts = "exclusion_reason_counts"
    }
    public static let empty = Self(eligibleCaptionIDs: [], eligibleCount: 0, excluded: [], exclusionReasonCounts: [:])
}

public struct CaptionFontContract: Codable, Equatable, Sendable {
    public struct Diagnostic: Codable, Equatable, Sendable { public let code: String; public let message: String }
    public let status: String
    public let fontID: String
    public let family: String
    public let fallbackUsed: Bool
    public let diagnostics: [Diagnostic]
    enum CodingKeys: String, CodingKey {
        case status; case fontID = "font_id"; case family; case fallbackUsed = "fallback_used"; case diagnostics
    }
}

public struct CaptionReviewPreviewStyle: Codable, Equatable, Sendable {
    public static let defaultFontID = "noto-sans-jp"
    public static let defaultFontFamily = "VideoOS Noto Sans JP Bold"

    public enum Alignment: String, Codable, Sendable {
        case bottomCenter = "bottom_center"
        case center
        case topCenter = "top_center"
    }

    public let presetID: String
    public let fontID: String
    public let fontFamily: String
    public let fontWeight: Int
    public let fontSizePx1080: Double
    public let lineHeightPx1080: Double
    public let outlinePx1080: Double
    public let marginV1080: Double
    public let maxWidthRatio: Double
    public let alignment: Alignment

    enum CodingKeys: String, CodingKey {
        case presetID = "preset_id"
        case fontID = "font_id"
        case fontFamily = "font_family"
        case fontWeight = "font_weight"
        case fontSizePx1080 = "font_size_px_1080"
        case lineHeightPx1080 = "line_height_px_1080"
        case outlinePx1080 = "outline_px_1080"
        case marginV1080 = "margin_v_1080"
        case maxWidthRatio = "max_width_ratio"
        case alignment
    }

    public init(
        presetID: String,
        fontID: String = CaptionReviewPreviewStyle.defaultFontID,
        fontFamily: String,
        fontWeight: Int,
        fontSizePx1080: Double,
        lineHeightPx1080: Double,
        outlinePx1080: Double,
        marginV1080: Double,
        maxWidthRatio: Double,
        alignment: Alignment
    ) {
        self.presetID = presetID
        self.fontID = fontID
        self.fontFamily = fontFamily
        self.fontWeight = fontWeight
        self.fontSizePx1080 = fontSizePx1080
        self.lineHeightPx1080 = lineHeightPx1080
        self.outlinePx1080 = outlinePx1080
        self.marginV1080 = marginV1080
        self.maxWidthRatio = maxWidthRatio
        self.alignment = alignment
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        presetID = try values.decode(String.self, forKey: .presetID)
        fontID = try values.decodeIfPresent(String.self, forKey: .fontID) ?? Self.defaultFontID
        fontFamily = try values.decode(String.self, forKey: .fontFamily)
        fontWeight = try values.decode(Int.self, forKey: .fontWeight)
        fontSizePx1080 = try values.decode(Double.self, forKey: .fontSizePx1080)
        lineHeightPx1080 = try values.decode(Double.self, forKey: .lineHeightPx1080)
        outlinePx1080 = try values.decode(Double.self, forKey: .outlinePx1080)
        marginV1080 = try values.decode(Double.self, forKey: .marginV1080)
        maxWidthRatio = try values.decode(Double.self, forKey: .maxWidthRatio)
        alignment = try values.decode(Alignment.self, forKey: .alignment)
    }

    public static let `default` = CaptionReviewPreviewStyle(
        presetID: "default",
        fontID: defaultFontID,
        fontFamily: defaultFontFamily,
        fontWeight: 700,
        fontSizePx1080: 24,
        lineHeightPx1080: 32,
        outlinePx1080: 2,
        marginV1080: 44,
        maxWidthRatio: 0.88,
        alignment: .bottomCenter
    )

    public enum PreviewFontWeight: String, Equatable, Sendable {
        case regular
        case bold
        case heavy
        case black
    }

    public static func previewFontWeight(for numericWeight: Int) -> PreviewFontWeight {
        switch numericWeight {
        case 900...:
            return .black
        case 800...:
            return .heavy
        case 700...:
            return .bold
        default:
            return .regular
        }
    }

    public var previewFontWeight: PreviewFontWeight {
        Self.previewFontWeight(for: fontWeight)
    }
}
