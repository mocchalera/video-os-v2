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

// MARK: - RFA-020 visual-treatment projection

public enum CaptionVisualTreatmentStatus: String, Codable, CaseIterable, Sendable {
    case ready
    case fallback
    case humanHold = "human_hold"
    case blocked

    public var localizedLabel: String {
        switch self {
        case .ready: return "canonical準備済み"
        case .fallback: return "登録fallback"
        case .humanHold: return "HOLD / NLE確認"
        case .blocked: return "BLOCK"
        }
    }
}

public enum CaptionVisualAnchor: String, Codable, CaseIterable, Sendable {
    case topLeft = "top_left"
    case topCenter = "top_center"
    case topRight = "top_right"
    case center
    case bottomLeft = "bottom_left"
    case bottomCenter = "bottom_center"
    case bottomRight = "bottom_right"

    public var localizedLabel: String {
        switch self {
        case .topLeft: return "左上"
        case .topCenter: return "上中央"
        case .topRight: return "右上"
        case .center: return "中央"
        case .bottomLeft: return "左下"
        case .bottomCenter: return "下中央"
        case .bottomRight: return "右下"
        }
    }
}

public enum CaptionVisualFallback: String, Codable, CaseIterable, Sendable {
    case registeredFallback = "registered_fallback"
    case nleHandoff = "nle_handoff"
    case blocker

    public var localizedLabel: String {
        switch self {
        case .registeredFallback: return "登録fallback"
        case .nleHandoff: return "NLE handoff"
        case .blocker: return "blocker"
        }
    }
}

public enum CaptionVisualHierarchyRole: String, Codable, CaseIterable, Sendable {
    case speech
    case keyword
    case annotation
    case speaker
    case cta
}

public struct CaptionVisualRect: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct CaptionVisualTreatmentOperation: Codable, Equatable, Identifiable, Sendable {
    /// The operation identity follows the stable caption identity. It must
    /// not change when a reviewer changes style or anchor.
    public var id: String { captionID }
    public var captionID: String
    public var stableRootID: String
    public var expectedCurrentHash: String?
    public var anchor: CaptionVisualAnchor
    public var rect: CaptionVisualRect?
    public var styleRef: String
    public var referenceScale: Double?
    public var hierarchyRole: CaptionVisualHierarchyRole?
    public var emphasisRef: String?
    public var animationRef: String?
    public var effectRef: String?
    public var fallback: CaptionVisualFallback

    public init(
        captionID: String,
        stableRootID: String,
        expectedCurrentHash: String? = nil,
        anchor: CaptionVisualAnchor,
        rect: CaptionVisualRect? = nil,
        styleRef: String,
        referenceScale: Double? = nil,
        hierarchyRole: CaptionVisualHierarchyRole? = nil,
        emphasisRef: String? = nil,
        animationRef: String? = nil,
        effectRef: String? = nil,
        fallback: CaptionVisualFallback = .registeredFallback
    ) {
        self.captionID = captionID
        self.stableRootID = stableRootID
        self.expectedCurrentHash = expectedCurrentHash
        self.anchor = anchor
        self.rect = rect
        self.styleRef = styleRef
        self.referenceScale = referenceScale
        self.hierarchyRole = hierarchyRole
        self.emphasisRef = emphasisRef
        self.animationRef = animationRef
        self.effectRef = effectRef
        self.fallback = fallback
    }

    enum CodingKeys: String, CodingKey {
        case captionID = "caption_id"
        case stableRootID = "stable_root_id"
        case expectedCurrentHash = "expected_current_hash"
        case anchor
        case rect
        case styleRef = "style_ref"
        case referenceScale = "reference_scale"
        case hierarchyRole = "hierarchy_role"
        case emphasisRef = "emphasis_ref"
        case animationRef = "animation_ref"
        case effectRef = "effect_ref"
        case fallback
    }
}

