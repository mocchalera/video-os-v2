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
        items: [CaptionReviewQueueItem]
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

public struct CaptionReviewPreviewStyle: Codable, Equatable, Sendable {
    public enum Alignment: String, Codable, Sendable {
        case bottomCenter = "bottom_center"
        case center
        case topCenter = "top_center"
    }

    public let presetID: String
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
        self.fontFamily = fontFamily
        self.fontWeight = fontWeight
        self.fontSizePx1080 = fontSizePx1080
        self.lineHeightPx1080 = lineHeightPx1080
        self.outlinePx1080 = outlinePx1080
        self.marginV1080 = marginV1080
        self.maxWidthRatio = maxWidthRatio
        self.alignment = alignment
    }

    public static let `default` = CaptionReviewPreviewStyle(
        presetID: "default",
        fontFamily: "Arial",
        fontWeight: 700,
        fontSizePx1080: 24,
        lineHeightPx1080: 32,
        outlinePx1080: 2,
        marginV1080: 44,
        maxWidthRatio: 0.88,
        alignment: .bottomCenter
    )
}