/// Collects local drag/resize changes and emits one canonical commit at
/// gesture end. Changed events never call the service.
public struct CaptionVisualGestureCommitState: Equatable, Sendable {
    public private(set) var pendingOperation: CaptionVisualTreatmentOperation?

    public init() {}

    public mutating func changed(_ operation: CaptionVisualTreatmentOperation) {
        pendingOperation = operation
    }

    public mutating func ended() -> CaptionVisualTreatmentOperation? {
        defer { pendingOperation = nil }
        return pendingOperation
    }
}

public struct CaptionVisualIdentity: Codable, Equatable, Sendable {
    public let captionID: String
    public let stableRootID: String
    public let parentIDs: [String]?
    public let lineageHash: String?
    public let text: String
    public let timelineInFrame: Int
    public let timelineDurationFrames: Int
    public let treatment: CaptionVisualTreatmentOperation?
    public let requestedTreatment: CaptionVisualTreatmentOperation?

    enum CodingKeys: String, CodingKey {
        case captionID = "caption_id"
        case stableRootID = "stable_root_id"
        case parentIDs = "parent_ids"
        case lineageHash = "lineage_hash"
        case text
        case timelineInFrame = "timeline_in_frame"
        case timelineDurationFrames = "timeline_duration_frames"
        case treatment
        case requestedTreatment = "requested_treatment"
    }
}

/// Canonical service projection used by Studio's viewer. It is deliberately
/// data-only: Swift does not recreate the style registry or renderer rules.
public struct CaptionVisualResolvedProjection: Codable, Equatable, Sendable {
    public let captionID: String
    public let stableRootID: String
    public let styleRef: String
    public let fontFamily: String
    public let fontWeight: Int
    public let fontSizePx1080: Double
    public let lineHeightPx1080: Double
    public let fillRGBA: String
    public let outlineRGBA: String
    public let outlinePx1080: Double
    public let shadowPx1080: Double
    public let maxWidthRatio: Double
    public let alignment: String
    public let emphasisScale: Double
    public let effectRef: String?
    public let animationRef: String?
    public let hierarchyRole: String?
    public let effectSupported: Bool
    public let animationSupported: Bool
    public let hierarchySupported: Bool?
    public let hierarchyPreviewSupported: Bool?
    public let animationPreviewSupported: Bool?
    public let outlineEnabled: Bool
    public let shadowEnabled: Bool
    public let panelEnabled: Bool

    enum CodingKeys: String, CodingKey {
        case captionID = "caption_id"
        case stableRootID = "stable_root_id"
        case styleRef = "style_ref"
        case fontFamily = "font_family"
        case fontWeight = "font_weight"
        case fontSizePx1080 = "font_size_px_1080"
        case lineHeightPx1080 = "line_height_px_1080"
        case fillRGBA = "fill_rgba"
        case outlineRGBA = "outline_rgba"
        case outlinePx1080 = "outline_px_1080"
        case shadowPx1080 = "shadow_px_1080"
        case maxWidthRatio = "max_width_ratio"
        case alignment
        case emphasisScale = "emphasis_scale"
        case effectRef = "effect_ref"
        case animationRef = "animation_ref"
        case hierarchyRole = "hierarchy_role"
        case effectSupported = "effect_supported"
        case animationSupported = "animation_supported"
        case hierarchySupported = "hierarchy_supported"
        case hierarchyPreviewSupported = "hierarchy_preview_supported"
        case animationPreviewSupported = "animation_preview_supported"
        case outlineEnabled = "outline_enabled"
        case shadowEnabled = "shadow_enabled"
        case panelEnabled = "panel_enabled"
    }

    public var studioPreviewSupported: Bool {
        effectSupported && animationPreviewSupported == true && hierarchyPreviewSupported == true
    }

    public var studioPreviewUnavailableReasons: [String] {
        var reasons: [String] = []
        if !effectSupported { reasons.append("canonical effect capability is unavailable") }
        if animationSupported && animationPreviewSupported != true {
            let animation = animationRef ?? "unknown"
            reasons.append("canonical animation \(animation) is supported, but Studio exact animation preview is unavailable")
        }
        if hierarchyRole != nil && hierarchyPreviewSupported != true {
            let hierarchy = hierarchyRole ?? "unknown"
            reasons.append("canonical hierarchy \(hierarchy) is supported by the renderer, but Studio exact hierarchy preview is unavailable")
        }
        return reasons
    }
}

public struct CaptionVisualReason: Codable, Equatable, Identifiable, Sendable {
    public var id: String { "\(captionID):\(reason)" }
    public let captionID: String
    public let reason: String

    enum CodingKeys: String, CodingKey {
        case captionID = "caption_id"
        case reason
    }
}

public struct CaptionVisualFallbackReason: Codable, Equatable, Identifiable, Sendable {
    public var id: String { "\(captionID):\(kind.rawValue):\(reason)" }
    public let captionID: String
    public let kind: CaptionVisualFallback
    public let reason: String

    enum CodingKeys: String, CodingKey {
        case captionID = "caption_id"
        case kind
        case reason
    }
}

public struct CaptionVisualAccessibility: Codable, Equatable, Sendable {
    public let reducedMotion: Bool
    public let highContrast: Bool
    public let audioOff: Bool
    public let smallScreen: Bool

    public init(
        reducedMotion: Bool = false,
        highContrast: Bool = false,
        audioOff: Bool = false,
        smallScreen: Bool = false
    ) {
        self.reducedMotion = reducedMotion
        self.highContrast = highContrast
        self.audioOff = audioOff
        self.smallScreen = smallScreen
    }

    enum CodingKeys: String, CodingKey {
        case reducedMotion = "reduced_motion"
        case highContrast = "high_contrast"
        case audioOff = "audio_off"
        case smallScreen = "small_screen"
    }
}

public struct CaptionVisualTreatmentCapabilities: Codable, Equatable, Sendable {
    public let styleRefs: [String]
    public let emphasisRefs: [String]
    public let animationRefs: [String]
    public let effectRefs: [String]
    public let hierarchyRoles: [String]

    enum CodingKeys: String, CodingKey {
        case styleRefs = "style_refs"
        case emphasisRefs = "emphasis_refs"
        case animationRefs = "animation_refs"
        case effectRefs = "effect_refs"
        case hierarchyRoles = "hierarchy_roles"
    }

    public init(
        styleRefs: [String] = [],
        emphasisRefs: [String] = [],
        animationRefs: [String] = [],
        effectRefs: [String] = [],
        hierarchyRoles: [String] = []
    ) {
        self.styleRefs = styleRefs
        self.emphasisRefs = emphasisRefs
        self.animationRefs = animationRefs
        self.effectRefs = effectRefs
        self.hierarchyRoles = hierarchyRoles
    }

    public func supports(_ operation: CaptionVisualTreatmentOperation) -> [String] {
        var missing: [String] = []
        if !styleRefs.contains(operation.styleRef) { missing.append("style_ref=\(operation.styleRef)") }
        if let value = operation.emphasisRef, !emphasisRefs.contains(value) { missing.append("emphasis_ref=\(value)") }
        if let value = operation.animationRef, !animationRefs.contains(value) { missing.append("animation_ref=\(value)") }
        if let value = operation.effectRef, !effectRefs.contains(value) { missing.append("effect_ref=\(value)") }
        if let value = operation.hierarchyRole, !hierarchyRoles.contains(value.rawValue) { missing.append("hierarchy_role=\(value.rawValue)") }
        return missing
    }
}

public struct CaptionVisualRendererRoute: Codable, Equatable, Sendable {
    public let speechCaptions: String
    public let graphicalContent: CaptionVisualGraphicalRoute

    enum CodingKeys: String, CodingKey {
        case speechCaptions = "speech_captions"
        case graphicalContent = "graphical_content"
    }
}

public struct CaptionVisualGraphicalRoute: Codable, Equatable, Sendable {
    public let available: [String]
    public let selected: String
    public let status: String
}

public struct CaptionVisualGraphicalContentIdentity: Codable, Equatable, Sendable {
    public let overlayID: String
    public let text: String
    public let timelineInFrame: Int
    public let timelineDurationFrames: Int
    public let stylingClass: String
    public let anchor: String

    enum CodingKeys: String, CodingKey {
        case overlayID = "overlay_id"
        case text
        case timelineInFrame = "timeline_in_frame"
        case timelineDurationFrames = "timeline_duration_frames"
        case stylingClass = "styling_class"
        case anchor
    }
}

public struct CaptionVisualTreatmentInputDocument: Codable, Equatable, Sendable {
    public let version: String
    public let projectID: String
    public let approvalHash: String
    public let typographyPolicyHash: String
    public let visualTreatmentPatchHash: String?
    public let platformSafeZoneProfileID: String?
    public let platformSafeZoneProfilePath: String?
    public let platformSafeZoneProfileHash: String?
    public let resolvedProjection: [CaptionVisualResolvedProjection]?
    public let captionIdentity: [CaptionVisualIdentity]
    public let graphicalContentIdentity: [CaptionVisualGraphicalContentIdentity]
    public let status: CaptionVisualTreatmentStatus
    public let fallbacks: [CaptionVisualFallbackReason]
    public let rendererRoute: CaptionVisualRendererRoute
    public let textTimingHash: String
    public let capabilityHash: String
    public let accessibility: CaptionVisualAccessibility?
    public let appliedCaptionIDs: [String]
    public let degradedReasons: [CaptionVisualReason]
    public let blockedReasons: [CaptionVisualReason]
    public let inputHash: String

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case approvalHash = "approval_hash"
        case typographyPolicyHash = "typography_policy_hash"
        case visualTreatmentPatchHash = "visual_treatment_patch_hash"
        case platformSafeZoneProfileID = "platform_safe_zone_profile_id"
        case platformSafeZoneProfilePath = "platform_safe_zone_profile_path"
        case platformSafeZoneProfileHash = "platform_safe_zone_profile_hash"
        case resolvedProjection = "resolved_projection"
        case captionIdentity = "caption_identity"
        case graphicalContentIdentity = "graphical_content_identity"
        case status
        case fallbacks
        case rendererRoute = "renderer_route"
        case textTimingHash = "text_timing_hash"
        case capabilityHash = "capability_hash"
        case accessibility
        case appliedCaptionIDs = "applied_caption_ids"
        case degradedReasons = "degraded_reasons"
        case blockedReasons = "blocked_reasons"
        case inputHash = "input_hash"
    }

    public func identity(for captionID: String) -> CaptionVisualIdentity? {
        captionIdentity.first { $0.captionID == captionID }
    }

    public func projection(for captionID: String) -> CaptionVisualResolvedProjection? {
        resolvedProjection?.first { $0.captionID == captionID }
    }
}

public struct CaptionVisualTreatmentPatchDocument: Codable, Equatable, Sendable {
    public let version: String
    public let projectID: String
    public let baseCaptionDraftHash: String
    public let baseTimelineHash: String
    public let typographyPolicyHash: String
    public let captionApprovalHash: String
    public let platformSafeZoneProfileHash: String?
    public let operations: [CaptionVisualTreatmentOperation]
    public let session: CaptionVisualTreatmentPatchSession

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case baseCaptionDraftHash = "base_caption_draft_hash"
        case baseTimelineHash = "base_timeline_hash"
        case typographyPolicyHash = "typography_policy_hash"
        case captionApprovalHash = "caption_approval_hash"
        case platformSafeZoneProfileHash = "platform_safe_zone_profile_hash"
        case operations
        case session
    }
}

public struct CaptionVisualTreatmentPatchSession: Codable, Equatable, Sendable {
    public let reviewer: String
    public let startedAt: String?
    public let updatedAt: String
    public let lastActionOperationCount: Int?
    public let actionOperationCounts: [Int]?

    enum CodingKeys: String, CodingKey {
        case reviewer
        case startedAt = "started_at"
        case updatedAt = "updated_at"
        case lastActionOperationCount = "last_action_operation_count"
        case actionOperationCounts = "action_operation_counts"
    }
}

public struct CaptionSafeZoneRegion: Codable, Equatable, Identifiable, Sendable {
    public var id: String { regionID }
    public let regionID: String
    public let kind: String
    public let rect: CaptionVisualRect
    public let method: String
    public let confidence: String

    enum CodingKeys: String, CodingKey {
        case regionID = "id"
        case kind
        case rect
        case method
        case confidence
    }
}

public struct CaptionSafeZoneRegionSet: Codable, Equatable, Sendable {
    public let unknown: Bool
    public let regions: [CaptionSafeZoneRegion]
}

public struct CaptionSafeZoneViewport: Codable, Equatable, Sendable {
    public let status: String
    public let width: Double?
    public let height: Double?
    public let pixelDensity: Double?
    public let outputWidth: Double?
    public let outputHeight: Double?

    enum CodingKeys: String, CodingKey {
        case status
        case width
        case height
        case pixelDensity = "pixel_density"
        case outputWidth = "output_width"
        case outputHeight = "output_height"
    }
}

public struct CaptionSafeZoneGeometry: Codable, Equatable, Sendable {
    public let status: String
    public let coordinateSystem: String
    public let viewport: CaptionSafeZoneViewport
    public let uiRegions: CaptionSafeZoneRegionSet
    public let safeRegions: CaptionSafeZoneRegionSet
    public let method: String
    public let confidence: String

    enum CodingKeys: String, CodingKey {
        case status
        case coordinateSystem = "coordinate_system"
        case viewport
        case uiRegions = "ui_regions"
        case safeRegions = "safe_regions"
        case method
        case confidence
    }

    public var isVerified: Bool {
        status == "verified" && !safeRegions.unknown && !uiRegions.unknown
    }
}

public struct CaptionSafeZoneDeviceEvidence: Codable, Equatable, Sendable {
    public let status: String
    public let device: String?
    public let os: String?
    public let appVersion: String?
    public let appBuild: String?
    public let locale: String?

    enum CodingKeys: String, CodingKey {
        case status
        case device
        case os
        case appVersion = "app_version"
        case appBuild = "app_build"
        case locale
    }
}

public struct CaptionSafeZoneScreenshotEvidence: Codable, Equatable, Sendable {
    public let status: String
    public let path: String?
    public let sha256: String?
    public let format: String?
}

public struct CaptionSafeZoneSupersession: Codable, Equatable, Sendable {
    public let state: String
    public let supersededBy: String?
    public let reason: String?

    enum CodingKeys: String, CodingKey {
        case state
        case supersededBy = "superseded_by"
        case reason
    }
}

public struct CaptionSafeZoneFallback: Codable, Equatable, Sendable {
    public let mode: String
    public let humanPreviewRequired: Bool
    public let reason: String

    enum CodingKeys: String, CodingKey {
        case mode
        case humanPreviewRequired = "human_preview_required"
        case reason
    }
}

public struct CaptionSafeZoneProfileDocument: Codable, Equatable, Sendable {
    public let version: String
    public let profileID: String
    public let platform: String
    public let surface: String
    public let deliveryVariant: String
    public let evidenceStatus: String
    public let measuredAt: String?
    public let geometry: CaptionSafeZoneGeometry
    public let deviceEvidence: CaptionSafeZoneDeviceEvidence
    public let screenshotEvidence: CaptionSafeZoneScreenshotEvidence
    public let supersession: CaptionSafeZoneSupersession
    public let fallback: CaptionSafeZoneFallback

    enum CodingKeys: String, CodingKey {
        case version
        case profileID = "profile_id"
        case platform
        case surface
        case deliveryVariant = "delivery_variant"
        case evidenceStatus = "evidence_status"
        case measuredAt = "measured_at"
        case geometry
        case deviceEvidence = "device_evidence"
        case screenshotEvidence = "screenshot_evidence"
        case supersession
        case fallback
    }

    public var isHumanHold: Bool {
        evidenceStatus != "verified"
            || supersession.state != "active"
            || !geometry.isVerified
            || fallback.humanPreviewRequired
    }
}

public struct CaptionVisualReviewDocument: Codable, Equatable, Sendable {
    public let command: String?
    public let patchPath: String?
    public let inputPath: String?
    public let receiptPath: String?
    public let patchHash: String?
    public let inputHash: String?
    public let status: CaptionVisualTreatmentStatus?
    public let appliedCaptionIDs: [String]
    public let degradedReasons: [CaptionVisualReason]
    public let blockedReasons: [CaptionVisualReason]
    public let removedOperationCount: Int?
    public let approvalHash: String?
    public let approvedBy: String?
    public let patch: CaptionVisualTreatmentPatchDocument?
    public let input: CaptionVisualTreatmentInputDocument?
    public let capabilities: CaptionVisualTreatmentCapabilities?
    public let safeZoneProfile: CaptionSafeZoneProfileDocument?
    public let preapprovalReceipt: CaptionVisualPreapprovalReceiptDocument?

    enum CodingKeys: String, CodingKey {
        case command
        case patchPath = "patch_path"
        case inputPath = "input_path"
        case receiptPath = "receipt_path"
        case patchHash = "patch_hash"
        case inputHash = "input_hash"
        case status
        case appliedCaptionIDs = "applied_caption_ids"
        case degradedReasons = "degraded_reasons"
        case blockedReasons = "blocked_reasons"
        case removedOperationCount = "removed_operation_count"
        case approvalHash = "approval_hash"
        case approvedBy = "approved_by"
        case patch
        case input
        case capabilities
        case safeZoneProfile = "safe_zone_profile"
        case preapprovalReceipt = "preapproval_receipt"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        command = try values.decodeIfPresent(String.self, forKey: .command)
        patchPath = try values.decodeIfPresent(String.self, forKey: .patchPath)
        inputPath = try values.decodeIfPresent(String.self, forKey: .inputPath)
        receiptPath = try values.decodeIfPresent(String.self, forKey: .receiptPath)
        patchHash = try values.decodeIfPresent(String.self, forKey: .patchHash)
        inputHash = try values.decodeIfPresent(String.self, forKey: .inputHash)
        status = try values.decodeIfPresent(CaptionVisualTreatmentStatus.self, forKey: .status)
        appliedCaptionIDs = try values.decodeIfPresent([String].self, forKey: .appliedCaptionIDs) ?? []
        degradedReasons = try values.decodeIfPresent([CaptionVisualReason].self, forKey: .degradedReasons) ?? []
        blockedReasons = try values.decodeIfPresent([CaptionVisualReason].self, forKey: .blockedReasons) ?? []
        removedOperationCount = try values.decodeIfPresent(Int.self, forKey: .removedOperationCount)
        approvalHash = try values.decodeIfPresent(String.self, forKey: .approvalHash)
        approvedBy = try values.decodeIfPresent(String.self, forKey: .approvedBy)
        patch = try values.decodeIfPresent(CaptionVisualTreatmentPatchDocument.self, forKey: .patch)
        input = try values.decodeIfPresent(CaptionVisualTreatmentInputDocument.self, forKey: .input)
        capabilities = try values.decodeIfPresent(CaptionVisualTreatmentCapabilities.self, forKey: .capabilities)
        safeZoneProfile = try values.decodeIfPresent(CaptionSafeZoneProfileDocument.self, forKey: .safeZoneProfile)
        preapprovalReceipt = try values.decodeIfPresent(CaptionVisualPreapprovalReceiptDocument.self, forKey: .preapprovalReceipt)
    }

    public var preapprovalPreviewDocument: CaptionCanonicalPreviewDocument? {
        guard let receipt = preapprovalReceipt else { return nil }
        return CaptionCanonicalPreviewDocument(
            outputPath: nil,
            receiptPath: receipt.receiptPath ?? receiptPath,
            routeReceiptPath: nil,
            visualInputHash: receipt.inputHash,
            approvalHash: receipt.approvalHash,
            visualTreatmentPatchHash: receipt.visualTreatmentPatchHash,
            typographyPolicyHash: receipt.typographyPolicyHash,
            platformSafeZoneProfileID: receipt.platformSafeZoneProfileID,
            platformSafeZoneProfilePath: receipt.platformSafeZoneProfilePath,
            platformSafeZoneProfileHash: receipt.platformSafeZoneProfileHash,
            textTimingHash: receipt.textTimingHash,
            capabilityHash: receipt.capabilityHash,
            visualStatus: receipt.status,
            parityStatus: receipt.status.rawValue,
            parityMatches: true,
            evidenceKind: "preapproval",
            expectedPatchHash: receipt.expectedPatchHash,
            receiptHash: receipt.receiptHash
        )
    }
}

public struct CaptionVisualPreapprovalReceiptDocument: Codable, Equatable, Sendable {
    public let version: String
    public let projectID: String
    public let expectedPatchHash: String
    public let receiptHash: String
    public let receiptPath: String?
    public let status: CaptionVisualTreatmentStatus
    public let approvalHash: String
    public let visualTreatmentPatchHash: String?
    public let typographyPolicyHash: String
    public let platformSafeZoneProfileID: String?
    public let platformSafeZoneProfilePath: String?
    public let platformSafeZoneProfileHash: String?
    public let accessibility: CaptionVisualAccessibility?
    public let textTimingHash: String
    public let capabilityHash: String
    public let inputHash: String
    public let appliedCaptionIDs: [String]
    public let degradedReasons: [CaptionVisualReason]
    public let blockedReasons: [CaptionVisualReason]

    enum CodingKeys: String, CodingKey {
        case version
        case projectID = "project_id"
        case expectedPatchHash = "expected_patch_hash"
        case receiptHash = "receipt_hash"
        case receiptPath = "receipt_path"
        case status
        case approvalHash = "approval_hash"
        case visualTreatmentPatchHash = "visual_treatment_patch_hash"
        case typographyPolicyHash = "typography_policy_hash"
        case platformSafeZoneProfileID = "platform_safe_zone_profile_id"
        case platformSafeZoneProfilePath = "platform_safe_zone_profile_path"
        case platformSafeZoneProfileHash = "platform_safe_zone_profile_hash"
        case accessibility
        case textTimingHash = "text_timing_hash"
        case capabilityHash = "capability_hash"
        case inputHash = "input_hash"
        case appliedCaptionIDs = "applied_caption_ids"
        case degradedReasons = "degraded_reasons"
        case blockedReasons = "blocked_reasons"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(String.self, forKey: .version)
        projectID = try values.decode(String.self, forKey: .projectID)
        expectedPatchHash = try values.decode(String.self, forKey: .expectedPatchHash)
        receiptHash = try values.decode(String.self, forKey: .receiptHash)
        receiptPath = try values.decodeIfPresent(String.self, forKey: .receiptPath)
        status = try values.decode(CaptionVisualTreatmentStatus.self, forKey: .status)
        approvalHash = try values.decode(String.self, forKey: .approvalHash)
        visualTreatmentPatchHash = try values.decodeIfPresent(String.self, forKey: .visualTreatmentPatchHash)
        typographyPolicyHash = try values.decode(String.self, forKey: .typographyPolicyHash)
        platformSafeZoneProfileID = try values.decodeIfPresent(String.self, forKey: .platformSafeZoneProfileID)
        platformSafeZoneProfilePath = try values.decodeIfPresent(String.self, forKey: .platformSafeZoneProfilePath)
        platformSafeZoneProfileHash = try values.decodeIfPresent(String.self, forKey: .platformSafeZoneProfileHash)
        accessibility = try values.decodeIfPresent(CaptionVisualAccessibility.self, forKey: .accessibility)
        textTimingHash = try values.decode(String.self, forKey: .textTimingHash)
        capabilityHash = try values.decode(String.self, forKey: .capabilityHash)
        inputHash = try values.decode(String.self, forKey: .inputHash)
        appliedCaptionIDs = try values.decodeIfPresent([String].self, forKey: .appliedCaptionIDs) ?? []
        degradedReasons = try values.decodeIfPresent([CaptionVisualReason].self, forKey: .degradedReasons) ?? []
        blockedReasons = try values.decodeIfPresent([CaptionVisualReason].self, forKey: .blockedReasons) ?? []
    }
}

public struct CaptionCanonicalPreviewDocument: Codable, Equatable, Sendable {
    public let outputPath: String?
    public let receiptPath: String?
    public let routeReceiptPath: String?
    public let visualInputHash: String?
    public let approvalHash: String?
    public let visualTreatmentPatchHash: String?
    public let typographyPolicyHash: String?
    public let platformSafeZoneProfileID: String?
    public let platformSafeZoneProfilePath: String?
    public let platformSafeZoneProfileHash: String?
    public let textTimingHash: String?
    public let capabilityHash: String?
    public let visualStatus: CaptionVisualTreatmentStatus?
    public let parityStatus: String?
    public let parityMatches: Bool?
    public let evidenceKind: String?
    public let expectedPatchHash: String?
    public let receiptHash: String?

    public init(
        outputPath: String?,
        receiptPath: String?,
        routeReceiptPath: String?,
        visualInputHash: String?,
        approvalHash: String?,
        visualTreatmentPatchHash: String?,
        typographyPolicyHash: String?,
        platformSafeZoneProfileID: String?,
        platformSafeZoneProfilePath: String?,
        platformSafeZoneProfileHash: String?,
        textTimingHash: String?,
        capabilityHash: String?,
        visualStatus: CaptionVisualTreatmentStatus?,
        parityStatus: String?,
        parityMatches: Bool?,
        evidenceKind: String? = nil,
        expectedPatchHash: String? = nil,
        receiptHash: String? = nil
    ) {
        self.outputPath = outputPath
        self.receiptPath = receiptPath
        self.routeReceiptPath = routeReceiptPath
        self.visualInputHash = visualInputHash
        self.approvalHash = approvalHash
        self.visualTreatmentPatchHash = visualTreatmentPatchHash
        self.typographyPolicyHash = typographyPolicyHash
        self.platformSafeZoneProfileID = platformSafeZoneProfileID
        self.platformSafeZoneProfilePath = platformSafeZoneProfilePath
        self.platformSafeZoneProfileHash = platformSafeZoneProfileHash
        self.textTimingHash = textTimingHash
        self.capabilityHash = capabilityHash
        self.visualStatus = visualStatus
        self.parityStatus = parityStatus
        self.parityMatches = parityMatches
        self.evidenceKind = evidenceKind
        self.expectedPatchHash = expectedPatchHash
        self.receiptHash = receiptHash
    }
}

public struct CaptionVisualReviewConflict: Identifiable, Equatable, Sendable {
    public var id: String {
        let current = currentPatchHash ?? "unknown"
        return "\(captionID):\(expectedPatchHash):\(current)"
    }
    public let captionID: String
    public let expectedPatchHash: String
    public let currentPatchHash: String?
    public let message: String

    public init(captionID: String, expectedPatchHash: String, currentPatchHash: String?, message: String) {
        self.captionID = captionID
        self.expectedPatchHash = expectedPatchHash
        self.currentPatchHash = currentPatchHash
        self.message = message
    }
}
