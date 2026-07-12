import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

private struct TimelineClipMoveViewerPreview: Equatable {
    let clipID: TimelineClip.ID
    let timeline: TimelineDocument
    let previewFrame: Int
    let targetTrackID: TimelineTrack.ID
    let movedClipCount: Int
}

private struct TimelineDragTrimViewerPreview: Equatable {
    let clipID: TimelineClip.ID
    let timeline: TimelineDocument
    let previewFrame: Int
    let edge: TimelinePlayheadTrimEdge
    let snap: TimelineClipMoveSnap?
}

private struct TimelineSlipTrimViewerPreview: Equatable {
    let clipID: TimelineClip.ID
    let timeline: TimelineDocument
    let previewFrame: Int
    let direction: TimelineSlipTrimDirection
    let shiftFrames: Int
}

private struct TimelineRollTrimViewerPreview: Equatable {
    let clipID: TimelineClip.ID
    let timeline: TimelineDocument
    let previewFrame: Int
    let boundary: TimelineRollTrimBoundary
    let direction: TimelineRollTrimDirection
    let shiftFrames: Int
}

struct TimelineSkimPreview: Equatable {
    let frame: Int
    let trackID: TimelineTrack.ID
    let clipID: TimelineClip.ID?
}

struct SourceBinSkimPreview: Equatable {
    let assetID: String
    let previewTimeUS: Int
}

private enum TimelineClipNudgeDirection {
    case earlier
    case later

    var multiplier: Int {
        switch self {
        case .earlier: return -1
        case .later: return 1
        }
    }

    var localizedLabel: String {
        switch self {
        case .earlier: return "前"
        case .later: return "後ろ"
        }
    }
}

private enum SelectedTimelineClipMovePlan {
    case single(TimelineClipMovePlan)
    case group(TimelineClipGroupMovePlan)

    var operations: [ReviewPatchOperation] {
        switch self {
        case let .single(plan): return plan.operations
        case let .group(plan): return plan.operations
        }
    }

    var movedClipIDs: [TimelineClip.ID] {
        switch self {
        case let .single(plan): return [plan.targetClipID]
        case let .group(plan): return plan.movedClipIDs
        }
    }

    var primaryClipID: TimelineClip.ID {
        switch self {
        case let .single(plan): return plan.targetClipID
        case let .group(plan): return plan.targetClipID
        }
    }

    var shiftFrames: Int {
        switch self {
        case let .single(plan): return plan.newTimelineInFrame - plan.originalTimelineInFrame
        case let .group(plan): return plan.resolvedFrameDelta
        }
    }

    var snap: TimelineClipMoveSnap? {
        switch self {
        case let .single(plan): return plan.snap
        case let .group(plan): return plan.snap
        }
    }

    var laneLift: TimelineClipMoveLaneLift? {
        switch self {
        case let .single(plan): return plan.laneLift
        case let .group(plan): return plan.laneLift
        }
    }

    var displacements: [TimelineClipMoveDisplacement] {
        switch self {
        case let .single(plan): return plan.displacements
        case let .group(plan): return plan.displacements
        }
    }
}

struct SourceMonitorInsertCandidateSummary: Equatable {
    let candidateID: BrowserCandidate.ID
    let segmentID: String
    let positionLabel: String
    let roleLabel: String
    let targetTrackID: TimelineTrack.ID
    let sourceRangeLabel: String
    let markedRangeLabel: String
    let durationLabel: String
    let markedDurationLabel: String
    let playbackSourceLabel: String?
    let markedInFraction: Double
    let markedOutFraction: Double
    let confidenceLabel: String
    let reason: String
    let isMarkedRangeCustom: Bool
    let canMoveMarkInEarlier: Bool
    let canMoveMarkInLater: Bool
    let canMoveMarkOutEarlier: Bool
    let canMoveMarkOutLater: Bool
    let canMarkInAtPlaybackTime: Bool
    let canMarkOutAtPlaybackTime: Bool
    let canSelectPrevious: Bool
    let canSelectNext: Bool
}

struct SourceBinQuickDragSummary: Equatable {
    let candidateID: BrowserCandidate.ID
    let segmentID: String
    let roleLabel: String
    let targetTrackID: TimelineTrack.ID
    let sourceRangeLabel: String
    let durationLabel: String
    let confidenceLabel: String
}

enum MediaSourceBinViewMode: String, CaseIterable, Identifiable {
    case list
    case thumbnails

    var id: String { rawValue }
}

struct TimelineSourceOverwritePreview: Equatable {
    let insertedClipID: TimelineClip.ID
    let segmentID: String
    let markedRangeLabel: String
    let targetTrackID: TimelineTrack.ID
    let timelineInFrame: Int
    let overwriteOutFrame: Int
    let durationFrames: Int
    let removedClipIDs: [TimelineClip.ID]
    let trimmedClipIDs: [TimelineClip.ID]
    let splitClipIDs: [TimelineClip.ID]
}

struct TimelineSourceCandidateDropPreview: Equatable {
    let candidateID: BrowserCandidate.ID
    let segmentID: String
    let markedRangeLabel: String
    let roleLabel: String
    let targetTrackKind: TimelineTrackKind
    let requestedTrackID: TimelineTrack.ID
    let targetTrackID: TimelineTrack.ID
    let proposedTimelineInFrame: Int
    let timelineInFrame: Int
    let durationFrames: Int
    let isCompatibleTarget: Bool
    let isLaneLifted: Bool
    let laneLiftCreatesTrack: Bool
    let overlappedClipCount: Int
    let snap: TimelineSourceInsertSnap?
}

@MainActor
final class StudioViewModel: ObservableObject {
    enum AppServerStatus: String {
        case unchecked = "Unchecked"
        case checking = "Checking"
        case ready = "Ready"
        case failed = "Failed"
    }

    enum RoughCutCompileActivity {
        case idle
        case roughCut
        case reviewPatch
        case studioPatch
    }

    private enum TimelineTrimEdge {
        case start
        case end
    }

    @Published var repositoryRoot: URL
    @Published var projects: [ProjectSummary] = []
    @Published var selectedProjectID: ProjectSummary.ID? {
        didSet {
            if oldValue != selectedProjectID {
                if oldValue != nil {
                    sourceMonitorAssetID = nil
                    timelineTransitionDurationPreview = nil
                    timelineClipMoveViewerPreview = nil
                    timelineRollTrimViewerPreview = nil
                    timelineSlipTrimViewerPreview = nil
                    timelineSkimPreview = nil
                    sourceBinSkimPreview = nil
                    clearPublishedPlaybackLoopState()
                }
                if let project = projects.first(where: { $0.id == selectedProjectID }) {
                    selectedSurface = StudioProductStage.preferredSurface(
                        projectState: project.stateLabel,
                        hasTimeline: project.hasTimeline,
                        hasReview: project.hasReview
                    )
                }
            }
            publishAgentMenuCommandAvailability()
        }
    }
    @Published var projectInitializationStatus = "新規作成するか、既存プロジェクトを選んで開始してください。"
    @Published var isInitializingProject = false
    @Published var selectedSurface: StudioAgentSurface = .intent
    @Published var timeline: TimelineDocument? {
        didSet {
            timelineSkimPreview = nil
            sourceBinSkimPreview = nil
            timelineRollTrimViewerPreview = nil
            timelineSlipTrimViewerPreview = nil
            publishAgentMenuCommandAvailability()
        }
    }
    @Published var timelineStatus = "プロジェクトが選択されていません。"
    @Published var analysisRunPlan = ProjectAnalysisRunPlanner.plan(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var analysisRunStatus = "プロジェクトが選択されていません。"
    @Published var isRunningAnalysis = false
    @Published var roughCutCompilePlan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var roughCutCompileStatus = "プロジェクトが選択されていません。"
    @Published var isCompilingRoughCut = false
    @Published var roughCutCompileActivity: RoughCutCompileActivity = .idle
    @Published var feedbackSession = StudioFeedbackSession()
    @Published var qaDashboard: QADashboardDocument?
    @Published var changedClipIDs: [String] = []
    @Published var recentlyChangedClipIDs: Set<String> = []
    @Published var changedClipHighlightTimer: Timer?
    @Published var selectedTimelineClipIDs: Set<TimelineClip.ID> = []
    @Published var isTimelineMultiSelectMode = false
    @Published var isTimelineBladeModeEnabled = false
    @Published var isTimelineSnappingEnabled: Bool = StudioViewModel.loadTimelineSnappingEnabled() {
        didSet {
            UserDefaults.standard.set(isTimelineSnappingEnabled, forKey: StudioViewModel.timelineSnappingDefaultsKey)
        }
    }
    @Published var selectedTimelineTransitionID: TimelineTransition.ID? {
        didSet {
            if oldValue != selectedTimelineTransitionID, selectedTimelineTransitionID != nil {
                timelineDragTrimViewerPreview = nil
                timelineRollTrimViewerPreview = nil
                timelineSlipTrimViewerPreview = nil
                timelineSkimPreview = nil
                sourceBinSkimPreview = nil
            }
        }
    }
    @Published private var timelineTransitionDurationPreview: TimelineTransitionDurationPreview?
    @Published private var timelineClipMoveViewerPreview: TimelineClipMoveViewerPreview?
    @Published private var timelineDragTrimViewerPreview: TimelineDragTrimViewerPreview?
    @Published private var timelineSlipTrimViewerPreview: TimelineSlipTrimViewerPreview?
    @Published private var timelineRollTrimViewerPreview: TimelineRollTrimViewerPreview?
    @Published private(set) var timelineSkimPreview: TimelineSkimPreview?
    @Published private(set) var sourceBinSkimPreview: SourceBinSkimPreview?
    @Published var selectedTimelineClipID: TimelineClip.ID? {
        didSet {
            if !isUpdatingTimelineClipSelection {
                selectedTimelineClipIDs = selectedTimelineClipID.map { [$0] } ?? []
            }
            if selectedTimelineClipID != nil {
                setTimelineTransitionSelection(nil)
                timelineTransitionDurationPreview = nil
                timelineClipMoveViewerPreview = nil
                timelineDragTrimViewerPreview = nil
                timelineRollTrimViewerPreview = nil
                timelineSlipTrimViewerPreview = nil
                timelineSkimPreview = nil
                sourceBinSkimPreview = nil
            }
            loadSelectedClipNoteDraft()
            publishAgentMenuCommandAvailability()
        }
    }
    @Published var playheadFrame = 0 {
        didSet { publishAgentMenuCommandAvailability() }
    }
    @Published var timelinePlayheadRevealRequest = 0
    @Published var mediaPlaybackSyncGeneration = 0
    @Published var audioPlaybackSyncGeneration = 0
    @Published var monitorAudioMuted = false
    @Published var monitorAudioVolume = 0.85
    @Published var timelineAudioWaveforms: [TimelineAudioWaveform] = []
    @Published var audioWaveformStatus = "波形はまだ読み込まれていません。"
    @Published var timelinePixelsPerFrame = StudioViewModel.loadTimelinePixelsPerFrame() {
        didSet {
            UserDefaults.standard.set(timelinePixelsPerFrame, forKey: StudioViewModel.timelinePixelsPerFrameDefaultsKey)
        }
    }
    @Published var isTimelineFitToWindowEnabled = StudioViewModel.loadTimelineFitToWindowEnabled() {
        didSet {
            UserDefaults.standard.set(isTimelineFitToWindowEnabled, forKey: StudioViewModel.timelineFitToWindowDefaultsKey)
        }
    }
    @Published var timelineTrackDensity: TimelineTrackDensity = StudioViewModel.loadTimelineTrackDensity() {
        didSet {
            UserDefaults.standard.set(timelineTrackDensity.rawValue, forKey: StudioViewModel.timelineTrackDensityDefaultsKey)
        }
    }
    @Published var isPlaying = false
    @Published var playbackDirection: TimelinePlaybackDirection = .forward
    @Published var playbackSpeed: Double = 0
    @Published var playbackLoopRange: TimelinePlaybackRange?
    @Published var isLoopPlaybackEnabled = false
    @Published var evidenceStore: ProjectEvidenceStore?
    @Published var candidateDataSource: CandidateBrowserDataSource? {
        didSet { normalizeSourceMonitorCandidateSelection() }
    }
    @Published var isSwapBrowserPresented = false
    @Published var isFootageSearchPresented = false
    @Published var swapBrowserClip: TimelineClip?
    @Published var mediaPreviewSummary = ProjectMediaPreviewSummary(items: [])
    @Published var mediaSourceBinFilter: ProjectMediaSourceBinFilter = StudioViewModel.loadMediaSourceBinFilter() {
        didSet {
            UserDefaults.standard.set(mediaSourceBinFilter.rawValue, forKey: StudioViewModel.mediaSourceBinFilterDefaultsKey)
        }
    }
    @Published var mediaSourceBinQuery = StudioViewModel.loadMediaSourceBinQuery() {
        didSet {
            UserDefaults.standard.set(mediaSourceBinQuery, forKey: StudioViewModel.mediaSourceBinQueryDefaultsKey)
        }
    }
    @Published var mediaSourceBinSort: ProjectMediaSourceBinSort = StudioViewModel.loadMediaSourceBinSort() {
        didSet {
            UserDefaults.standard.set(mediaSourceBinSort.rawValue, forKey: StudioViewModel.mediaSourceBinSortDefaultsKey)
        }
    }
    @Published var mediaSourceBinGroupMode: ProjectMediaSourceBinGroupMode = StudioViewModel.loadMediaSourceBinGroupMode() {
        didSet {
            UserDefaults.standard.set(mediaSourceBinGroupMode.rawValue, forKey: StudioViewModel.mediaSourceBinGroupModeDefaultsKey)
        }
    }
    @Published var mediaSourceBinViewMode: MediaSourceBinViewMode = StudioViewModel.loadMediaSourceBinViewMode() {
        didSet {
            UserDefaults.standard.set(mediaSourceBinViewMode.rawValue, forKey: StudioViewModel.mediaSourceBinViewModeDefaultsKey)
        }
    }
    @Published var mediaSourceBinActiveCollectionName = StudioViewModel.loadMediaSourceBinActiveCollectionName() {
        didSet {
            UserDefaults.standard.set(mediaSourceBinActiveCollectionName, forKey: StudioViewModel.mediaSourceBinActiveCollectionNameDefaultsKey)
        }
    }
    @Published private var mediaSourceBinFavoriteAssetIDsByProject = StudioViewModel.loadMediaSourceBinFavoriteAssetIDsByProject() {
        didSet {
            StudioViewModel.storeMediaSourceBinFavoriteAssetIDsByProject(mediaSourceBinFavoriteAssetIDsByProject)
        }
    }
    @Published private var mediaSourceBinManualAssetIDsByProject = StudioViewModel.loadMediaSourceBinManualAssetIDsByProject() {
        didSet {
            StudioViewModel.storeMediaSourceBinManualAssetIDsByProject(mediaSourceBinManualAssetIDsByProject)
        }
    }
    @Published private var mediaSourceBinCollectionAssetIDsByProject = StudioViewModel.loadMediaSourceBinCollectionAssetIDsByProject() {
        didSet {
            StudioViewModel.storeMediaSourceBinCollectionAssetIDsByProject(mediaSourceBinCollectionAssetIDsByProject)
        }
    }
    @Published private var mediaSourceBinCollectionMetadataByProject = StudioViewModel.loadMediaSourceBinCollectionMetadataByProject() {
        didSet {
            StudioViewModel.storeMediaSourceBinCollectionMetadataByProject(mediaSourceBinCollectionMetadataByProject)
        }
    }
    @Published private var mediaSourceBinCollectionOrderByProject = StudioViewModel.loadMediaSourceBinCollectionOrderByProject() {
        didSet {
            StudioViewModel.storeMediaSourceBinCollectionOrderByProject(mediaSourceBinCollectionOrderByProject)
        }
    }
    @Published var sourceMonitorAssetID: String? = StudioViewModel.loadSourceMonitorAssetID() {
        didSet {
            if oldValue != sourceMonitorAssetID {
                StudioViewModel.storeOptionalString(sourceMonitorAssetID, forKey: StudioViewModel.sourceMonitorAssetIDDefaultsKey)
                sourceMonitorCandidateID = nil
                sourceMonitorPlaybackSourceUS = nil
                sourceBinSkimPreview = nil
                resetSourceMonitorMarkedRangeState()
            }
            normalizeSourceMonitorCandidateSelection()
        }
    }
    @Published var sourceMonitorCandidateID: BrowserCandidate.ID? = StudioViewModel.loadSourceMonitorCandidateID() {
        didSet {
            StudioViewModel.storeOptionalString(sourceMonitorCandidateID, forKey: StudioViewModel.sourceMonitorCandidateIDDefaultsKey)
            if oldValue != sourceMonitorCandidateID {
                resetSourceMonitorMarkedRangeState()
            }
        }
    }
    @Published var sourceMonitorMarkedSourceInUS: Int?
    @Published var sourceMonitorMarkedSourceOutUS: Int?
    @Published var sourceMonitorPlaybackSourceUS: Int?
    @Published var mediaSourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var mediaProxyPlan = ProjectMediaProxyPlan(items: [])
    @Published var mediaProxyOperationStatus = "プロキシ作成は待機中です。"
    @Published var isBuildingMediaProxies = false
    @Published var mediaRelinkPlan: ProjectMediaRelinkPlan?
    @Published var mediaRelinkStatus = "再接続フォルダは未選択です。"
    @Published var isRelinkingMedia = false
    @Published var syntheticMediaStatus = "デモ用素材作成は待機中です。"
    @Published var isBuildingSyntheticMedia = false
    @Published var studioSyntheticSmokeStatus = "Studioスモークは未実行です。"
    @Published var isRunningStudioSyntheticSmoke = false
    @Published var studioAcceptanceSmokeStatus = "受け入れチェックは未実行です。"
    @Published var isRunningStudioAcceptanceSmoke = false
    @Published var handoffExportPlan: ProjectHandoffExportPlan?
    @Published var handoffExportStatus = "プロジェクトが選択されていません。"
    @Published var isExportingPremiereXML = false
    @Published var editorPacketPlan: ProjectEditorPacketPlan?
    @Published var editorPacketStatus = "プロジェクトが選択されていません。"
    @Published var editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var isExportingEditorPacket = false
    @Published var renderPackageStatus = ProjectRenderPackageStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var renderRunPlan = ProjectRenderRunPlanner.plan(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var renderRunStatus = "プロジェクトが選択されていません。"
    @Published var isRunningRender = false
    @Published var promoFinishStatus = ProjectPromoFinishStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var promoFinishRunPlan = ProjectPromoFinishRunPlanner.plan(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var promoFinishRunStatus = "プロジェクトが選択されていません。"
    @Published var isRunningPromoFinish = false
    @Published var playbackContractStatus = ProjectPlaybackContractStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var timelinePreviewDiagnostics = ProjectTimelinePreviewDiagnostics.empty
    @Published var policyStatus = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: URL(fileURLWithPath: "/"))
    @Published var marlinEvaluationStatus = ProjectMarlinEvaluationStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var marlinPreferenceDecision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: URL(fileURLWithPath: "/"))
    @Published var marlinEvaluationQueue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: URL(fileURLWithPath: "/"))
    @Published var marlinRepresentativePlan = ProjectMarlinRepresentativePlanReader.plan(repositoryRoot: URL(fileURLWithPath: "/"))
    @Published var marlinEvaluationRunPlan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var marlinRuntimeStatus = ProjectMarlinRuntimeStatusReader.uncheckedStatus(repositoryRoot: URL(fileURLWithPath: "/"))
    @Published var marlinModelAccessStatus = ProjectMarlinModelAccessStatusReader.uncheckedStatus(repositoryRoot: URL(fileURLWithPath: "/"))
    @Published var marlinEvaluationRunStatus = "プロジェクトが選択されていません。"
    @Published var isRunningMarlinEvaluation = false
    @Published var audioStoryGraphRunPlan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var audioStoryGraphRunStatus = "プロジェクトが選択されていません。"
    @Published var isBuildingAudioStoryGraph = false
    @Published var editorAnnotations: ProjectEditorAnnotationsDocument?
    @Published var editorAnnotationSummary: ProjectEditorAnnotationSummary?
    @Published var editorAnnotationStatus = "プロジェクトが選択されていません。"
    @Published var selectedClipNoteDraft = ""
    @Published var selectedClipHandoffInstructionDraft = ""
    @Published var intentSummary = ProjectIntentSummaryReader.summary(projectURL: URL(fileURLWithPath: "/"))
    @Published var intentAlignmentStatus = ProjectIntentAlignmentStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var reviewArtifactStatus = ProjectReviewArtifactStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var libraryReadinessStatus = ProjectLibraryReadinessStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var pipelineGateStatus = ProjectPipelineGateStatusReader.status(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var studioReadinessStatus = ProjectStudioReadinessStatusReader.status(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var studioGoalStatus = ProjectStudioGoalStatusReader.status(
        repositoryRoot: URL(fileURLWithPath: "/"),
        projectURL: URL(fileURLWithPath: "/"),
        marlinModelAccessStatus: ProjectMarlinModelAccessStatusReader.uncheckedStatus(repositoryRoot: URL(fileURLWithPath: "/"))
    )
    @Published var studioReadinessActionStatus = "Studio準備状況からアクションを選び、次の操作を実行してください。"
    @Published var planningStatus = ProjectPlanningStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var indexStatus = ProjectIndexStatus(indexURL: URL(fileURLWithPath: "/"), exists: false, documentCount: 0, updatedAt: nil)
    @Published var indexSearchQuery = ""
    @Published var indexSearchResults: [ProjectSearchResult] = []
    @Published var indexContextPack = ProjectRAGContextPack(query: "", items: [])
    @Published var indexOperationStatus = "Index not checked."
    @Published var appServerPlan: CodexAppServerLaunchPlan
    @Published var appServerStatus: AppServerStatus = .unchecked {
        didSet { publishAgentMenuCommandAvailability() }
    }
    @Published var appServerDetail = "エージェント作業を始める前に接続確認を実行してください。"
    @Published var activeThreadID: String? {
        didSet { publishAgentMenuCommandAvailability() }
    }
    @Published var activeModel: String?
    @Published var agentPrompt = "Reply with the current Video OS project status in one concise paragraph. Do not modify files."
    @Published var selectedTimelineAgentIntent: TimelineAgentConsultationIntent = .tightenSelection
    @Published var selectedJob: VideoOSAgentJob = .status {
        didSet { publishAgentMenuCommandAvailability() }
    }
    @Published var pendingApproval: AgentJobApproval? {
        didSet { publishAgentMenuCommandAvailability() }
    }
    @Published var turnStatus = "まだ実行していません。"
    @Published var turnTranscript = ""
    @Published var turnHistory: [AgentTurnRecord] = []
    @Published var selectedTurnID: AgentTurnRecord.ID?
    private var activeSession: CodexAppServerSession?
    private static let mediaSourceBinFilterDefaultsKey = "VideoOSStudio.mediaSourceBinFilter"
    private static let mediaSourceBinQueryDefaultsKey = "VideoOSStudio.mediaSourceBinQuery"
    private static let mediaSourceBinSortDefaultsKey = "VideoOSStudio.mediaSourceBinSort"
    private static let mediaSourceBinGroupModeDefaultsKey = "VideoOSStudio.mediaSourceBinGroupMode"
    private static let mediaSourceBinViewModeDefaultsKey = "VideoOSStudio.mediaSourceBinViewMode"
    private static let mediaSourceBinActiveCollectionNameDefaultsKey = "VideoOSStudio.mediaSourceBinActiveCollectionName"
    private static let mediaSourceBinFavoriteAssetIDsByProjectDefaultsKey = "VideoOSStudio.mediaSourceBinFavoriteAssetIDsByProject"
    private static let mediaSourceBinManualAssetIDsByProjectDefaultsKey = "VideoOSStudio.mediaSourceBinManualAssetIDsByProject"
    private static let mediaSourceBinCollectionAssetIDsByProjectDefaultsKey = "VideoOSStudio.mediaSourceBinCollectionAssetIDsByProject"
    private static let mediaSourceBinCollectionMetadataByProjectDefaultsKey = "VideoOSStudio.mediaSourceBinCollectionMetadataByProject"
    private static let mediaSourceBinCollectionOrderByProjectDefaultsKey = "VideoOSStudio.mediaSourceBinCollectionOrderByProject"
    private static let sourceMonitorAssetIDDefaultsKey = "VideoOSStudio.sourceMonitorAssetID"
    private static let sourceMonitorCandidateIDDefaultsKey = "VideoOSStudio.sourceMonitorCandidateID"
    private static let timelineSnappingDefaultsKey = "VideoOSStudio.timelineSnappingEnabled"
    private static let timelinePixelsPerFrameDefaultsKey = "VideoOSStudio.timelinePixelsPerFrame"
    private static let timelineFitToWindowDefaultsKey = "VideoOSStudio.timelineFitToWindowEnabled"
    private static let timelineTrackDensityDefaultsKey = "VideoOSStudio.timelineTrackDensity"
    private var playbackTimer: Timer?
    private let sourceMonitorMarkStepUS = 500_000
    private var playbackAnchorFrame = 0
    private var playbackAnchorDate: Date?
    private var playbackSyncState = TimelinePlaybackSyncState()
    private var audioPlaybackSyncState = TimelinePlaybackSyncState()
    private let timelinePreviewSyncClipID: TimelineClip.ID = "__timeline_preview__"
    private var commandObserverTokens: [NSObjectProtocol] = []
    private var userSelectedProject = false
    private var feedbackSessionProjectID: ProjectSummary.ID?
    private var isUpdatingTimelineClipSelection = false

    init() {
        let root = ProjectScanner.locateRepositoryRoot()
        repositoryRoot = root
        appServerPlan = CodexAppServerTransportPreferences.launchPlan(workspace: root)
        marlinModelAccessStatus = ProjectMarlinModelAccessStatusReader.uncheckedStatus(repositoryRoot: root)
        installCommandObservers()
        publishAgentMenuCommandAvailability()
        Task { @MainActor in
            self.refresh()
        }
    }

    private static func loadMediaSourceBinFilter() -> ProjectMediaSourceBinFilter {
        let rawValue = UserDefaults.standard.string(forKey: mediaSourceBinFilterDefaultsKey)
        return rawValue.flatMap(ProjectMediaSourceBinFilter.init(rawValue:)) ?? .all
    }

    private static func loadMediaSourceBinQuery() -> String {
        UserDefaults.standard.string(forKey: mediaSourceBinQueryDefaultsKey) ?? ""
    }

    private static func loadMediaSourceBinSort() -> ProjectMediaSourceBinSort {
        let rawValue = UserDefaults.standard.string(forKey: mediaSourceBinSortDefaultsKey)
        return rawValue.flatMap(ProjectMediaSourceBinSort.init(rawValue:)) ?? .sourceOrder
    }

    private static func loadMediaSourceBinGroupMode() -> ProjectMediaSourceBinGroupMode {
        let rawValue = UserDefaults.standard.string(forKey: mediaSourceBinGroupModeDefaultsKey)
        return rawValue.flatMap(ProjectMediaSourceBinGroupMode.init(rawValue:)) ?? .flat
    }

    private static func loadMediaSourceBinViewMode() -> MediaSourceBinViewMode {
        let rawValue = UserDefaults.standard.string(forKey: mediaSourceBinViewModeDefaultsKey)
        return rawValue.flatMap(MediaSourceBinViewMode.init(rawValue:)) ?? .list
    }

    private static func loadMediaSourceBinActiveCollectionName() -> String {
        ProjectMediaSourceBinCollectionCatalog.normalizedName(
            UserDefaults.standard.string(forKey: mediaSourceBinActiveCollectionNameDefaultsKey) ?? ""
        )
    }

    private static func loadMediaSourceBinFavoriteAssetIDsByProject() -> [ProjectSummary.ID: Set<String>] {
        guard let stored = UserDefaults.standard.dictionary(
            forKey: mediaSourceBinFavoriteAssetIDsByProjectDefaultsKey
        ) as? [String: [String]] else {
            return [:]
        }
        return stored.mapValues { Set($0) }
    }

    private static func storeMediaSourceBinFavoriteAssetIDsByProject(_ favorites: [ProjectSummary.ID: Set<String>]) {
        let stored = favorites.reduce(into: [String: [String]]()) { result, entry in
            let values = entry.value.sorted()
            guard !values.isEmpty else { return }
            result[entry.key] = values
        }
        if stored.isEmpty {
            UserDefaults.standard.removeObject(forKey: mediaSourceBinFavoriteAssetIDsByProjectDefaultsKey)
        } else {
            UserDefaults.standard.set(stored, forKey: mediaSourceBinFavoriteAssetIDsByProjectDefaultsKey)
        }
    }

    private static func loadMediaSourceBinManualAssetIDsByProject() -> [ProjectSummary.ID: Set<String>] {
        guard let stored = UserDefaults.standard.dictionary(
            forKey: mediaSourceBinManualAssetIDsByProjectDefaultsKey
        ) as? [String: [String]] else {
            return [:]
        }
        return stored.mapValues { Set($0) }
    }

    private static func storeMediaSourceBinManualAssetIDsByProject(_ manualBins: [ProjectSummary.ID: Set<String>]) {
        let stored = manualBins.reduce(into: [String: [String]]()) { result, entry in
            let values = entry.value.sorted()
            guard !values.isEmpty else { return }
            result[entry.key] = values
        }
        if stored.isEmpty {
            UserDefaults.standard.removeObject(forKey: mediaSourceBinManualAssetIDsByProjectDefaultsKey)
        } else {
            UserDefaults.standard.set(stored, forKey: mediaSourceBinManualAssetIDsByProjectDefaultsKey)
        }
    }

    private static func loadMediaSourceBinCollectionAssetIDsByProject() -> [ProjectSummary.ID: [String: Set<String>]] {
        guard let stored = UserDefaults.standard.dictionary(
            forKey: mediaSourceBinCollectionAssetIDsByProjectDefaultsKey
        ) as? [String: [String: [String]]] else {
            return [:]
        }
        return stored.mapValues { collections in
            collections.reduce(into: [String: Set<String>]()) { result, entry in
                let name = normalizedMediaSourceBinCollectionName(entry.key)
                let assetIDs = Set(entry.value)
                guard !name.isEmpty else { return }
                result[name] = assetIDs
            }
        }
    }

    private static func storeMediaSourceBinCollectionAssetIDsByProject(
        _ collectionsByProject: [ProjectSummary.ID: [String: Set<String>]]
    ) {
        let stored = collectionsByProject.reduce(into: [String: [String: [String]]]()) { result, entry in
            let collections = entry.value.reduce(into: [String: [String]]()) { collectionResult, collectionEntry in
                let name = normalizedMediaSourceBinCollectionName(collectionEntry.key)
                let values = collectionEntry.value.sorted()
                guard !name.isEmpty else { return }
                collectionResult[name] = values
            }
            guard !collections.isEmpty else { return }
            result[entry.key] = collections
        }
        if stored.isEmpty {
            UserDefaults.standard.removeObject(forKey: mediaSourceBinCollectionAssetIDsByProjectDefaultsKey)
        } else {
            UserDefaults.standard.set(stored, forKey: mediaSourceBinCollectionAssetIDsByProjectDefaultsKey)
        }
    }

    private static func loadMediaSourceBinCollectionMetadataByProject() -> [ProjectSummary.ID: [String: ProjectMediaSourceBinCollectionMetadata]] {
        guard let stored = UserDefaults.standard.dictionary(
            forKey: mediaSourceBinCollectionMetadataByProjectDefaultsKey
        ) as? [String: [String: [String: String]]] else {
            return [:]
        }
        return stored.reduce(into: [ProjectSummary.ID: [String: ProjectMediaSourceBinCollectionMetadata]]()) { result, entry in
            let metadataByName = entry.value.reduce(into: [String: ProjectMediaSourceBinCollectionMetadata]()) { collectionResult, collectionEntry in
                let name = normalizedMediaSourceBinCollectionName(collectionEntry.key)
                let metadata = ProjectMediaSourceBinCollectionMetadata(
                    statusRawValue: collectionEntry.value["status"],
                    note: collectionEntry.value["note"] ?? ""
                )
                guard !name.isEmpty, !metadata.isDefault else { return }
                collectionResult[name] = metadata
            }
            guard !metadataByName.isEmpty else { return }
            result[entry.key] = metadataByName
        }
    }

    private static func storeMediaSourceBinCollectionMetadataByProject(
        _ metadataByProject: [ProjectSummary.ID: [String: ProjectMediaSourceBinCollectionMetadata]]
    ) {
        let stored = metadataByProject.reduce(into: [String: [String: [String: String]]]()) { result, entry in
            let metadataByName = entry.value.reduce(into: [String: [String: String]]()) { collectionResult, collectionEntry in
                let name = normalizedMediaSourceBinCollectionName(collectionEntry.key)
                let metadata = ProjectMediaSourceBinCollectionMetadata(
                    status: collectionEntry.value.status,
                    note: collectionEntry.value.note
                )
                guard !name.isEmpty, !metadata.isDefault else { return }
                collectionResult[name] = [
                    "status": metadata.status.rawValue,
                    "note": metadata.note,
                ]
            }
            guard !metadataByName.isEmpty else { return }
            result[entry.key] = metadataByName
        }
        if stored.isEmpty {
            UserDefaults.standard.removeObject(forKey: mediaSourceBinCollectionMetadataByProjectDefaultsKey)
        } else {
            UserDefaults.standard.set(stored, forKey: mediaSourceBinCollectionMetadataByProjectDefaultsKey)
        }
    }

    private static func loadMediaSourceBinCollectionOrderByProject() -> [ProjectSummary.ID: [String]] {
        guard let stored = UserDefaults.standard.dictionary(
            forKey: mediaSourceBinCollectionOrderByProjectDefaultsKey
        ) as? [String: [String]] else {
            return [:]
        }
        return stored.reduce(into: [ProjectSummary.ID: [String]]()) { result, entry in
            var seen: Set<String> = []
            let names = entry.value.compactMap { rawName -> String? in
                let name = normalizedMediaSourceBinCollectionName(rawName)
                guard !seen.contains(name) else { return nil }
                seen.insert(name)
                return name
            }
            guard !names.isEmpty else { return }
            result[entry.key] = names
        }
    }

    private static func storeMediaSourceBinCollectionOrderByProject(
        _ orderByProject: [ProjectSummary.ID: [String]]
    ) {
        let stored = orderByProject.reduce(into: [String: [String]]()) { result, entry in
            var seen: Set<String> = []
            let names = entry.value.compactMap { rawName -> String? in
                let name = normalizedMediaSourceBinCollectionName(rawName)
                guard !seen.contains(name) else { return nil }
                seen.insert(name)
                return name
            }
            guard !names.isEmpty else { return }
            result[entry.key] = names
        }
        if stored.isEmpty {
            UserDefaults.standard.removeObject(forKey: mediaSourceBinCollectionOrderByProjectDefaultsKey)
        } else {
            UserDefaults.standard.set(stored, forKey: mediaSourceBinCollectionOrderByProjectDefaultsKey)
        }
    }

    private static func normalizedMediaSourceBinCollectionName(_ rawValue: String) -> String {
        ProjectMediaSourceBinCollectionCatalog.normalizedName(rawValue)
    }

    private static func loadSourceMonitorAssetID() -> String? {
        UserDefaults.standard.string(forKey: sourceMonitorAssetIDDefaultsKey)
    }

    private static func loadSourceMonitorCandidateID() -> BrowserCandidate.ID? {
        UserDefaults.standard.string(forKey: sourceMonitorCandidateIDDefaultsKey)
    }

    private static func storeOptionalString(_ value: String?, forKey key: String) {
        if let value, !value.isEmpty {
            UserDefaults.standard.set(value, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    private static func loadTimelineSnappingEnabled() -> Bool {
        guard UserDefaults.standard.object(forKey: timelineSnappingDefaultsKey) != nil else {
            return true
        }
        return UserDefaults.standard.bool(forKey: timelineSnappingDefaultsKey)
    }

    private static func loadTimelinePixelsPerFrame() -> Double {
        guard UserDefaults.standard.object(forKey: timelinePixelsPerFrameDefaultsKey) != nil else {
            return TimelineViewportScale.defaultPixelsPerFrame
        }
        return TimelineViewportScale.clampedPixelsPerFrame(
            UserDefaults.standard.double(forKey: timelinePixelsPerFrameDefaultsKey)
        )
    }

    private static func loadTimelineFitToWindowEnabled() -> Bool {
        guard UserDefaults.standard.object(forKey: timelineFitToWindowDefaultsKey) != nil else {
            return false
        }
        return UserDefaults.standard.bool(forKey: timelineFitToWindowDefaultsKey)
    }

    private static func loadTimelineTrackDensity() -> TimelineTrackDensity {
        let rawValue = UserDefaults.standard.string(forKey: timelineTrackDensityDefaultsKey)
        return rawValue.flatMap(TimelineTrackDensity.init(rawValue:)) ?? .standard
    }

    deinit {
        playbackTimer?.invalidate()
        for token in commandObserverTokens {
            NotificationCenter.default.removeObserver(token)
        }
    }

    var selectedProject: ProjectSummary? {
        projects.first { $0.id == selectedProjectID } ?? projects.first
    }

    var isCompilingPlainRoughCut: Bool {
        isCompilingRoughCut && roughCutCompileActivity == .roughCut
    }

    var isApplyingReviewPatch: Bool {
        isCompilingRoughCut && roughCutCompileActivity == .reviewPatch
    }

    var selectedTimelineClip: TimelineClipSelection? {
        timeline?.clipSelection(for: selectedTimelineClipID)
    }

    var filteredMediaPreviewItems: [ProjectMediaPreviewStatus] {
        mediaPreviewSummary.items(
            matching: mediaSourceBinFilter,
            query: mediaSourceBinQuery,
            sort: mediaSourceBinSort,
            manualAssetIDs: mediaSourceBinManualAssetIDs,
            collectionAssetIDs: mediaSourceBinActiveCollectionAssetIDs,
            favoriteAssetIDs: mediaSourceBinFavoriteAssetIDs,
            usedAssetIDs: mediaSourceBinUsedAssetIDs
        )
    }

    var filteredMediaSourceBinAssetIDs: [String] {
        var seen: Set<String> = []
        return filteredMediaPreviewItems.compactMap { item in
            guard !seen.contains(item.assetID) else { return nil }
            seen.insert(item.assetID)
            return item.assetID
        }
    }

    var groupedMediaPreviewItems: [ProjectMediaSourceBinGroup] {
        mediaPreviewSummary.groupedItems(
            matching: mediaSourceBinFilter,
            query: mediaSourceBinQuery,
            sort: mediaSourceBinSort,
            groupMode: mediaSourceBinGroupMode,
            manualAssetIDs: mediaSourceBinManualAssetIDs,
            collectionAssetIDs: mediaSourceBinActiveCollectionAssetIDs,
            favoriteAssetIDs: mediaSourceBinFavoriteAssetIDs,
            usedAssetIDs: mediaSourceBinUsedAssetIDs
        )
    }

    var mediaSourceBinFilterBaseCount: Int {
        mediaPreviewSummary.count(
            matching: mediaSourceBinFilter,
            manualAssetIDs: mediaSourceBinManualAssetIDs,
            collectionAssetIDs: mediaSourceBinActiveCollectionAssetIDs,
            favoriteAssetIDs: mediaSourceBinFavoriteAssetIDs,
            usedAssetIDs: mediaSourceBinUsedAssetIDs
        )
    }

    var mediaSourceBinManualAssetIDs: Set<String> {
        guard let scopeID = mediaSourceBinScopeID else { return [] }
        return mediaSourceBinManualAssetIDsByProject[scopeID] ?? []
    }

    var mediaSourceBinActiveCollectionLabel: String {
        StudioViewModel.normalizedMediaSourceBinCollectionName(mediaSourceBinActiveCollectionName)
    }

    var mediaSourceBinActiveCollectionAssetIDs: Set<String> {
        guard let scopeID = mediaSourceBinScopeID else { return [] }
        return mediaSourceBinCollectionAssetIDsByProject[scopeID]?[mediaSourceBinActiveCollectionLabel] ?? []
    }

    var mediaSourceBinActiveCollectionMetadata: ProjectMediaSourceBinCollectionMetadata {
        guard let scopeID = mediaSourceBinScopeID else { return .empty }
        return ProjectMediaSourceBinCollectionMetadataCatalog.metadata(
            for: mediaSourceBinActiveCollectionLabel,
            in: mediaSourceBinCollectionMetadataByProject[scopeID] ?? [:]
        )
    }

    var mediaSourceBinActiveCollectionStatus: ProjectMediaSourceBinCollectionStatus {
        mediaSourceBinActiveCollectionMetadata.status
    }

    var mediaSourceBinActiveCollectionNote: String {
        mediaSourceBinActiveCollectionMetadata.note
    }

    var mediaSourceBinCollectionNames: [String] {
        guard let scopeID = mediaSourceBinScopeID else {
            return [mediaSourceBinActiveCollectionLabel]
        }
        let collectionNames = mediaSourceBinCollectionAssetIDsByProject[scopeID]
            .map { Array($0.keys) } ?? []
        let metadataNames = mediaSourceBinCollectionMetadataByProject[scopeID]
            .map { Array($0.keys) } ?? []
        return ProjectMediaSourceBinCollectionCatalog.names(
            storedNames: collectionNames + metadataNames,
            activeName: mediaSourceBinActiveCollectionLabel,
            preferredOrder: mediaSourceBinCollectionOrderByProject[scopeID] ?? []
        )
    }

    var canDeleteActiveMediaSourceBinCollection: Bool {
        guard let scopeID = mediaSourceBinScopeID else { return false }
        return mediaSourceBinCollectionAssetIDsByProject[scopeID]?[mediaSourceBinActiveCollectionLabel] != nil
            || mediaSourceBinCollectionMetadataByProject[scopeID]?[mediaSourceBinActiveCollectionLabel] != nil
    }

    var canMoveActiveMediaSourceBinCollectionEarlier: Bool {
        guard let currentIndex = mediaSourceBinCollectionNames.firstIndex(of: mediaSourceBinActiveCollectionLabel) else {
            return false
        }
        return currentIndex > 0
    }

    var canMoveActiveMediaSourceBinCollectionLater: Bool {
        guard let currentIndex = mediaSourceBinCollectionNames.firstIndex(of: mediaSourceBinActiveCollectionLabel) else {
            return false
        }
        return currentIndex < mediaSourceBinCollectionNames.count - 1
    }

    var canAddVisibleMediaSourceBinItemsToActiveCollection: Bool {
        guard mediaSourceBinScopeID != nil else { return false }
        let visibleAssetIDs = Set(filteredMediaSourceBinAssetIDs)
        return !visibleAssetIDs.isEmpty && !visibleAssetIDs.subtracting(mediaSourceBinActiveCollectionAssetIDs).isEmpty
    }

    var canRemoveVisibleMediaSourceBinItemsFromActiveCollection: Bool {
        guard mediaSourceBinScopeID != nil else { return false }
        let visibleAssetIDs = Set(filteredMediaSourceBinAssetIDs)
        return !visibleAssetIDs.isEmpty && !visibleAssetIDs.intersection(mediaSourceBinActiveCollectionAssetIDs).isEmpty
    }

    var mediaSourceBinFavoriteAssetIDs: Set<String> {
        guard let scopeID = mediaSourceBinScopeID else { return [] }
        return mediaSourceBinFavoriteAssetIDsByProject[scopeID] ?? []
    }

    var mediaSourceBinUsedAssetIDs: Set<String> {
        Set(timeline?.displayTracks.flatMap(\.clips).map(\.assetID) ?? [])
    }

    func isSourceBinFavorite(_ assetID: String) -> Bool {
        mediaSourceBinFavoriteAssetIDs.contains(assetID)
    }

    func isSourceBinInManualBin(_ assetID: String) -> Bool {
        mediaSourceBinManualAssetIDs.contains(assetID)
    }

    func isSourceBinInActiveCollection(_ assetID: String) -> Bool {
        mediaSourceBinActiveCollectionAssetIDs.contains(assetID)
    }

    func isSourceBinUsed(_ assetID: String) -> Bool {
        mediaSourceBinUsedAssetIDs.contains(assetID)
    }

    func mediaSourceBinCollectionAssetCount(_ collectionName: String) -> Int {
        guard let scopeID = mediaSourceBinScopeID else { return 0 }
        let normalizedName = StudioViewModel.normalizedMediaSourceBinCollectionName(collectionName)
        return mediaSourceBinCollectionAssetIDsByProject[scopeID]?[normalizedName]?.count ?? 0
    }

    func setActiveSourceBinCollectionStatus(_ status: ProjectMediaSourceBinCollectionStatus) {
        guard mediaSourceBinScopeID != nil else {
            timelineStatus = "プロジェクトを選択すると選別binの用途を保存できます。"
            return
        }
        let metadata = mediaSourceBinActiveCollectionMetadata
        guard metadata.status != status else { return }
        updateActiveSourceBinCollectionMetadata(
            ProjectMediaSourceBinCollectionMetadata(status: status, note: metadata.note)
        )
        timelineStatus = "\(mediaSourceBinActiveCollectionLabel)の選別状態を更新しました。"
    }

    func setActiveSourceBinCollectionNote(_ note: String) {
        let normalizedNote = ProjectMediaSourceBinCollectionMetadata.normalizedNote(note)
        let metadata = mediaSourceBinActiveCollectionMetadata
        guard metadata.note != normalizedNote else { return }
        updateActiveSourceBinCollectionMetadata(
            ProjectMediaSourceBinCollectionMetadata(status: metadata.status, note: normalizedNote)
        )
    }

    func selectSourceBinCollection(_ collectionName: String) {
        let normalizedName = StudioViewModel.normalizedMediaSourceBinCollectionName(collectionName)
        mediaSourceBinActiveCollectionName = normalizedName
        mediaSourceBinFilter = .collection
        timelineStatus = "\(normalizedName) を選択しました。"
    }

    func moveActiveSourceBinCollectionEarlier() {
        moveActiveSourceBinCollection(by: -1)
    }

    func moveActiveSourceBinCollectionLater() {
        moveActiveSourceBinCollection(by: 1)
    }

    private func moveActiveSourceBinCollection(by offset: Int) {
        guard let scopeID = mediaSourceBinScopeID else {
            timelineStatus = "プロジェクトを選択すると選別binの順序を保存できます。"
            return
        }
        let orderedNames = ProjectMediaSourceBinCollectionCatalog.moving(
            mediaSourceBinActiveCollectionLabel,
            by: offset,
            in: mediaSourceBinCollectionNames
        )
        guard orderedNames != mediaSourceBinCollectionNames else { return }
        setMediaSourceBinCollectionOrder(orderedNames, for: scopeID)
        timelineStatus = "\(mediaSourceBinActiveCollectionLabel)の表示順を更新しました。"
    }

    private func ensureMediaSourceBinCollectionIsOrdered(_ rawName: String, for scopeID: ProjectSummary.ID) {
        let name = StudioViewModel.normalizedMediaSourceBinCollectionName(rawName)
        let orderedNames = mediaSourceBinCollectionNames
        guard !orderedNames.contains(name) else {
            setMediaSourceBinCollectionOrder(orderedNames, for: scopeID)
            return
        }
        setMediaSourceBinCollectionOrder(orderedNames + [name], for: scopeID)
    }

    private func setMediaSourceBinCollectionOrder(_ orderedNames: [String], for scopeID: ProjectSummary.ID) {
        var orderByProject = mediaSourceBinCollectionOrderByProject
        let normalizedNames = ProjectMediaSourceBinCollectionCatalog.names(
            storedNames: orderedNames,
            activeName: mediaSourceBinActiveCollectionLabel,
            preferredOrder: orderedNames
        )
        if normalizedNames.isEmpty {
            orderByProject.removeValue(forKey: scopeID)
        } else {
            orderByProject[scopeID] = normalizedNames
        }
        mediaSourceBinCollectionOrderByProject = orderByProject
    }

    private func updateActiveSourceBinCollectionMetadata(_ metadata: ProjectMediaSourceBinCollectionMetadata) {
        guard let scopeID = mediaSourceBinScopeID else {
            timelineStatus = "プロジェクトを選択すると選別binの用途を保存できます。"
            return
        }
        var metadataByProject = mediaSourceBinCollectionMetadataByProject
        let projectMetadata = metadataByProject[scopeID] ?? [:]
        let updatedMetadata = ProjectMediaSourceBinCollectionMetadataCatalog.storing(
            metadata,
            for: mediaSourceBinActiveCollectionLabel,
            in: projectMetadata
        )
        if updatedMetadata.isEmpty {
            metadataByProject.removeValue(forKey: scopeID)
        } else {
            metadataByProject[scopeID] = updatedMetadata
        }
        mediaSourceBinCollectionMetadataByProject = metadataByProject
        ensureMediaSourceBinCollectionIsOrdered(mediaSourceBinActiveCollectionLabel, for: scopeID)
    }

    func createSourceBinCollection() {
        guard let scopeID = mediaSourceBinScopeID else {
            timelineStatus = "プロジェクトを選択すると選別binを作成できます。"
            return
        }
        let nextName = ProjectMediaSourceBinCollectionCatalog.nextName(existingNames: mediaSourceBinCollectionNames)
        var collectionsByProject = mediaSourceBinCollectionAssetIDsByProject
        var projectCollections = collectionsByProject[scopeID] ?? [:]
        projectCollections[nextName] = projectCollections[nextName] ?? []
        collectionsByProject[scopeID] = projectCollections
        mediaSourceBinCollectionAssetIDsByProject = collectionsByProject
        setMediaSourceBinCollectionOrder(mediaSourceBinCollectionNames + [nextName], for: scopeID)
        mediaSourceBinActiveCollectionName = nextName
        mediaSourceBinFilter = .collection
        timelineStatus = "\(nextName) を作成しました。素材のstackボタンで追加できます。"
    }

    func renameActiveSourceBinCollection(to rawName: String) {
        guard let scopeID = mediaSourceBinScopeID else {
            mediaSourceBinActiveCollectionName = StudioViewModel.normalizedMediaSourceBinCollectionName(rawName)
            timelineStatus = "プロジェクトを選択すると選別bin名を保存できます。"
            return
        }

        let oldName = mediaSourceBinActiveCollectionLabel
        let newName = StudioViewModel.normalizedMediaSourceBinCollectionName(rawName)
        guard oldName != newName else {
            mediaSourceBinActiveCollectionName = newName
            return
        }
        let renamedOrder = ProjectMediaSourceBinCollectionCatalog.renamingOrder(
            oldName,
            to: newName,
            in: mediaSourceBinCollectionNames
        )

        var collectionsByProject = mediaSourceBinCollectionAssetIDsByProject
        let projectCollections = collectionsByProject[scopeID] ?? [:]
        let renamedCollections = ProjectMediaSourceBinCollectionCatalog.renaming(
            oldName,
            to: newName,
            in: projectCollections
        )
        if renamedCollections.isEmpty {
            collectionsByProject.removeValue(forKey: scopeID)
        } else {
            collectionsByProject[scopeID] = renamedCollections
        }
        mediaSourceBinCollectionAssetIDsByProject = collectionsByProject
        var metadataByProject = mediaSourceBinCollectionMetadataByProject
        let projectMetadata = metadataByProject[scopeID] ?? [:]
        let renamedMetadata = ProjectMediaSourceBinCollectionMetadataCatalog.renaming(
            oldName,
            to: newName,
            in: projectMetadata
        )
        if renamedMetadata.isEmpty {
            metadataByProject.removeValue(forKey: scopeID)
        } else {
            metadataByProject[scopeID] = renamedMetadata
        }
        mediaSourceBinCollectionMetadataByProject = metadataByProject
        mediaSourceBinActiveCollectionName = newName
        setMediaSourceBinCollectionOrder(renamedOrder, for: scopeID)
        timelineStatus = "\(oldName) を \(newName) に変更しました。"
    }

    func deleteActiveSourceBinCollection() {
        guard let scopeID = mediaSourceBinScopeID else {
            timelineStatus = "プロジェクトを選択すると選別binを削除できます。"
            return
        }
        let deletedName = mediaSourceBinActiveCollectionLabel
        let orderedNamesAfterDelete = ProjectMediaSourceBinCollectionCatalog.deletingOrder(
            deletedName,
            in: mediaSourceBinCollectionNames
        )
        var collectionsByProject = mediaSourceBinCollectionAssetIDsByProject
        var projectCollections = collectionsByProject[scopeID] ?? [:]
        var metadataByProject = mediaSourceBinCollectionMetadataByProject
        var projectMetadata = metadataByProject[scopeID] ?? [:]
        let removedCollection = projectCollections.removeValue(forKey: deletedName) != nil
        let removedMetadata = projectMetadata.removeValue(forKey: deletedName) != nil
        guard removedCollection || removedMetadata else {
            timelineStatus = "\(deletedName) はまだ保存された選別binではありません。"
            return
        }
        if projectCollections.isEmpty {
            collectionsByProject.removeValue(forKey: scopeID)
        } else {
            collectionsByProject[scopeID] = projectCollections
        }
        mediaSourceBinCollectionAssetIDsByProject = collectionsByProject
        if projectMetadata.isEmpty {
            metadataByProject.removeValue(forKey: scopeID)
        } else {
            metadataByProject[scopeID] = projectMetadata
        }
        mediaSourceBinCollectionMetadataByProject = metadataByProject
        mediaSourceBinActiveCollectionName = orderedNamesAfterDelete.first ?? ProjectMediaSourceBinCollectionCatalog.defaultName
        setMediaSourceBinCollectionOrder(orderedNamesAfterDelete, for: scopeID)
        timelineStatus = "\(deletedName) を削除しました。"
    }

    func addVisibleSourceBinItemsToActiveCollection() {
        guard let scopeID = mediaSourceBinScopeID else {
            timelineStatus = "プロジェクトを選択すると表示中の素材を選別binへ追加できます。"
            return
        }
        let visibleAssetIDs = Set(filteredMediaSourceBinAssetIDs)
        guard !visibleAssetIDs.isEmpty else {
            timelineStatus = "表示中の素材がないため、\(mediaSourceBinActiveCollectionLabel)へ追加できません。"
            return
        }

        let collectionName = mediaSourceBinActiveCollectionLabel
        let existingAssetIDs = mediaSourceBinActiveCollectionAssetIDs
        let addedCount = visibleAssetIDs.subtracting(existingAssetIDs).count
        guard addedCount > 0 else {
            timelineStatus = "表示中の素材はすべて\(collectionName)に入っています。"
            return
        }

        var collectionsByProject = mediaSourceBinCollectionAssetIDsByProject
        let projectCollections = collectionsByProject[scopeID] ?? [:]
        collectionsByProject[scopeID] = ProjectMediaSourceBinCollectionCatalog.adding(
            visibleAssetIDs,
            to: collectionName,
            in: projectCollections
        )
        mediaSourceBinCollectionAssetIDsByProject = collectionsByProject
        ensureMediaSourceBinCollectionIsOrdered(collectionName, for: scopeID)
        timelineStatus = "表示中の素材 \(addedCount)件を\(collectionName)に追加しました。"
    }

    func removeVisibleSourceBinItemsFromActiveCollection() {
        guard let scopeID = mediaSourceBinScopeID else {
            timelineStatus = "プロジェクトを選択すると表示中の素材を選別binから外せます。"
            return
        }
        let visibleAssetIDs = Set(filteredMediaSourceBinAssetIDs)
        guard !visibleAssetIDs.isEmpty else {
            timelineStatus = "表示中の素材がないため、\(mediaSourceBinActiveCollectionLabel)から外せません。"
            return
        }

        let collectionName = mediaSourceBinActiveCollectionLabel
        let removedCount = visibleAssetIDs.intersection(mediaSourceBinActiveCollectionAssetIDs).count
        guard removedCount > 0 else {
            timelineStatus = "表示中の素材は\(collectionName)に入っていません。"
            return
        }

        var collectionsByProject = mediaSourceBinCollectionAssetIDsByProject
        let projectCollections = collectionsByProject[scopeID] ?? [:]
        collectionsByProject[scopeID] = ProjectMediaSourceBinCollectionCatalog.removing(
            visibleAssetIDs,
            from: collectionName,
            in: projectCollections
        )
        mediaSourceBinCollectionAssetIDsByProject = collectionsByProject
        ensureMediaSourceBinCollectionIsOrdered(collectionName, for: scopeID)
        timelineStatus = "表示中の素材 \(removedCount)件を\(collectionName)から外しました。"
    }

    func toggleSourceBinFavorite(_ assetID: String) {
        guard let scopeID = mediaSourceBinScopeID else {
            timelineStatus = "プロジェクトを選択すると素材のお気に入りを保存できます。"
            return
        }
        var favoritesByProject = mediaSourceBinFavoriteAssetIDsByProject
        var favorites = favoritesByProject[scopeID] ?? []
        let isRemoving = favorites.contains(assetID)
        if isRemoving {
            favorites.remove(assetID)
        } else {
            favorites.insert(assetID)
        }
        if favorites.isEmpty {
            favoritesByProject.removeValue(forKey: scopeID)
        } else {
            favoritesByProject[scopeID] = favorites
        }
        mediaSourceBinFavoriteAssetIDsByProject = favoritesByProject
        timelineStatus = isRemoving
            ? "\(assetID) をお気に入りから外しました。"
            : "\(assetID) をお気に入りに追加しました。"
    }

    func toggleSourceBinManualBin(_ assetID: String) {
        guard let scopeID = mediaSourceBinScopeID else {
            timelineStatus = "プロジェクトを選択すると素材の作業binを保存できます。"
            return
        }
        var manualBinsByProject = mediaSourceBinManualAssetIDsByProject
        var manualAssetIDs = manualBinsByProject[scopeID] ?? []
        let isRemoving = manualAssetIDs.contains(assetID)
        if isRemoving {
            manualAssetIDs.remove(assetID)
        } else {
            manualAssetIDs.insert(assetID)
        }
        if manualAssetIDs.isEmpty {
            manualBinsByProject.removeValue(forKey: scopeID)
        } else {
            manualBinsByProject[scopeID] = manualAssetIDs
        }
        mediaSourceBinManualAssetIDsByProject = manualBinsByProject
        timelineStatus = isRemoving
            ? "\(assetID) を作業binから外しました。"
            : "\(assetID) を作業binに追加しました。"
    }

    func toggleSourceBinActiveCollection(_ assetID: String) {
        guard let scopeID = mediaSourceBinScopeID else {
            timelineStatus = "プロジェクトを選択すると素材の選別binを保存できます。"
            return
        }
        let collectionName = mediaSourceBinActiveCollectionLabel
        var collectionsByProject = mediaSourceBinCollectionAssetIDsByProject
        var projectCollections = collectionsByProject[scopeID] ?? [:]
        var assetIDs = projectCollections[collectionName] ?? []
        let isRemoving = assetIDs.contains(assetID)
        if isRemoving {
            assetIDs.remove(assetID)
        } else {
            assetIDs.insert(assetID)
        }
        projectCollections[collectionName] = assetIDs
        collectionsByProject[scopeID] = projectCollections
        mediaSourceBinCollectionAssetIDsByProject = collectionsByProject
        ensureMediaSourceBinCollectionIsOrdered(collectionName, for: scopeID)
        timelineStatus = isRemoving
            ? "\(assetID) を\(collectionName)から外しました。"
            : "\(assetID) を\(collectionName)に追加しました。"
    }

    func sourceBinQuickDragPayload(for assetID: String) -> String? {
        guard let candidate = sourceBinQuickDragCandidate(for: assetID) else {
            return nil
        }
        return StudioDragPayload.sourceCandidate(assetID: assetID, candidateID: candidate.id)
    }

    func sourceBinQuickDragSummary(for assetID: String) -> SourceBinQuickDragSummary? {
        guard let candidate = sourceBinQuickDragCandidate(for: assetID) else {
            return nil
        }
        let role = TimelineSourceInsertPlan.insertRole(for: candidate.role)
        let durationSeconds = Double(max(1, candidate.src_out_us - candidate.src_in_us)) / 1_000_000
        return SourceBinQuickDragSummary(
            candidateID: candidate.id,
            segmentID: candidate.segment_id,
            roleLabel: localizedClipRole(role),
            targetTrackID: TimelineSourceInsertPlan.targetTrackID(forRole: role),
            sourceRangeLabel: "\(formatMicrosecondClock(candidate.src_in_us))-\(formatMicrosecondClock(candidate.src_out_us))",
            durationLabel: formatSeconds(durationSeconds),
            confidenceLabel: String(format: "%.0f%%", candidate.confidence * 100)
        )
    }

    private func sourceBinQuickDragCandidate(for assetID: String) -> BrowserCandidate? {
        guard let timeline,
              mediaPreviewSummary.items.contains(where: { $0.assetID == assetID && $0.playbackStatus.isReady }),
              let dataSource = candidateDataSource
        else {
            return nil
        }
        let usedSegmentIDs = Set(timeline.displayTracks.flatMap(\.clips).map(\.segmentID))
        return TimelineSourceInsertPlan.bestCandidate(
            in: dataSource,
            sourceAssetID: assetID,
            usedSegmentIDs: usedSegmentIDs
        )
    }

    private var mediaSourceBinScopeID: ProjectSummary.ID? {
        selectedProjectID ?? selectedProject?.id
    }

    var selectedTimelineClipCount: Int {
        if !selectedTimelineClipIDs.isEmpty {
            return selectedTimelineClipIDs.count
        }
        return selectedTimelineClipID == nil ? 0 : 1
    }

    var hasMultipleTimelineClipSelection: Bool {
        selectedTimelineClipCount > 1
    }

    var canTrimSelectedTimelineClip: Bool {
        guard !hasMultipleTimelineClipSelection else { return false }
        guard let clip = selectedTimelineClip?.clip,
              let sourceInUS = clip.sourceInUS,
              let sourceOutUS = clip.sourceOutUS else { return false }
        return sourceOutUS > sourceInUS
    }

    var canTrimSelectedTimelineClipStartToPlayhead: Bool {
        makePlayheadTrimPlan(edge: .start, reason: "Studio timeline toolbar trim start to playhead") != nil
    }

    var canTrimSelectedTimelineClipEndToPlayhead: Bool {
        makePlayheadTrimPlan(edge: .end, reason: "Studio timeline toolbar trim end to playhead") != nil
    }

    var canExtendSelectedTimelineClipStart: Bool {
        makeExtendTrimPlan(
            edge: .start,
            reason: "Studio timeline toolbar extend start"
        ) != nil
    }

    var canExtendSelectedTimelineClipEnd: Bool {
        makeExtendTrimPlan(
            edge: .end,
            reason: "Studio timeline toolbar extend end"
        ) != nil
    }

    var canRollSelectedIncomingEditLeft: Bool {
        makeRollTrimPlan(
            boundary: .incoming,
            direction: .left,
            reason: "Studio timeline toolbar roll incoming edit left"
        ) != nil
    }

    var canRollSelectedIncomingEditRight: Bool {
        makeRollTrimPlan(
            boundary: .incoming,
            direction: .right,
            reason: "Studio timeline toolbar roll incoming edit right"
        ) != nil
    }

    var canRollSelectedOutgoingEditLeft: Bool {
        makeRollTrimPlan(
            boundary: .outgoing,
            direction: .left,
            reason: "Studio timeline toolbar roll outgoing edit left"
        ) != nil
    }

    var canRollSelectedOutgoingEditRight: Bool {
        makeRollTrimPlan(
            boundary: .outgoing,
            direction: .right,
            reason: "Studio timeline toolbar roll outgoing edit right"
        ) != nil
    }

    var canSlipSelectedTimelineClipLeft: Bool {
        makeSlipTrimPlan(
            direction: .left,
            reason: "Studio timeline toolbar slip left"
        ) != nil
    }

    var canSlipSelectedTimelineClipRight: Bool {
        makeSlipTrimPlan(
            direction: .right,
            reason: "Studio timeline toolbar slip right"
        ) != nil
    }

    var canSplitSelectedTimelineClipAtPlayhead: Bool {
        makeSplitPlan(reason: "Studio timeline toolbar split at playhead") != nil
    }

    var canRippleDeleteSelectedTimelineClip: Bool {
        makeRippleDeleteSelectionPlan(reason: "Studio timeline toolbar ripple delete") != nil
    }

    var canNudgeSelectedTimelineClipEarlier: Bool {
        makeSelectedTimelineClipNudgePlan(
            direction: .earlier,
            reason: "Studio timeline toolbar nudge earlier"
        ) != nil
    }

    var canNudgeSelectedTimelineClipLater: Bool {
        makeSelectedTimelineClipNudgePlan(
            direction: .later,
            reason: "Studio timeline toolbar nudge later"
        ) != nil
    }

    var canRemoveSelectedTimelineTransition: Bool {
        selectedTimelineTransition != nil
    }

    var canShortenSelectedTimelineTransitionDuration: Bool {
        canChangeSelectedTimelineTransitionDuration(by: -timelineTransitionDurationStepFrames)
    }

    var canLengthenSelectedTimelineTransitionDuration: Bool {
        canChangeSelectedTimelineTransitionDuration(by: timelineTransitionDurationStepFrames)
    }

    var canDeleteTimelineSelection: Bool {
        guard let timeline else {
            return canRemoveSelectedTimelineTransition
        }
        return canRemoveSelectedTimelineTransition
            || canRippleDeleteSelectedTimelineClip
            || makeLiftDeleteSelectionPlan(
                timeline: timeline,
                reason: "Studio timeline delete selection"
            ) != nil
    }

    var canSetLoopPlaybackRangeToSelection: Bool {
        guard let timeline, sourceMonitorAssetID == nil else { return false }
        if let transition = selectedTimelineTransition {
            return TimelinePlaybackLoop.transitionReviewRange(timeline: timeline, transition: transition) != nil
        }
        let clips = activeSelectedTimelineClipIDs().compactMap { timeline.clipSelection(for: $0)?.clip }
        return TimelinePlaybackLoop.range(covering: clips) != nil
    }

    var hasTimelineSelectionOrTemporaryTool: Bool {
        selectedTimelineClipCount > 0
            || selectedTimelineTransitionID != nil
            || isTimelineMultiSelectMode
            || isTimelineBladeModeEnabled
            || timelineTransitionDurationPreview != nil
            || timelineClipMoveViewerPreview != nil
            || timelineDragTrimViewerPreview != nil
            || timelineSlipTrimViewerPreview != nil
            || timelineRollTrimViewerPreview != nil
            || timelineSkimPreview != nil
            || sourceBinSkimPreview != nil
    }

    var selectedTimelineTransition: TimelineTransition? {
        timeline?.transitions.first {
            $0.id == selectedTimelineTransitionID && $0.isVisibleTimelineTransition
        }
    }

    private var timelineTransitionDurationStepFrames: Int {
        guard let timeline else { return 1 }
        return max(1, Int((timeline.sequence.fps * 0.5).rounded()))
    }

    private func canChangeSelectedTimelineTransitionDuration(by frameDelta: Int) -> Bool {
        guard frameDelta != 0,
              let timeline,
              let transition = selectedTimelineTransition,
              let handles = timeline.transitionHandles(
                trackID: transition.trackID,
                fromClipID: transition.fromClipID,
                toClipID: transition.toClipID
              ),
              handles > 0
        else {
            return false
        }

        let currentFrames = transition.transitionFrames ?? min(TimelineTransitionPreset.defaultPreset.defaultFrames, handles)
        let nextFrames = min(handles, max(1, currentFrames + frameDelta))
        return nextFrames != currentFrames
    }

    var programTimelineClip: TimelineClipSelection? {
        activeViewerTimeline?.programSelection(atFrame: activeViewerFrame)
    }

    var programAudioTimelineClip: TimelineClipSelection? {
        activeViewerTimeline?.audioProgramSelection(atFrame: activeViewerFrame)
    }

    var nextProgramTimelineClip: TimelineClipSelection? {
        activeViewerTimeline?.programSelection(afterFrame: activeViewerFrame)
    }

    private var shouldUseTimelinePreviewPlayback: Bool {
        sourceMonitorAssetID == nil
            && !feedbackSession.isDirty
            && timelineTransitionDurationPreview == nil
            && timelineClipMoveViewerPreview == nil
            && timelineDragTrimViewerPreview == nil
            && timelineSlipTrimViewerPreview == nil
            && timelineRollTrimViewerPreview == nil
    }

    private var activeViewerTimeline: TimelineDocument? {
        timelineRollTrimViewerPreview?.timeline
            ?? timelineSlipTrimViewerPreview?.timeline
            ?? timelineDragTrimViewerPreview?.timeline
            ?? timelineClipMoveViewerPreview?.timeline
            ?? timelineWithTransitionDurationPreview
            ?? timeline
    }

    private var activeViewerFrame: Int {
        timelineRollTrimViewerPreview?.previewFrame
            ?? timelineSlipTrimViewerPreview?.previewFrame
            ?? timelineDragTrimViewerPreview?.previewFrame
            ?? timelineClipMoveViewerPreview?.previewFrame
            ?? timelineTransitionDurationPreview?.previewFrame
            ?? timelineSkimPreview?.frame
            ?? playheadFrame
    }

    var activeViewerPlayheadLabel: String? {
        if let sourceBinSkimPreview {
            return "SOURCE SKIM \(formatMicrosecondClock(sourceBinSkimPreview.previewTimeUS))"
        }
        guard let timecode = activeViewerTimeline?.sequence.framesToTimecode(activeViewerFrame) else { return nil }
        if timelineDragTrimViewerPreview != nil {
            return "TRIM \(timecode)"
        }
        if timelineSlipTrimViewerPreview != nil {
            return "SLIP \(timecode)"
        }
        if timelineRollTrimViewerPreview != nil {
            return "ROLL \(timecode)"
        }
        if timelineTransitionDurationPreview != nil {
            return "TRANS \(timecode)"
        }
        if timelineClipMoveViewerPreview == nil, timelineSkimPreview != nil {
            return "SKIM \(timecode)"
        }
        return timecode
    }

    var activeViewerMonitorSnapshot: TimelineMonitorSnapshot? {
        guard sourceBinSkimMediaReference == nil,
              sourceMonitorAssetID == nil
        else { return nil }
        return activeViewerTimeline?.monitorSnapshot(atFrame: activeViewerFrame)
    }

    var selectedClipEvidence: ClipEvidence? {
        guard let clip = selectedTimelineClip?.clip else { return nil }
        return evidenceStore?.evidence(for: clip)
    }

    var selectedClipNote: ProjectEditorClipNote? {
        guard let clipID = selectedTimelineClipID else { return nil }
        return editorAnnotations?.note(for: clipID)
    }

    var selectedClipNoteDraftState: ProjectEditorAnnotationDraftState {
        ProjectEditorAnnotationDraftState.evaluate(
            hasSelectedClip: selectedTimelineClipID != nil,
            noteDraft: selectedClipNoteDraft,
            handoffInstructionDraft: selectedClipHandoffInstructionDraft,
            savedNote: selectedClipNote?.note,
            savedHandoffInstruction: selectedClipNote?.handoffInstruction
        )
    }

    var canSaveSelectedClipNoteDraft: Bool {
        selectedClipNoteDraftState.canSave
    }

    var selectedMediaReference: ProjectMediaReference? {
        guard let project = selectedProject, let selection = selectedTimelineClip else { return nil }
        return ProjectMediaResolver.resolveSelectedClip(
            projectURL: project.path,
            clip: selection.clip,
            assets: evidenceStore?.assets
        )
    }

    var sourceMonitorMediaReference: ProjectMediaReference? {
        guard let project = selectedProject,
              let assetID = sourceMonitorAssetID,
              let status = mediaPreviewSummary.items.first(where: { $0.assetID == assetID })
        else { return nil }
        return ProjectMediaResolver.resolvePreviewStatus(
            projectURL: project.path,
            status: status,
            assets: evidenceStore?.assets,
            previewTimeUS: sourceMonitorPreviewTimeUS
        )
    }

    var sourceBinSkimMediaReference: ProjectMediaReference? {
        guard let project = selectedProject,
              let preview = sourceBinSkimPreview,
              let status = mediaPreviewSummary.items.first(where: { $0.assetID == preview.assetID && $0.playbackStatus.isReady })
        else { return nil }
        return ProjectMediaResolver.resolvePreviewStatus(
            projectURL: project.path,
            status: status,
            assets: evidenceStore?.assets,
            previewTimeUS: preview.previewTimeUS
        )
    }

    var canInsertSourceMonitorAtPlayhead: Bool {
        makeSourceMonitorInsertPlan(reason: "Studio source monitor insert at playhead") != nil
    }

    var canAppendSourceMonitorToTimelineEnd: Bool {
        makeSourceMonitorAppendPlan(reason: "Studio source monitor append to timeline end") != nil
    }

    var canOverwriteSourceMonitorAtPlayhead: Bool {
        makeSourceMonitorOverwritePlan(reason: "Studio source monitor overwrite at playhead") != nil
    }

    var canReplaceSelectedClipWithSourceMonitorCandidate: Bool {
        makeSourceMonitorReplacePlan(reason: "Studio source monitor replace selected clip") != nil
    }

    var canRevealSelectedTimelineClipInSourceMonitor: Bool {
        guard let clip = selectedTimelineClip?.clip else { return false }
        return canRevealTimelineClipInSourceMonitor(clip)
    }

    var sourceMonitorOverwritePreview: TimelineSourceOverwritePreview? {
        guard sourceMonitorAssetID != nil,
              let summary = sourceMonitorInsertCandidateSummary,
              let plan = makeSourceMonitorOverwritePlan(reason: "Studio source monitor overwrite preview")
        else {
            return nil
        }
        return TimelineSourceOverwritePreview(
            insertedClipID: plan.insertedClipID,
            segmentID: plan.candidate.segment_id,
            markedRangeLabel: summary.markedRangeLabel,
            targetTrackID: plan.targetTrackID,
            timelineInFrame: plan.timelineInFrame,
            overwriteOutFrame: plan.overwriteOutFrame,
            durationFrames: plan.durationFrames,
            removedClipIDs: plan.removedClipIDs,
            trimmedClipIDs: plan.trimmedClipIDs,
            splitClipIDs: plan.splitClipIDs
        )
    }

    func previewSourceMonitorCandidateDropOnTimeline(
        sourceAssetID: String,
        candidateID: BrowserCandidate.ID,
        timelineFrame: Int,
        targetTrackID: TimelineTrack.ID,
        snapThresholdFrames: Int
    ) -> TimelineSourceCandidateDropPreview? {
        guard let timeline,
              let dataSource = candidateDataSource,
              let candidate = dataSource.candidates.first(where: { $0.id == candidateID && $0.asset_id == sourceAssetID })
        else {
            return nil
        }

        let role = TimelineSourceInsertPlan.insertRole(for: candidate.role)
        let targetKind = TimelineSourceInsertPlan.targetKind(forRole: role)
        let targetTrack = timeline.displayTracks.first { $0.id == targetTrackID }
        let sourceRange = sourceMonitorMarkedRangeOverride(for: candidateID)
            ?? TimelineSourceRangeOverride(sourceInUS: candidate.src_in_us, sourceOutUS: candidate.src_out_us)!
        let timelineInFrame = max(0, min(timelineFrame, timeline.totalFrames))
        let durationFrames = max(1, Int((Double(sourceRange.sourceOutUS - sourceRange.sourceInUS) / 1_000_000 * timeline.sequence.fps).rounded()))
        let plan = TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: sourceAssetID,
            playheadFrame: timelineFrame,
            reason: "Studio source monitor candidate drop preview",
            candidateID: candidateID,
            preferredTargetTrackID: targetTrackID,
            sourceRangeOverride: sourceMonitorMarkedRangeOverride(for: candidateID),
            snapThresholdFrames: snapThresholdFrames,
            snapPlayheadFrame: playheadFrame
        )
        let laneLift = plan?.laneLift

        return TimelineSourceCandidateDropPreview(
            candidateID: candidateID,
            segmentID: candidate.segment_id,
            markedRangeLabel: "\(formatMicrosecondClock(sourceRange.sourceInUS))-\(formatMicrosecondClock(sourceRange.sourceOutUS))",
            roleLabel: localizedClipRole(role),
            targetTrackKind: targetKind,
            requestedTrackID: targetTrackID,
            targetTrackID: plan?.targetTrackID ?? targetTrackID,
            proposedTimelineInFrame: plan?.proposedTimelineInFrame ?? timelineInFrame,
            timelineInFrame: plan?.timelineInFrame ?? timelineInFrame,
            durationFrames: plan?.durationFrames ?? durationFrames,
            isCompatibleTarget: targetTrack?.kind == targetKind && plan != nil,
            isLaneLifted: laneLift != nil,
            laneLiftCreatesTrack: laneLift?.createsTrack ?? false,
            overlappedClipCount: laneLift?.overlappedClipIDs.count ?? 0,
            snap: plan?.snap
        )
    }

    var sourceMonitorInsertCandidateSummary: SourceMonitorInsertCandidateSummary? {
        let candidates = sourceMonitorInsertCandidates()
        guard let candidate = selectedSourceMonitorCandidate(in: candidates),
              let index = candidates.firstIndex(where: { $0.id == candidate.id }) else {
            return nil
        }
        let role = TimelineSourceInsertPlan.insertRole(for: candidate.role)
        let markedRange = effectiveSourceMonitorMarkedRange(for: candidate)
        let playbackSourceUS = currentSourceMonitorPlaybackUS(for: candidate)
        let durationSeconds = Double(max(1, candidate.src_out_us - candidate.src_in_us)) / 1_000_000
        let markedDurationSeconds = Double(max(1, markedRange.sourceOutUS - markedRange.sourceInUS)) / 1_000_000
        return SourceMonitorInsertCandidateSummary(
            candidateID: candidate.id,
            segmentID: candidate.segment_id,
            positionLabel: "\(index + 1)/\(candidates.count)",
            roleLabel: localizedClipRole(role),
            targetTrackID: TimelineSourceInsertPlan.targetTrackID(forRole: role),
            sourceRangeLabel: "\(formatMicrosecondClock(candidate.src_in_us))-\(formatMicrosecondClock(candidate.src_out_us))",
            markedRangeLabel: "\(formatMicrosecondClock(markedRange.sourceInUS))-\(formatMicrosecondClock(markedRange.sourceOutUS))",
            durationLabel: formatSeconds(durationSeconds),
            markedDurationLabel: formatSeconds(markedDurationSeconds),
            playbackSourceLabel: playbackSourceUS.map(formatMicrosecondClock),
            markedInFraction: TimelineSourceRangeMarkPlan.fraction(
                sourceUS: markedRange.sourceInUS,
                candidateSourceInUS: candidate.src_in_us,
                candidateSourceOutUS: candidate.src_out_us
            ),
            markedOutFraction: TimelineSourceRangeMarkPlan.fraction(
                sourceUS: markedRange.sourceOutUS,
                candidateSourceInUS: candidate.src_in_us,
                candidateSourceOutUS: candidate.src_out_us
            ),
            confidenceLabel: String(format: "%.0f%%", candidate.confidence * 100),
            reason: candidate.why_it_matches,
            isMarkedRangeCustom: markedRange.sourceInUS != candidate.src_in_us || markedRange.sourceOutUS != candidate.src_out_us,
            canMoveMarkInEarlier: markedRange.sourceInUS > candidate.src_in_us,
            canMoveMarkInLater: markedRange.sourceInUS + sourceMonitorMarkStepUS < markedRange.sourceOutUS,
            canMoveMarkOutEarlier: markedRange.sourceOutUS - sourceMonitorMarkStepUS > markedRange.sourceInUS,
            canMoveMarkOutLater: markedRange.sourceOutUS < candidate.src_out_us,
            canMarkInAtPlaybackTime: playbackSourceUS != nil,
            canMarkOutAtPlaybackTime: playbackSourceUS != nil,
            canSelectPrevious: index > 0,
            canSelectNext: index < candidates.count - 1
        )
    }

    var canMarkSourceMonitorInAtPlaybackTime: Bool {
        sourceMonitorPlaybackMarkRange(handle: .inPoint) != nil
    }

    var canMarkSourceMonitorOutAtPlaybackTime: Bool {
        sourceMonitorPlaybackMarkRange(handle: .outPoint) != nil
    }

    var canNudgeSourceMonitorMarkInEarlier: Bool {
        sourceMonitorInsertCandidateSummary?.canMoveMarkInEarlier == true
    }

    var canNudgeSourceMonitorMarkInLater: Bool {
        sourceMonitorInsertCandidateSummary?.canMoveMarkInLater == true
    }

    var canNudgeSourceMonitorMarkOutEarlier: Bool {
        sourceMonitorInsertCandidateSummary?.canMoveMarkOutEarlier == true
    }

    var canNudgeSourceMonitorMarkOutLater: Bool {
        sourceMonitorInsertCandidateSummary?.canMoveMarkOutLater == true
    }

    var canResetSourceMonitorMarkedRange: Bool {
        sourceMonitorInsertCandidateSummary?.isMarkedRangeCustom == true
    }

    var canSelectPreviousSourceMonitorCandidate: Bool {
        sourceMonitorInsertCandidateSummary?.canSelectPrevious == true
    }

    var canSelectNextSourceMonitorCandidate: Bool {
        sourceMonitorInsertCandidateSummary?.canSelectNext == true
    }

    var sourceMonitorInsertHelp: String {
        guard sourceMonitorAssetID != nil else {
            return "ソース確認中の素材を再生位置へ追加します"
        }
        guard timeline != nil else {
            return "タイムライン生成後にソース素材を追加できます"
        }
        guard candidateDataSource != nil else {
            return "select候補を読み込み中です"
        }
        if let summary = sourceMonitorInsertCandidateSummary, canInsertSourceMonitorAtPlayhead {
            return "\(summary.segmentID) \(summary.markedRangeLabel) を \(summary.targetTrackID) の再生位置へ追加します"
        }
        return "この素材に追加できるselect候補がありません"
    }

    var sourceMonitorAppendHelp: String {
        guard sourceMonitorAssetID != nil else {
            return "ソース確認中の素材をタイムライン末尾へ追加します"
        }
        guard let timeline else {
            return "タイムライン生成後にソース素材を末尾へ追加できます"
        }
        guard candidateDataSource != nil else {
            return "select候補を読み込み中です"
        }
        if let summary = sourceMonitorInsertCandidateSummary,
           let plan = makeSourceMonitorAppendPlan(reason: "Studio source monitor append help") {
            let timecode = timeline.sequence.framesToTimecode(plan.timelineInFrame)
            return "\(summary.segmentID) \(summary.markedRangeLabel) を \(plan.targetTrackID) の末尾 \(timecode) へ追加します"
        }
        return "この素材に末尾へ追加できるselect候補がありません"
    }

    var sourceMonitorOverwriteHelp: String {
        guard sourceMonitorAssetID != nil else {
            return "ソース確認中の素材を再生位置から上書きします"
        }
        guard timeline != nil else {
            return "タイムライン生成後にソース素材を上書きできます"
        }
        guard candidateDataSource != nil else {
            return "select候補を読み込み中です"
        }
        guard let summary = sourceMonitorInsertCandidateSummary else {
            return "この素材に上書きできるselect候補がありません"
        }
        if let plan = makeSourceMonitorOverwritePlan(reason: "Studio source monitor overwrite at playhead") {
            let removePart = plan.removedClipIDs.isEmpty ? "既存clipの削除なし" : "\(plan.removedClipIDs.count)件を削除"
            let trimPart = plan.trimmedClipIDs.isEmpty ? "trimなし" : "\(plan.trimmedClipIDs.count)件をtrim"
            let splitPart = plan.splitClipIDs.isEmpty ? "splitなし" : "\(plan.splitClipIDs.count)件をsplit"
            return "\(summary.segmentID) \(summary.markedRangeLabel) を \(plan.targetTrackID) の再生位置から上書きします（\(removePart)、\(trimPart)、\(splitPart)）"
        }
        return "現在の再生位置では安全に上書きできません"
    }

    var sourceMonitorReplaceHelp: String {
        guard sourceMonitorAssetID != nil else {
            return "ソース確認中の素材で選択クリップを置換します"
        }
        guard selectedTimelineClip != nil else {
            return "置換するタイムラインクリップを選択してください"
        }
        guard timeline != nil else {
            return "タイムライン生成後に選択クリップを置換できます"
        }
        guard candidateDataSource != nil else {
            return "select候補を読み込み中です"
        }
        if let summary = sourceMonitorInsertCandidateSummary, canReplaceSelectedClipWithSourceMonitorCandidate {
            return "\(selectedTimelineClip?.clip.id ?? "選択クリップ") を \(summary.segmentID) \(summary.markedRangeLabel) で置換します"
        }
        return "選択クリップとソース候補の種類が合わないか、置換できるselect候補がありません"
    }

    var activeViewerSelection: TimelineClipSelection? {
        sourceBinSkimMediaReference == nil && sourceMonitorMediaReference == nil
            ? (programTimelineClip ?? selectedTimelineClip)
            : nil
    }

    var activeViewerMediaReference: ProjectMediaReference? {
        sourceBinSkimMediaReference ?? sourceMonitorMediaReference ?? programMediaReference
    }

    var activeViewerAudioMediaReference: ProjectMediaReference? {
        sourceBinSkimMediaReference == nil && sourceMonitorMediaReference == nil
            ? programAudioMediaReference
            : nil
    }

    var activeViewerNextMediaReference: ProjectMediaReference? {
        sourceBinSkimMediaReference == nil && sourceMonitorMediaReference == nil
            ? nextProgramMediaReference
            : nil
    }

    var activeViewerTransitionPreview: ViewerTransitionPreview? {
        guard sourceBinSkimMediaReference == nil,
              sourceMonitorMediaReference == nil,
              timelineClipMoveViewerPreview == nil,
              timelineDragTrimViewerPreview == nil,
              timelineSlipTrimViewerPreview == nil,
              timelineRollTrimViewerPreview == nil,
              !shouldUseTimelinePreviewPlayback,
              let project = selectedProject,
              let transitionPreview = timelineWithTransitionDurationPreview?
                .activeVisualTransitionPreview(atFrame: activeViewerFrame)
        else {
            return nil
        }
        let overlayMedia = ProjectMediaResolver.resolveSelectedClip(
            projectURL: project.path,
            clip: transitionPreview.overlaySelection.clip,
            assets: evidenceStore?.assets,
            previewTimeUS: transitionPreview.overlaySelection.clip.sourceTimeUS(
                atTimelineFrame: transitionPreview.overlayTimelineFrame
            )
        )
        guard let overlayMedia else { return nil }
        return ViewerTransitionPreview(
            media: overlayMedia,
            opacity: transitionPreview.overlayOpacity,
            label: transitionPreview.transition.localizedViewerLabel,
            syncGeneration: transitionOverlaySyncGeneration(for: transitionPreview, media: overlayMedia)
        )
    }

    private func transitionOverlaySyncGeneration(
        for preview: TimelineActiveTransitionPreview,
        media: ProjectMediaReference
    ) -> Int {
        let startMicroseconds = max(0, Int((media.viewerStartSeconds * 1_000_000).rounded()))
        return startMicroseconds
            ^ preview.overlayTimelineFrame
            ^ (preview.startFrame &* 31)
            ^ (preview.endFrame &* 37)
    }

    private var timelineWithTransitionDurationPreview: TimelineDocument? {
        guard let timeline,
              let preview = timelineTransitionDurationPreview,
              let previewTimeline = timeline.settingTransition(
                fromClipID: preview.fromClipID,
                toClipID: preview.toClipID,
                trackID: preview.trackID,
                transitionType: preview.transitionType,
                transitionFrames: preview.transitionFrames,
                appliedSkillID: preview.appliedSkillID
              )
        else {
            return timeline
        }
        return previewTimeline
    }

    var programMediaReference: ProjectMediaReference? {
        guard let project = selectedProject else { return nil }
        let timelinePreview = shouldUseTimelinePreviewPlayback
            ? timelinePreviewMediaReference(project: project)
            : nil
        guard let selection = activeViewerTimeline?.visualProgramSelection(atFrame: activeViewerFrame) else {
            return ProjectMediaResolver.preferredProgramMedia(
                timelinePreview: timelinePreview,
                source: nil
            )
        }
        let source = ProjectMediaResolver.resolveSelectedClip(
            projectURL: project.path,
            clip: selection.clip,
            assets: evidenceStore?.assets,
            previewTimeUS: selection.clip.sourceTimeUS(atTimelineFrame: activeViewerFrame)
        )
        return ProjectMediaResolver.preferredProgramMedia(
            timelinePreview: timelinePreview,
            source: source
        )
    }

    var programAudioMediaReference: ProjectMediaReference? {
        guard let project = selectedProject, let selection = programAudioTimelineClip else { return nil }
        return ProjectMediaResolver.resolveSelectedClip(
            projectURL: project.path,
            clip: selection.clip,
            assets: evidenceStore?.assets,
            previewTimeUS: selection.clip.sourceTimeUS(atTimelineFrame: activeViewerFrame)
        )
    }

    var nextProgramMediaReference: ProjectMediaReference? {
        guard let project = selectedProject, let selection = nextProgramTimelineClip else { return nil }
        guard selection.trackKind != .audio else { return nil }
        return ProjectMediaResolver.resolveSelectedClip(
            projectURL: project.path,
            clip: selection.clip,
            assets: evidenceStore?.assets,
            previewTimeUS: selection.clip.sourceTimeUS(atTimelineFrame: selection.clip.timelineInFrame)
        )
    }

    private func timelinePreviewMediaReference(project: ProjectSummary) -> ProjectMediaReference? {
        let seconds = timeline?.sequence.framesToSeconds(activeViewerFrame) ?? 0
        return ProjectMediaResolver.resolveTimelinePreview(projectURL: project.path, playheadSeconds: seconds)
    }

    var timelineAudioCues: [TimelineAudioCue] {
        guard let timeline else { return [] }
        return ProjectAudioTimelineMap.build(timeline: timeline, evidence: evidenceStore).cues
    }

    var selectedTurnRecord: AgentTurnRecord? {
        guard let selectedTurnID else { return turnHistory.first }
        return turnHistory.first { $0.id == selectedTurnID } ?? turnHistory.first
    }

    var canPinSelectedAgentTurnToClipNoteDraft: Bool {
        guard selectedTimelineClipID != nil,
              let record = selectedTurnRecord,
              record.readOnly else {
            return false
        }
        return !record.assistantText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var selectedAgentReviewPatchDraft: TimelineAgentReviewPatchDraft? {
        guard let record = selectedTurnRecord,
              record.readOnly,
              !record.assistantText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        let selectedClipIDs = activeSelectedTimelineClipIDs()
        return TimelineAgentReviewPatchDraft.extract(
            from: record.assistantText,
            expectedTimelineVersion: timeline?.version,
            selectedClipIDs: selectedClipIDs
        )
    }

    var selectedAgentReviewPatchApplyPlan: TimelineAgentReviewPatchApplyPlan? {
        guard let draft = selectedAgentReviewPatchDraft,
              let timeline else {
            return nil
        }
        return TimelineAgentReviewPatchApplyPlan.evaluate(
            draft: draft,
            timeline: timeline,
            candidateDataSource: candidateDataSource
        )
    }

    var canApplySelectedAgentReviewPatchDraftToTimeline: Bool {
        selectedAgentReviewPatchApplyPlan?.canApply ?? false
    }

    func applySelectedAgentReviewPatchDraftToTimeline() {
        guard let timeline else {
            roughCutCompileStatus = "AI編集候補を表示へ反映する前にタイムラインを読み込んでください。"
            return
        }
        guard let plan = selectedAgentReviewPatchApplyPlan else {
            roughCutCompileStatus = "表示へ反映できるAI編集候補がありません。"
            return
        }
        guard plan.canApply else {
            roughCutCompileStatus = plan.summaryLabel
            return
        }
        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }

        timelineClipMoveViewerPreview = nil
        timelineTransitionDurationPreview = nil
        timelineDragTrimViewerPreview = nil
        timelineRollTrimViewerPreview = nil
        timelineSlipTrimViewerPreview = nil
        timelineSkimPreview = nil
        sourceBinSkimPreview = nil
        sourceMonitorAssetID = nil

        for operation in plan.operations {
            feedbackSession.addOp(operation)
        }

        self.timeline = plan.updatedTimeline
        setTimelineTransitionSelection(plan.selectedTransitionID)
        if let selectedClipID = plan.selectedClipID,
           plan.updatedTimeline.clipSelection(for: selectedClipID) != nil {
            setTimelineClipSelection(primary: selectedClipID, ids: [selectedClipID])
        } else if plan.selectedTransitionID != nil {
            setTimelineClipSelection(primary: nil, ids: [])
        } else {
            reconcileTimelineClipSelection(with: plan.updatedTimeline)
        }
        showChangedClipHighlight(plan.changedClipIDs)
        if let focusFrame = plan.focusFrame {
            setPlayheadFrame(min(max(focusFrame, 0), plan.updatedTimeline.totalFrames), forceSeek: true)
        } else {
            setPlayheadFrame(min(playheadFrame, plan.updatedTimeline.totalFrames), forceSeek: true)
        }
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
        let changedText = plan.changedClipIDs.isEmpty ? "" : " 対象: \(plan.changedClipIDs.joined(separator: ", "))。"
        roughCutCompileStatus = "AI編集候補 \(plan.operations.count)件をTimelineとViewerに反映しました。未保存のStudio編集です。\(changedText)"
    }

    private func installCommandObservers() {
        commandObserverTokens = [
            observe(.initializeStudioProject) { $0.chooseAndInitializeProject() },
            observe(.refreshStudioProjects) { $0.refresh() },
            observe(.runStudioAnalysis) { $0.runSelectedProjectAnalysis() },
            observe(.compileStudioRoughCut) { $0.compileSelectedProjectRoughCut() },
            observe(.compileStudioReviewPatch) { $0.compileSelectedProjectWithReviewPatch() },
            observe(.runStudioReviewJob) { $0.runReviewAgentJob() },
            observe(.rebuildStudioSearchIndex) { $0.rebuildSelectedProjectIndex() },
            observe(.openStudioSwapBrowser) { $0.openSwapBrowserForSelectedClip() },
            observe(.openStudioFootageSearch) { $0.openFootageSearch() },
            observe(.runStudioMarlinEvaluation) { $0.runSelectedProjectMarlinEvaluation() },
            observe(.buildStudioAudioStoryGraph) { $0.buildSelectedProjectAudioStoryGraph() },
            observe(.checkStudioAppServer) { $0.checkAppServer() },
            observe(.startStudioAgentSession) { $0.startAgentSession() },
            observe(.stopStudioAgentSession) { $0.stopAgentSession() },
            observe(.runStudioSelectedAgentJob) { $0.runSelectedJob() },
            observe(.runStudioReadOnlyAgentTurn) { $0.runAgentTurn() },
            observe(.approveStudioPendingAgentJob) { $0.approvePendingJob() },
            observe(.cancelStudioPendingAgentJob) { $0.cancelPendingJob() },
            observe(.buildStudioPreviewProxies) { $0.buildSelectedProjectMediaProxies() },
            observe(.runStudioSyntheticSmoke) { $0.runStudioSyntheticSmoke() },
            observe(.runStudioAcceptanceSmoke) { $0.runStudioAcceptanceSmoke() },
            observe(.relinkStudioMedia) { $0.chooseAndRelinkSelectedProjectMedia() },
            observe(.exportStudioPremiereXML) { $0.exportSelectedProjectPremiereXML() },
            observe(.exportStudioEditorPacket) { $0.exportSelectedProjectEditorPacket() },
            observe(.revealStudioEditorPacket) { $0.revealEditorPacketInFinder() },
            observe(.runStudioRender) { $0.runSelectedProjectRender() },
            observe(.playStudioPlaybackForward) { $0.playForwardShuttle() },
            observe(.playStudioPlaybackReverse) { $0.playReverseShuttle() },
            observe(.pauseStudioPlayback) { $0.pausePlayback() },
            observe(.toggleStudioPlayback) { $0.togglePlayback() },
            observe(.stepStudioPlaybackBackward) { $0.stepBackward() },
            observe(.stepStudioPlaybackForward) { $0.stepForward() },
            observe(.setStudioPlaybackLoopToSelection) { $0.setLoopPlaybackRangeToSelectedClip() },
            observe(.toggleStudioPlaybackLoop) { $0.toggleLoopPlayback() },
            observe(.clearStudioPlaybackLoop) { $0.clearLoopPlaybackRange() },
            observe(.zoomStudioTimelineIn) { $0.zoomTimelineIn() },
            observe(.zoomStudioTimelineOut) { $0.zoomTimelineOut() },
            observe(.fitStudioTimelineToWindow) { $0.fitTimelineToWindow() },
            observe(.resetStudioTimelineZoom) { $0.resetTimelineZoom() }
        ]
    }

    private func observe(
        _ name: Notification.Name,
        action: @escaping @MainActor (StudioViewModel) -> Void
    ) -> NSObjectProtocol {
        NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                action(self)
            }
        }
    }

    var selectedJobCanRun: Bool {
        guard appServerStatus != .checking else { return false }
        return selectedJobReadiness.canRun
    }

    var selectedJobReadinessLabel: String {
        selectedJobReadiness.label
    }

    var canPrepareTimelineAgentPrompt: Bool {
        selectedProject != nil
            && timeline != nil
            && (selectedTimelineTransition != nil || !activeSelectedTimelineClipIDs().isEmpty)
    }

    var timelineAgentSelectionLabel: String {
        guard selectedProject != nil, timeline != nil else { return "プロジェクト未選択" }
        let clipIDs = activeSelectedTimelineClipIDs()
        if let transition = selectedTimelineTransition {
            if clipIDs.isEmpty {
                return "トランジション \(transition.transitionType)"
            }
            return "\(clipIDs.count)クリップ + \(transition.transitionType)"
        }
        if clipIDs.count == 1, let clipID = clipIDs.first {
            return clipID
        }
        if clipIDs.count > 1 {
            return "\(clipIDs.count)クリップ"
        }
        return "タイムライン選択なし"
    }

    var timelineAgentConsultationPreviewLabel: String {
        guard selectedProject != nil, let timeline else {
            return "プロジェクトを選ぶと、AIへ渡す編集文脈を確認できます。"
        }
        var contextClipIDs = activeSelectedTimelineClipIDs()
        if let transition = selectedTimelineTransition {
            contextClipIDs.insert(transition.fromClipID)
            contextClipIDs.insert(transition.toClipID)
        }
        let selections = orderedTimelineClipIDs(in: contextClipIDs).compactMap { timeline.clipSelection(for: $0) }
        guard !selections.isEmpty || selectedTimelineTransition != nil else {
            return "クリップまたはトランジションを選ぶと、相談対象がここに表示されます。"
        }

        var parts: [String] = []
        if !selections.isEmpty {
            let rangeFrames = selections.flatMap { [$0.clip.timelineInFrame, $0.clip.timelineOutFrame] }
            if let start = rangeFrames.min(), let end = rangeFrames.max(), start < end {
                parts.append("\(selections.count)クリップ \(timeline.sequence.framesToTimecode(start))-\(timeline.sequence.framesToTimecode(end))")
            } else {
                parts.append("\(selections.count)クリップ")
            }
        }
        if let transition = selectedTimelineTransition {
            let duration = transition.transitionFrames.map { " / \($0)f" } ?? ""
            parts.append("\(transition.transitionType)\(duration) \(transition.fromClipID) → \(transition.toClipID)")
        }
        return "\(parts.joined(separator: " / ")) / \(selectedTimelineAgentIntent.localizedTitle) / 読み取り専用"
    }

    var timelineAgentConsultationContractLabel: String {
        "ファイルは変更しません。提案はPREVIEWとして返し、反映はreview_patchを確認してから行います。"
    }

    var timelineZoomLabel: String {
        TimelineViewportScale.displayLabel(
            pixelsPerFrame: timelinePixelsPerFrame,
            fitToViewport: isTimelineFitToWindowEnabled
        )
    }

    func zoomTimelineIn() {
        isTimelineFitToWindowEnabled = false
        timelinePixelsPerFrame = TimelineViewportScale.zoomedIn(from: timelinePixelsPerFrame)
    }

    func zoomTimelineOut() {
        isTimelineFitToWindowEnabled = false
        timelinePixelsPerFrame = TimelineViewportScale.zoomedOut(from: timelinePixelsPerFrame)
    }

    func fitTimelineToWindow() {
        isTimelineFitToWindowEnabled = true
    }

    func resetTimelineZoom() {
        isTimelineFitToWindowEnabled = false
        timelinePixelsPerFrame = TimelineViewportScale.defaultPixelsPerFrame
    }

    func setTimelinePixelsPerFrame(_ value: Double) {
        isTimelineFitToWindowEnabled = false
        timelinePixelsPerFrame = TimelineViewportScale.clampedPixelsPerFrame(value)
    }

    func setTimelineTrackDensity(_ density: TimelineTrackDensity) {
        timelineTrackDensity = density
    }

    func toggleTimelineSnapping() {
        isTimelineSnappingEnabled.toggle()
        roughCutCompileStatus = isTimelineSnappingEnabled
            ? "タイムライン吸着をオンにしました。ドラッグとスクラブは近い編集点、再生位置、マーカーへ吸着します。"
            : "タイムライン吸着をオフにしました。ドラッグとスクラブはカーソル位置を優先します。"
    }

    var commandAvailabilityContext: StudioCommandAvailabilityContext {
        StudioCommandAvailabilityContext(
            hasSelectedProject: selectedProject != nil,
            isAppServerChecking: appServerStatus == .checking,
            hasActiveThread: activeThreadID != nil,
            selectedAgentJobCanRun: selectedJobCanRun,
            hasPendingApproval: pendingApproval != nil,
            hasSelectedTimelineClip: selectedTimelineClip != nil || programTimelineClip != nil
        )
    }

    var activeAgentRAGContextSummary: String {
        guard !indexContextPack.isEmpty else {
            return "No indexed context selected."
        }
        return "\(indexContextPack.items.count) cited items from \(indexContextPack.query)."
    }

    private var selectedJobReadiness: VideoOSAgentJobReadiness {
        VideoOSAgentJobReadinessResolver.readiness(
            for: selectedJob,
            hasActiveThread: activeThreadID != nil,
            project: selectedProject,
            planningStatus: planningStatus,
            selectedTimelineClipAvailable: selectedTimelineClip != nil
        )
    }

    private func publishAgentMenuCommandAvailability() {
        let nextContext = commandAvailabilityContext
        guard StudioMenuCommandAvailabilityStore.shared.context != nextContext else { return }
        StudioMenuCommandAvailabilityStore.shared.context = nextContext
        NSApp.mainMenu?.update()
    }

    func refresh() {
        projects = ProjectScanner.scanProjects(in: repositoryRoot)
        if selectedProjectID == nil || !projects.contains(where: { $0.id == selectedProjectID }) {
            selectedProjectID = defaultProjectID()
        }
        loadTimelineForSelection()
        refreshRepositoryWideStatus()
    }

    private func defaultProjectID() -> ProjectSummary.ID? {
        Self.preferredReadyProjectID(from: projects)
            ?? projects.first { $0.hasTimeline && $0.stateLabel == "packaged" }?.id
            ?? projects.first(where: \.hasTimeline)?.id
            ?? projects.first?.id
    }

    func selectProject(_ projectID: ProjectSummary.ID, userInitiated: Bool = true) {
        if userInitiated {
            userSelectedProject = true
        }
        selectedProjectID = projectID
        loadTimelineForSelection()
    }

    private func refreshRepositoryWideStatus() {
        let root = repositoryRoot
        let projectSnapshot = projects
        Task.detached(priority: .utility) {
            let preferredReadyProjectID = Self.preferredReadyProjectID(from: projectSnapshot)
            let preferenceDecision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: root)
            let evaluationQueue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: root)
            let representativePlan = ProjectMarlinRepresentativePlanReader.plan(repositoryRoot: root)
            let runtimeStatus = ProjectMarlinRuntimeStatusReader.status(repositoryRoot: root)
            let modelAccessStatus = ProjectMarlinModelAccessStatusReader.status(
                repositoryRoot: root,
                pythonBinary: runtimeStatus.pythonBinary
            )

            await MainActor.run {
                self.marlinPreferenceDecision = preferenceDecision
                self.marlinEvaluationQueue = evaluationQueue
                self.marlinRepresentativePlan = representativePlan
                self.marlinRuntimeStatus = runtimeStatus
                self.marlinModelAccessStatus = modelAccessStatus
                self.updateMarlinEvaluationRunReadiness()
                if !self.userSelectedProject, let preferredReadyProjectID, self.selectedProjectID != preferredReadyProjectID {
                    self.selectProject(preferredReadyProjectID, userInitiated: false)
                }
                if let selectedProject = self.selectedProject {
                    self.studioGoalStatus = self.makeStudioGoalStatus(projectURL: selectedProject.path)
                }
            }
        }
    }

    nonisolated private static func preferredReadyProjectID(from projects: [ProjectSummary]) -> ProjectSummary.ID? {
        projects.first { project in
            guard project.hasTimeline else { return false }
            return ProjectMediaResolver.previewSummary(projectURL: project.path, assets: nil).isViewerVideoReady
        }?.id
    }

    private func updateMarlinEvaluationRunReadiness() {
        guard selectedProject != nil else {
            marlinEvaluationRunStatus = "プロジェクトが選択されていません。"
            return
        }
        guard marlinEvaluationRunPlan.canRun else {
            marlinEvaluationRunStatus = "Marlin評価はまだ実行できません: \(localizedStudioLabel(marlinEvaluationRunPlan.readinessLabel))。"
            return
        }
        marlinEvaluationRunStatus = marlinRuntimeStatus.isReadyForLiveMarlin
            ? (marlinModelAccessStatus.isReadyForLiveMarlin
                ? "Marlin評価を実行できます: \(marlinEvaluationRunPlan.sourceCount)件の素材。"
                : "Marlinモデルへまだアクセスできません: \(localizedStudioLabel(marlinModelAccessStatus.readinessLabel))。")
            : "Marlin実行環境はまだ準備できていません: \(localizedStudioLabel(marlinRuntimeStatus.readinessLabel))。"
    }

    private func makeStudioGoalStatus(projectURL: URL) -> ProjectStudioGoalStatus {
        ProjectStudioGoalStatusReader.status(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            marlinModelAccessStatus: marlinModelAccessStatus
        )
    }

    var marlinAuthReadinessLabel: String {
        marlinModelAccessStatus.readinessLabel
    }

    private static func marlinFailureStatus(prefix: String, exitCode: Int32? = nil, standardError: String) -> String {
        let trimmed = standardError.trimmingCharacters(in: .whitespacesAndNewlines)
        let exitLabel = exitCode.map { " with exit \($0)" } ?? ""
        let lowercased = trimmed.lowercased()
        if lowercased.contains("gated repo") || lowercased.contains("401 unauthorized") || lowercased.contains("hf_token") {
            return "\(prefix)\(exitLabel): gated Hugging Face model access. Accept NemoStation/Marlin-2B access and set HF_TOKEN in .env.local."
        }
        if trimmed.isEmpty {
            return "\(prefix)\(exitLabel): worker exited without stderr."
        }
        let summary = trimmed.split(separator: "\n").prefix(3).joined(separator: " ")
        return "\(prefix)\(exitLabel): \(summary)"
    }

    func chooseAndInitializeProject() {
        guard !isInitializingProject else { return }
        guard let projectID = promptForProjectID() else {
            projectInitializationStatus = "プロジェクト作成をキャンセルしました。"
            return
        }

        let panel = NSOpenPanel()
        panel.title = "素材フォルダを選択"
        panel.prompt = "素材をリンク"
        panel.message = "\(projectID) で使う映像・音声素材のフォルダを選んでください。02_media/source にリンクされます。"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.directoryURL = repositoryRoot
        panel.identifier = NSUserInterfaceItemIdentifier("ProjectInitializer.SourceFolderPanel")

        guard panel.runModal() == .OK, let sourceURL = panel.urls.first else {
            projectInitializationStatus = "素材フォルダの選択をキャンセルしました。"
            return
        }

        initializeProject(projectID: projectID, sourceDirectory: sourceURL)
    }

    private func promptForProjectID() -> String? {
        let alert = NSAlert()
        alert.messageText = "新規 Video OS プロジェクト"
        alert.informativeText = "半角英数字、ドット、アンダースコア、ハイフンで安定したプロジェクトIDを入力してください。"
        let createButton = alert.addButton(withTitle: "作成")
        createButton.setAccessibilityIdentifier("ProjectInitializer.CreateButton")
        let cancelButton = alert.addButton(withTitle: "キャンセル")
        cancelButton.setAccessibilityIdentifier("ProjectInitializer.CancelButton")

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = "client-cut-001"
        field.setAccessibilityIdentifier("ProjectInitializer.ProjectIDField")
        alert.accessoryView = field

        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    func initializeProject(projectID: String, sourceDirectory: URL?) {
        do {
            let plan = try ProjectInitializer.plan(
                repositoryRoot: repositoryRoot,
                projectID: projectID,
                sourceDirectory: sourceDirectory
            )
            isInitializingProject = true
            projectInitializationStatus = "\(plan.projectID) を作成しています..."

            Task.detached(priority: .userInitiated) {
                do {
                    let result = try ProjectInitializer.run(plan: plan)
                    await MainActor.run {
                        self.isInitializingProject = false
                        self.refresh()
                        self.selectProject(result.plan.projectID, userInitiated: false)
                        self.projectInitializationStatus = result.sourceLinkURL == nil
                            ? "\(result.plan.projectID) を作成しました。"
                            : "\(result.plan.projectID) を作成し、素材をリンクしました。"
                    }
                } catch {
                    await MainActor.run {
                        self.isInitializingProject = false
                        self.projectInitializationStatus = "プロジェクト作成に失敗しました: \(error)"
                    }
                }
            }
        } catch {
            projectInitializationStatus = "プロジェクト作成に失敗しました: \(error)"
        }
    }

    func loadTimelineForSelection() {
        guard let project = selectedProject else {
            feedbackSession.clearAll()
            feedbackSession.clearBaseline()
            feedbackSessionProjectID = nil
            pausePlayback()
            timeline = nil
            evidenceStore = nil
            candidateDataSource = nil
            isSwapBrowserPresented = false
            isFootageSearchPresented = false
            swapBrowserClip = nil
            sourceMonitorAssetID = nil
            mediaPreviewSummary = ProjectMediaPreviewSummary(items: [])
            mediaSourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            mediaProxyPlan = ProjectMediaProxyPlan(items: [])
            mediaProxyOperationStatus = "プロジェクトが選択されていません。"
            isBuildingMediaProxies = false
            mediaRelinkPlan = nil
            mediaRelinkStatus = "プロジェクトが選択されていません。"
            isRelinkingMedia = false
            syntheticMediaStatus = "プロジェクトが選択されていません。"
            isBuildingSyntheticMedia = false
            studioSyntheticSmokeStatus = "プロジェクトが選択されていません。"
            isRunningStudioSyntheticSmoke = false
            studioAcceptanceSmokeStatus = "プロジェクトが選択されていません。"
            isRunningStudioAcceptanceSmoke = false
            handoffExportPlan = nil
            handoffExportStatus = "プロジェクトが選択されていません。"
            isExportingPremiereXML = false
            editorPacketPlan = nil
            editorPacketStatus = "プロジェクトが選択されていません。"
            editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            isExportingEditorPacket = false
            renderPackageStatus = ProjectRenderPackageStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            renderRunPlan = ProjectRenderRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            renderRunStatus = "プロジェクトが選択されていません。"
            isRunningRender = false
            promoFinishStatus = ProjectPromoFinishStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            promoFinishRunPlan = ProjectPromoFinishRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            promoFinishRunStatus = "プロジェクトが選択されていません。"
            isRunningPromoFinish = false
            playbackContractStatus = ProjectPlaybackContractStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            timelinePreviewDiagnostics = .empty
            policyStatus = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: repositoryRoot)
            marlinEvaluationStatus = ProjectMarlinEvaluationStatusReader.status(projectURL: URL(fileURLWithPath: "/"), repositoryRoot: repositoryRoot)
            marlinEvaluationRunPlan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            marlinEvaluationRunStatus = "プロジェクトが選択されていません。"
            isRunningMarlinEvaluation = false
            audioStoryGraphRunPlan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            audioStoryGraphRunStatus = "プロジェクトが選択されていません。"
            isBuildingAudioStoryGraph = false
            editorAnnotations = nil
            editorAnnotationSummary = nil
            editorAnnotationStatus = "プロジェクトが選択されていません。"
            selectedClipNoteDraft = ""
            selectedClipHandoffInstructionDraft = ""
            intentSummary = ProjectIntentSummaryReader.summary(projectURL: URL(fileURLWithPath: "/"))
            intentAlignmentStatus = ProjectIntentAlignmentStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            reviewArtifactStatus = ProjectReviewArtifactStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            qaDashboard = nil
            libraryReadinessStatus = ProjectLibraryReadinessStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            pipelineGateStatus = ProjectPipelineGateStatusReader.status(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            studioReadinessStatus = ProjectStudioReadinessStatusReader.status(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            studioGoalStatus = makeStudioGoalStatus(projectURL: URL(fileURLWithPath: "/"))
            studioReadinessActionStatus = "プロジェクトが選択されていません。"
            planningStatus = ProjectPlanningStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            analysisRunPlan = ProjectAnalysisRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            analysisRunStatus = "プロジェクトが選択されていません。"
            isRunningAnalysis = false
            roughCutCompilePlan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            roughCutCompileStatus = "プロジェクトが選択されていません。"
            isCompilingRoughCut = false
            roughCutCompileActivity = .idle
            clearChangedClipHighlight()
            clearTimelineClipSelection()
            timelineAudioWaveforms = []
            audioWaveformStatus = "プロジェクトが選択されていません。"
            playbackSyncState = TimelinePlaybackSyncState(generation: mediaPlaybackSyncGeneration)
            audioPlaybackSyncState = TimelinePlaybackSyncState(generation: audioPlaybackSyncGeneration)
            mediaPlaybackSyncGeneration += 1
            audioPlaybackSyncGeneration += 1
            indexSearchResults = []
            indexContextPack = ProjectRAGContextPack(query: "", items: [])
            indexOperationStatus = "プロジェクトが選択されていません。"
            timelineStatus = "プロジェクトが選択されていません。"
            return
        }
        if feedbackSessionProjectID != project.id {
            feedbackSession.clearAll()
            feedbackSession.clearBaseline()
            clearChangedClipHighlight()
            feedbackSessionProjectID = project.id
        }
        feedbackSession.loadHistory(projectURL: project.path)
        evidenceStore = ProjectEvidenceStore.load(projectURL: project.path)
        loadCandidateDataSource(project: project)
        mediaPreviewSummary = ProjectMediaResolver.previewSummary(projectURL: project.path, assets: evidenceStore?.assets)
        if let sourceMonitorAssetID,
           !mediaPreviewSummary.items.contains(where: { $0.assetID == sourceMonitorAssetID && $0.playbackStatus.isReady }) {
            self.sourceMonitorAssetID = nil
        }
        analysisRunPlan = ProjectAnalysisRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
        analysisRunStatus = "素材解析の準備状況を確認しています..."
        refreshAnalysisRunPlan(projectID: project.id, projectURL: project.path)
        roughCutCompilePlan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: repositoryRoot, projectURL: project.path)
        roughCutCompileStatus = roughCutCompilePlan.canRun
            ? "timeline.jsonを生成できます。"
            : "粗編集の生成はまだ実行できません: \(localizedStudioLabel(roughCutCompilePlan.readinessLabel))。"
        mediaSourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: project.path, assets: evidenceStore?.assets)
        mediaProxyPlan = ProjectMediaProxyPlanner.plan(projectURL: project.path, assets: evidenceStore?.assets)
        mediaProxyOperationStatus = mediaProxyPlan.pendingCount > 0
            ? "\(mediaProxyPlan.pendingCount) 件のプレビュー素材を作成できます。"
            : "追加のプレビュー素材は不要です。"
        mediaRelinkPlan = nil
        mediaRelinkStatus = mediaPreviewSummary.missingCount > 0
            ? "\(mediaPreviewSummary.missingCount) 件の未リンク素材があります。"
            : "素材の再リンクは不要です。"
        syntheticMediaStatus = mediaPreviewSummary.missingCount > 0
            ? "QA用の仮素材を作成できます。"
            : "仮素材の作成は不要です。"
        handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: repositoryRoot, projectURL: project.path, assets: evidenceStore?.assets)
        handoffExportStatus = handoffExportPlan.map { localizedStudioLabel($0.readinessLabel) } ?? "Premiere XMLはまだ確認されていません。"
        editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: repositoryRoot, projectURL: project.path, assets: evidenceStore?.assets)
        editorPacketStatus = editorPacketPlan.map { localizedStudioLabel($0.readinessLabel) } ?? "編集者パケットはまだ確認されていません。"
        editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: project.path)
        renderPackageStatus = ProjectRenderPackageStatusReader.status(projectURL: project.path)
        renderRunPlan = ProjectRenderRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: project.path)
        renderRunStatus = renderRunPlan.canRun
            ? "最終動画を書き出せます。"
            : "書き出しはまだ実行できません: \(localizedStudioLabel(renderRunPlan.readinessLabel))。"
        promoFinishStatus = ProjectPromoFinishStatusReader.status(projectURL: project.path)
        promoFinishRunPlan = ProjectPromoFinishRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: project.path)
        promoFinishRunStatus = promoFinishRunPlan.canRun
            ? "宣材用のテロップ仕上げを実行できます。"
            : "テロップ仕上げはまだ実行できません: \(localizedStudioLabel(promoFinishRunPlan.readinessLabel))。"
        playbackContractStatus = ProjectPlaybackContractStatusReader.status(projectURL: project.path)
        timelinePreviewDiagnostics = ProjectTimelinePreviewDiagnosticsReader.status(projectURL: project.path)
        policyStatus = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: repositoryRoot)
        intentSummary = ProjectIntentSummaryReader.summary(projectURL: project.path)
        intentAlignmentStatus = ProjectIntentAlignmentStatusReader.status(projectURL: project.path)
        reviewArtifactStatus = ProjectReviewArtifactStatusReader.status(projectURL: project.path)
        qaDashboard = QADashboardDocument.load(projectURL: project.path)
        pipelineGateStatus = ProjectPipelineGateStatusReader.status(repositoryRoot: repositoryRoot, projectURL: project.path)
        studioReadinessStatus = ProjectStudioReadinessStatusReader.status(repositoryRoot: repositoryRoot, projectURL: project.path)
        studioGoalStatus = makeStudioGoalStatus(projectURL: project.path)
        studioReadinessActionStatus = "\(project.name) の準備状況を読み込みました。"
        marlinEvaluationStatus = ProjectMarlinEvaluationStatusReader.status(projectURL: project.path, repositoryRoot: repositoryRoot)
        marlinEvaluationRunPlan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: project.path, assets: evidenceStore?.assets)
        updateMarlinEvaluationRunReadiness()
        audioStoryGraphRunPlan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: project.path)
        audioStoryGraphRunStatus = audioStoryGraphRunPlan.canRun
            ? "文字起こし、BGM、音声イベントから音声ストーリーを構築できます。"
            : "音声ストーリーはまだ構築できません: \(localizedStudioLabel(audioStoryGraphRunPlan.readinessLabel))。"
        loadEditorAnnotations(project: project, timeline: nil)
        indexStatus = ProjectSQLiteIndex.status(projectURL: project.path)
        planningStatus = ProjectPlanningStatusReader.status(projectURL: project.path)
        refreshLibraryReadiness(projectURL: project.path)
        indexOperationStatus = indexStatus.exists
            ? "検索インデックス準備済み: \(indexStatus.documentCount) 件を検索できます。"
            : "素材検索とRAG用にSQLiteインデックスを作成してください。"
        guard project.hasTimeline else {
            feedbackSession.clearBaseline()
            pausePlayback()
            timeline = nil
            clearTimelineClipSelection()
            timelineAudioWaveforms = []
            audioWaveformStatus = "波形表示には先に粗編集の生成が必要です。"
            setPlayheadFrame(0, forceSeek: true)
            timelineStatus = "粗編集を生成して 05_timeline/timeline.json を作成してください。"
            return
        }

        do {
            timeline = try TimelineDocument.load(projectURL: project.path)
            if let timeline {
                if !feedbackSession.isDirty {
                    feedbackSession.captureBaseline(from: timeline)
                }
                timelineStatus = "\(timeline.sequence.name) / \(timeline.displayTracks.count) トラック / \(formatSeconds(timeline.totalSeconds))"
                reconcileTimelineClipSelection(with: timeline)
                loadEditorAnnotations(project: project, timeline: timeline)
                setPlayheadFrame(min(playheadFrame, timeline.totalFrames), forceSeek: true)
                loadAudioWaveforms(project: project, timeline: timeline)
            }
        } catch {
            feedbackSession.clearBaseline()
            pausePlayback()
            timeline = nil
            clearTimelineClipSelection()
            timelineAudioWaveforms = []
            audioWaveformStatus = "波形を表示できません: timeline.jsonの読み込みに失敗しました。"
            setPlayheadFrame(0, forceSeek: true)
            timelineStatus = "timeline.jsonを読み込めませんでした: \(error.localizedDescription)"
        }
    }

    private func refreshAnalysisRunPlan(
        projectID: ProjectSummary.ID,
        projectURL: URL,
        runAfterRefresh: Bool = false
    ) {
        let root = repositoryRoot
        let options = ProjectAnalysisRunOptions.speechLedHighlightDefaults
        Task.detached(priority: .utility) {
            let plan = ProjectAnalysisRunPlanner.plan(repositoryRoot: root, projectURL: projectURL, options: options)
            await MainActor.run {
                guard self.selectedProjectID == projectID else { return }
                self.analysisRunPlan = plan
                if runAfterRefresh {
                    self.startProjectAnalysis(plan: plan, projectID: projectID, projectURL: projectURL)
                    return
                }
                self.analysisRunStatus = plan.canRun
                    ? "リンク済み素材 \(plan.sourceCount) 件をローカル解析できます。"
                    : "素材解析はまだ実行できません: \(localizedStudioLabel(plan.readinessLabel))。"
            }
        }
    }

    private func loadAudioWaveforms(project: ProjectSummary, timeline: TimelineDocument) {
        let projectURL = project.path
        let assets = evidenceStore?.assets
        timelineAudioWaveforms = []
        audioWaveformStatus = "音声波形を読み込んでいます..."

        Task.detached(priority: .userInitiated) {
            let map = ProjectAudioWaveformMap.build(projectURL: projectURL, timeline: timeline, assets: assets)
            await MainActor.run {
                self.timelineAudioWaveforms = map.waveforms
                self.audioWaveformStatus = map.waveforms.isEmpty
                    ? "読み取れる音声波形がありません。"
                    : "\(map.waveforms.count) 本の波形レーンを読み込みました。"
            }
        }
    }

    private func formatSeconds(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        let minutes = total / 60
        let remainder = total % 60
        return "\(minutes)m \(String(format: "%02d", remainder))s"
    }

    private func formatMicrosecondClock(_ microseconds: Int) -> String {
        let total = max(0, Int((Double(microseconds) / 1_000_000).rounded(.down)))
        let minutes = total / 60
        let remainder = total % 60
        return "\(minutes):\(String(format: "%02d", remainder))"
    }

    func selectTimelineClip(_ clipID: TimelineClip.ID) {
        selectTimelineClip(clipID, extendingSelection: isTimelineMultiSelectMode)
    }

    func beginTimelineClipBodyDrag(_ clipID: TimelineClip.ID) {
        guard timeline?.clipSelection(for: clipID) != nil else { return }
        clearSourceMonitorAsset(updateStatus: false)
        setTimelineTransitionSelection(nil)
        timelineTransitionDurationPreview = nil
        timelineDragTrimViewerPreview = nil
        timelineRollTrimViewerPreview = nil
        timelineSlipTrimViewerPreview = nil
        timelineSkimPreview = nil
        sourceBinSkimPreview = nil
        if !activeSelectedTimelineClipIDs().contains(clipID) {
            setTimelineClipSelection(primary: clipID, ids: [clipID])
        } else if selectedTimelineClipID != clipID {
            setTimelineClipSelection(primary: clipID, ids: activeSelectedTimelineClipIDs())
        }
    }

    func selectTimelineClip(_ clipID: TimelineClip.ID, extendingSelection: Bool) {
        guard timeline?.clipSelection(for: clipID) != nil else {
            setTimelineClipSelection(primary: nil, ids: [])
            return
        }

        clearSourceMonitorAsset(updateStatus: true)

        if extendingSelection {
            var ids = activeSelectedTimelineClipIDs()
            if ids.contains(clipID), ids.count > 1 {
                ids.remove(clipID)
            } else {
                ids.insert(clipID)
            }
            let primary = ids.contains(clipID)
                ? clipID
                : orderedTimelineClipIDs(in: ids).first
            setTimelineClipSelection(primary: primary, ids: ids)
        } else {
            setTimelineClipSelection(primary: clipID, ids: [clipID])
        }

        if let clip = timeline?.clipSelection(for: selectedTimelineClipID)?.clip {
            setPlayheadFrame(clip.timelineInFrame, forceSeek: true)
        }
    }

    func selectTimelineClips(in trackID: TimelineTrack.ID, frameRange: ClosedRange<Int>) {
        guard let timeline else {
            roughCutCompileStatus = "範囲選択する前にタイムラインを生成してください。"
            return
        }

        let selectedIDs = timeline.clipIDs(inTrack: trackID, intersectingFrameRange: frameRange)
        guard !selectedIDs.isEmpty else {
            roughCutCompileStatus = "\(trackID) の選択範囲内にクリップがありません。"
            return
        }

        clearSourceMonitorAsset(updateStatus: false)
        setTimelineTransitionSelection(nil)
        let primaryID = selectedIDs[0]
        setTimelineClipSelection(primary: primaryID, ids: Set(selectedIDs))
        setPlayheadFrame(max(0, min(frameRange.lowerBound, frameRange.upperBound)), forceSeek: true)

        let startTimecode = timeline.sequence.framesToTimecode(max(0, min(frameRange.lowerBound, frameRange.upperBound)))
        let endTimecode = timeline.sequence.framesToTimecode(max(0, max(frameRange.lowerBound, frameRange.upperBound)))
        roughCutCompileStatus = "\(trackID) の \(selectedIDs.count)件を範囲選択しました（\(startTimecode)-\(endTimecode)）。"
    }

    func selectPreviousTimelineClip() {
        selectTimelineClipByKeyboard(direction: .previous, extendingSelection: false)
    }

    func selectNextTimelineClip() {
        selectTimelineClipByKeyboard(direction: .next, extendingSelection: false)
    }

    func extendTimelineSelectionPrevious() {
        selectTimelineClipByKeyboard(direction: .previous, extendingSelection: true)
    }

    func extendTimelineSelectionNext() {
        selectTimelineClipByKeyboard(direction: .next, extendingSelection: true)
    }

    private func selectTimelineClipByKeyboard(
        direction: TimelineClipSelectionNavigationDirection,
        extendingSelection: Bool
    ) {
        guard let timeline else {
            roughCutCompileStatus = "クリップ選択を移動する前にタイムラインを生成してください。"
            return
        }
        guard let plan = TimelineClipSelectionNavigationPlan.make(
            timeline: timeline,
            currentPrimaryClipID: selectedTimelineClipID,
            currentSelectedClipIDs: selectedTimelineClipIDs,
            playheadFrame: playheadFrame,
            direction: direction,
            extendingSelection: extendingSelection
        ) else {
            let directionLabel = direction == .next ? "次" : "前"
            roughCutCompileStatus = "\(directionLabel)に選択できるクリップがありません。"
            return
        }

        clearSourceMonitorAsset(updateStatus: false)
        setTimelineTransitionSelection(nil)
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        timelineDragTrimViewerPreview = nil
        timelineRollTrimViewerPreview = nil
        timelineSlipTrimViewerPreview = nil
        timelineSkimPreview = nil
        sourceBinSkimPreview = nil
        if extendingSelection {
            isTimelineMultiSelectMode = true
            isTimelineBladeModeEnabled = false
        }
        setTimelineClipSelection(primary: plan.primaryClipID, ids: plan.selectedClipIDs)
        setPlayheadFrame(plan.playheadFrame, forceSeek: true)
        requestTimelinePlayheadReveal()
        roughCutCompileStatus = plan.statusMessage
    }

    func selectAllTimelineClips() {
        guard let timeline else {
            roughCutCompileStatus = "全選択する前にタイムラインを生成してください。"
            return
        }

        let clipIDs = timeline.displayTracks.flatMap { track in
            track.clips
                .sorted {
                    if $0.timelineInFrame == $1.timelineInFrame { return $0.id < $1.id }
                    return $0.timelineInFrame < $1.timelineInFrame
                }
                .map(\.id)
        }
        guard let primaryID = clipIDs.first else {
            roughCutCompileStatus = "選択できるクリップがありません。"
            return
        }

        clearSourceMonitorAsset(updateStatus: false)
        isTimelineBladeModeEnabled = false
        isTimelineMultiSelectMode = true
        setTimelineTransitionSelection(nil)
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        timelineDragTrimViewerPreview = nil
        timelineRollTrimViewerPreview = nil
        timelineSlipTrimViewerPreview = nil
        setTimelineClipSelection(primary: primaryID, ids: Set(clipIDs))
        if let firstClip = timeline.clipSelection(for: primaryID)?.clip {
            setPlayheadFrame(firstClip.timelineInFrame, forceSeek: true)
        }
        roughCutCompileStatus = "タイムラインの \(clipIDs.count)件を全選択しました。Escで解除できます。"
    }

    func clearTimelineSelectionAndTemporaryTools() {
        let hadTransientPreview = timelineTransitionDurationPreview != nil
            || timelineClipMoveViewerPreview != nil
            || timelineDragTrimViewerPreview != nil
            || timelineRollTrimViewerPreview != nil
            || timelineSlipTrimViewerPreview != nil
            || timelineSkimPreview != nil
            || sourceBinSkimPreview != nil
        guard hasTimelineSelectionOrTemporaryTool else {
            roughCutCompileStatus = "解除するタイムライン選択はありません。"
            return
        }

        isTimelineBladeModeEnabled = false
        isTimelineMultiSelectMode = false
        setTimelineTransitionSelection(nil)
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        timelineDragTrimViewerPreview = nil
        timelineRollTrimViewerPreview = nil
        timelineSlipTrimViewerPreview = nil
        timelineSkimPreview = nil
        sourceBinSkimPreview = nil
        setTimelineClipSelection(primary: nil, ids: [])
        if hadTransientPreview {
            mediaPlaybackSyncGeneration += 1
            audioPlaybackSyncGeneration += 1
        }
        roughCutCompileStatus = "タイムライン選択と一時ツールを解除しました。"
    }

    func toggleTimelineMultiSelectMode() {
        isTimelineMultiSelectMode.toggle()
        if isTimelineMultiSelectMode {
            isTimelineBladeModeEnabled = false
            roughCutCompileStatus = "複数選択モードをオンにしました。クリップをクリックすると選択に追加/解除できます。"
            return
        }

        if selectedTimelineClipIDs.count > 1,
           let primary = selectedTimelineClipID ?? orderedTimelineClipIDs(in: selectedTimelineClipIDs).first {
            setTimelineClipSelection(primary: primary, ids: [primary])
            roughCutCompileStatus = "複数選択モードをオフにしました。選択は主クリップだけに戻しました。"
        } else {
            roughCutCompileStatus = "複数選択モードをオフにしました。次のクリックは単一選択になります。"
        }
    }

    func toggleTimelineBladeMode() {
        isTimelineBladeModeEnabled.toggle()
        if isTimelineBladeModeEnabled {
            isTimelineMultiSelectMode = false
            if selectedTimelineClipIDs.count > 1,
               let primary = selectedTimelineClipID ?? orderedTimelineClipIDs(in: selectedTimelineClipIDs).first {
                setTimelineClipSelection(primary: primary, ids: [primary])
            }
            roughCutCompileStatus = "ブレードをオンにしました。タイムライン上のクリップをクリックするとその位置で分割します。"
        } else {
            roughCutCompileStatus = "ブレードをオフにしました。クリップクリックは選択に戻ります。"
        }
    }

    func approveSelectedTimelineClip() {
        let clipIDs = orderedTimelineClipIDs(in: activeSelectedTimelineClipIDs())
        guard !clipIDs.isEmpty else {
            roughCutCompileStatus = "承認する前にタイムラインのクリップを選択してください。"
            return
        }
        feedbackSession.approveClips(clipIDs)
        if clipIDs.count == 1, let clipID = clipIDs.first {
            roughCutCompileStatus = "\(clipID) を承認しました。"
        } else {
            roughCutCompileStatus = "\(clipIDs.count)件のクリップを承認しました。"
        }
    }

    func rejectSelectedTimelineClip() {
        let clipIDs = orderedTimelineClipIDs(in: activeSelectedTimelineClipIDs())
        guard !clipIDs.isEmpty else {
            roughCutCompileStatus = "却下する前にタイムラインのクリップを選択してください。"
            return
        }
        feedbackSession.rejectClips(clipIDs, reason: "Rejected by operator")
        if clipIDs.count == 1, let clipID = clipIDs.first {
            roughCutCompileStatus = "\(clipID) を却下しました。"
        } else {
            roughCutCompileStatus = "\(clipIDs.count)件のクリップを却下として保留しました。"
        }
    }

    private func setTimelineClipSelection(primary: TimelineClip.ID?, ids: Set<TimelineClip.ID>) {
        guard TimelineClipSelectionPublishing.shouldPublish(
            currentPrimaryID: selectedTimelineClipID,
            currentSelectedIDs: selectedTimelineClipIDs,
            nextPrimaryID: primary,
            nextSelectedIDs: ids
        ) else { return }

        isUpdatingTimelineClipSelection = true
        selectedTimelineClipIDs = ids
        selectedTimelineClipID = primary
        isUpdatingTimelineClipSelection = false
        loadSelectedClipNoteDraft()
        publishAgentMenuCommandAvailability()
    }

    private func clearTimelineClipSelection() {
        setTimelineClipSelection(
            primary: nil,
            ids: TimelineClipSelectionPublishing.clearedSelectionIDs()
        )
    }

    private func setTimelineTransitionSelection(_ transitionID: TimelineTransition.ID?) {
        guard TimelineTransitionSelectionPublishing.shouldPublish(
            previous: selectedTimelineTransitionID,
            next: transitionID
        ) else { return }

        selectedTimelineTransitionID = transitionID
    }

    private func activeSelectedTimelineClipIDs() -> Set<TimelineClip.ID> {
        if !selectedTimelineClipIDs.isEmpty {
            return selectedTimelineClipIDs
        }
        return selectedTimelineClipID.map { [$0] } ?? []
    }

    private func orderedTimelineClipIDs(in ids: Set<TimelineClip.ID>) -> [TimelineClip.ID] {
        guard let timeline else { return ids.sorted() }
        var ordered: [TimelineClip.ID] = []
        for track in timeline.displayTracks {
            for clip in track.clips.sorted(by: { lhs, rhs in
                if lhs.timelineInFrame == rhs.timelineInFrame { return lhs.id < rhs.id }
                return lhs.timelineInFrame < rhs.timelineInFrame
            }) where ids.contains(clip.id) {
                ordered.append(clip.id)
            }
        }
        return ordered
    }

    private func reconcileTimelineClipSelection(with timeline: TimelineDocument) {
        let validIDs = activeSelectedTimelineClipIDs().filter { timeline.clipSelection(for: $0) != nil }
        let primary = selectedTimelineClipID.flatMap { validIDs.contains($0) ? $0 : nil }
            ?? orderedTimelineClipIDs(in: validIDs).first
        setTimelineClipSelection(primary: primary, ids: validIDs)
    }

    func trimSelectedTimelineClipStart() {
        trimSelectedTimelineClip(edge: .start, seconds: 0.5)
    }

    func trimSelectedTimelineClipEnd() {
        trimSelectedTimelineClip(edge: .end, seconds: 0.5)
    }

    func trimSelectedTimelineClipStartToPlayhead() {
        trimSelectedTimelineClipToPlayhead(edge: .start)
    }

    func trimSelectedTimelineClipEndToPlayhead() {
        trimSelectedTimelineClipToPlayhead(edge: .end)
    }

    func rollSelectedIncomingEditLeft() {
        rollSelectedTimelineEdit(boundary: .incoming, direction: .left)
    }

    func rollSelectedIncomingEditRight() {
        rollSelectedTimelineEdit(boundary: .incoming, direction: .right)
    }

    func rollSelectedOutgoingEditLeft() {
        rollSelectedTimelineEdit(boundary: .outgoing, direction: .left)
    }

    func rollSelectedOutgoingEditRight() {
        rollSelectedTimelineEdit(boundary: .outgoing, direction: .right)
    }

    func extendSelectedTimelineClipStart() {
        extendSelectedTimelineClip(edge: .start)
    }

    func extendSelectedTimelineClipEnd() {
        extendSelectedTimelineClip(edge: .end)
    }

    func slipSelectedTimelineClipLeft() {
        slipSelectedTimelineClip(direction: .left)
    }

    func slipSelectedTimelineClipRight() {
        slipSelectedTimelineClip(direction: .right)
    }

    func nudgeSelectedTimelineClipEarlier() {
        nudgeSelectedTimelineClip(direction: .earlier)
    }

    func nudgeSelectedTimelineClipLater() {
        nudgeSelectedTimelineClip(direction: .later)
    }

    func previewTimelineDragTrim(
        _ clipID: TimelineClip.ID,
        edge: TimelinePlayheadTrimEdge,
        frameDelta: Int,
        snapThresholdFrames: Int
    ) {
        guard let timeline, let selection = timeline.clipSelection(for: clipID), frameDelta != 0 else {
            clearTimelineDragTrimPreview()
            return
        }
        guard !feedbackSession.hasPendingRemove(for: clipID) else {
            clearTimelineDragTrimPreview()
            return
        }

        let targetBoundaryFrame: Int
        switch edge {
        case .start:
            targetBoundaryFrame = selection.clip.timelineInFrame + frameDelta
        case .end:
            targetBoundaryFrame = selection.clip.timelineOutFrame + frameDelta
        }

        guard let plan = TimelineDragTrimPlan.make(
            timeline: timeline,
            selection: selection,
            targetBoundaryFrame: targetBoundaryFrame,
            edge: edge,
            snapThresholdFrames: snapThresholdFrames,
            playheadFrame: playheadFrame,
            assetDurationUS: assetDurationsUSByID[selection.clip.assetID],
            reason: "Studio timeline drag trim viewer preview"
        ) else {
            clearTimelineDragTrimPreview()
            return
        }

        let previewTimeline = timeline.applyingTimelineTrimOperations(plan.operations)
        let previewFrame = min(max(plan.viewerPreviewFrame, 0), previewTimeline.totalFrames)
        let preview = TimelineDragTrimViewerPreview(
            clipID: plan.targetClipID,
            timeline: previewTimeline,
            previewFrame: previewFrame,
            edge: edge,
            snap: plan.snap
        )
        guard preview != timelineDragTrimViewerPreview else { return }

        sourceMonitorAssetID = nil
        setTimelineTransitionSelection(nil)
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        timelineRollTrimViewerPreview = nil
        timelineSkimPreview = nil
        sourceBinSkimPreview = nil
        timelineDragTrimViewerPreview = preview
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let edgeLabel = edge == .start ? "IN" : "OUT"
        let snapText = plan.snap.map { " / 吸着 \($0.label)" } ?? ""
        roughCutCompileStatus = "\(plan.targetClipID) の\(edgeLabel)ドラッグトリムをViewerでプレビュー中です: \(previewTimeline.sequence.framesToTimecode(previewFrame))\(snapText)。離すと適用します。"
    }

    func clearTimelineDragTrimPreview() {
        guard timelineDragTrimViewerPreview != nil else { return }
        timelineDragTrimViewerPreview = nil
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
    }

    func previewTimelineRollTrim(
        _ clipID: TimelineClip.ID,
        boundary: TimelineRollTrimBoundary,
        frameDelta: Int
    ) {
        guard let timeline,
              !hasMultipleTimelineClipSelection,
              let selection = timeline.clipSelection(for: clipID),
              let roll = rollDirectionAndFrameCount(for: frameDelta)
        else {
            clearTimelineRollTrimPreview()
            return
        }
        guard let plan = makeRollTrimPlan(
            selection: selection,
            boundary: boundary,
            direction: roll.direction,
            deltaFrames: roll.frames,
            reason: "Studio timeline drag roll viewer preview"
        ) else {
            clearTimelineRollTrimPreview()
            return
        }

        let previewTimeline = timeline.applyingTimelineTrimOperations(plan.operations)
        let preview = TimelineRollTrimViewerPreview(
            clipID: clipID,
            timeline: previewTimeline,
            previewFrame: min(max(plan.newBoundaryFrame, 0), previewTimeline.totalFrames),
            boundary: boundary,
            direction: roll.direction,
            shiftFrames: plan.shiftFrames
        )
        guard preview != timelineRollTrimViewerPreview else { return }

        sourceMonitorAssetID = nil
        setTimelineTransitionSelection(nil)
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        timelineDragTrimViewerPreview = nil
        timelineSlipTrimViewerPreview = nil
        timelineSkimPreview = nil
        sourceBinSkimPreview = nil
        timelineRollTrimViewerPreview = preview
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let boundaryLabel = boundary == .incoming ? "前編集点" : "次編集点"
        let directionLabel = roll.direction == .left ? "左" : "右"
        let shiftText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.shiftFrames))
        roughCutCompileStatus = "\(plan.leftClipID) / \(plan.rightClipID) の\(boundaryLabel)をドラッグで\(directionLabel)へ \(shiftText) ロールプレビュー中です。離すと適用します。"
    }

    func clearTimelineRollTrimPreview() {
        guard timelineRollTrimViewerPreview != nil else { return }
        timelineRollTrimViewerPreview = nil
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
    }

    func dragRollTimelineEdit(
        _ clipID: TimelineClip.ID,
        boundary: TimelineRollTrimBoundary,
        frameDelta: Int
    ) {
        clearTimelineRollTrimPreview()
        guard let timeline,
              !hasMultipleTimelineClipSelection,
              let selection = timeline.clipSelection(for: clipID),
              let roll = rollDirectionAndFrameCount(for: frameDelta)
        else {
            roughCutCompileStatus = "ロールトリムする前にタイムラインのクリップを1件選択してください。"
            return
        }
        guard let plan = makeRollTrimPlan(
            selection: selection,
            boundary: boundary,
            direction: roll.direction,
            deltaFrames: roll.frames,
            reason: "Studio timeline drag roll edit"
        ) else {
            roughCutCompileStatus = "\(selection.clip.id) はこの方向へロールトリムできません。隣接クリップ、素材尺、削除保留状態を確認してください。"
            return
        }

        setTimelineClipSelection(primary: clipID, ids: [clipID])
        queueAndApplyTimelineTrimOperations(plan.operations, to: timeline)

        let boundaryLabel = boundary == .incoming ? "前の編集点" : "次の編集点"
        let directionLabel = roll.direction == .left ? "左" : "右"
        let shiftText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.shiftFrames))
        roughCutCompileStatus = "\(plan.leftClipID) / \(plan.rightClipID) の\(boundaryLabel)をドラッグで\(directionLabel)へ \(shiftText) ロールし、タイムラインとViewerに反映しました。"
    }

    func previewTimelineSlipTrim(_ clipID: TimelineClip.ID, frameDelta: Int) {
        guard let timeline,
              !hasMultipleTimelineClipSelection,
              let selection = timeline.clipSelection(for: clipID),
              let slip = slipDirectionAndFrameCount(for: frameDelta)
        else {
            clearTimelineSlipTrimPreview()
            return
        }
        guard !feedbackSession.hasPendingRemove(for: clipID) else {
            clearTimelineSlipTrimPreview()
            return
        }
        guard let plan = makeSlipTrimPlan(
            selection: selection,
            direction: slip.direction,
            deltaFrames: slip.frames,
            reason: "Studio timeline drag slip viewer preview"
        ) else {
            clearTimelineSlipTrimPreview()
            return
        }

        let previewTimeline = timeline.applyingTimelineTrimOperations(plan.operations)
        let preferredFrame = selection.clip.containsTimelineFrame(playheadFrame)
            ? playheadFrame
            : selection.clip.timelineInFrame
        let preview = TimelineSlipTrimViewerPreview(
            clipID: plan.clipID,
            timeline: previewTimeline,
            previewFrame: min(max(preferredFrame, 0), previewTimeline.totalFrames),
            direction: slip.direction,
            shiftFrames: plan.shiftFrames
        )
        guard preview != timelineSlipTrimViewerPreview else { return }

        sourceMonitorAssetID = nil
        setTimelineTransitionSelection(nil)
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        timelineDragTrimViewerPreview = nil
        timelineRollTrimViewerPreview = nil
        timelineSkimPreview = nil
        sourceBinSkimPreview = nil
        timelineSlipTrimViewerPreview = preview
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let directionLabel = slip.direction == .left ? "前" : "後ろ"
        let shiftText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.shiftFrames))
        let rangeText = "\(formatMicrosecondClock(plan.newSourceInUS))-\(formatMicrosecondClock(plan.newSourceOutUS))"
        roughCutCompileStatus = "\(plan.clipID) の素材範囲をドラッグで\(directionLabel)へ \(shiftText) スリッププレビュー中です。Viewer: \(rangeText)。離すと適用します。"
    }

    func clearTimelineSlipTrimPreview() {
        guard timelineSlipTrimViewerPreview != nil else { return }
        timelineSlipTrimViewerPreview = nil
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
    }

    func dragSlipTimelineClip(_ clipID: TimelineClip.ID, frameDelta: Int) {
        clearTimelineSlipTrimPreview()
        guard let timeline,
              !hasMultipleTimelineClipSelection,
              let selection = timeline.clipSelection(for: clipID),
              let slip = slipDirectionAndFrameCount(for: frameDelta)
        else {
            roughCutCompileStatus = "スリップする前にタイムラインのクリップを1件選択してください。"
            return
        }
        guard !feedbackSession.hasPendingRemove(for: clipID) else {
            roughCutCompileStatus = "\(clipID) は削除保留中のためスリップできません。"
            return
        }
        guard let plan = makeSlipTrimPlan(
            selection: selection,
            direction: slip.direction,
            deltaFrames: slip.frames,
            reason: "Studio timeline drag slip"
        ) else {
            roughCutCompileStatus = "\(selection.clip.id) はこの方向へスリップできません。素材の前後余白と素材尺を確認してください。"
            return
        }

        setTimelineClipSelection(primary: clipID, ids: [clipID])
        queueAndApplyTimelineTrimOperations(plan.operations, to: timeline)

        let directionLabel = slip.direction == .left ? "前" : "後ろ"
        let shiftText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.shiftFrames))
        let rangeText = "\(formatMicrosecondClock(plan.newSourceInUS))-\(formatMicrosecondClock(plan.newSourceOutUS))"
        roughCutCompileStatus = "\(plan.clipID) の素材範囲をドラッグで\(directionLabel)へ \(shiftText) スリップし、Viewerに反映しました。範囲: \(rangeText)。タイムライン上の位置と尺は変わりません。"
    }

    func dragTrimTimelineClip(
        _ clipID: TimelineClip.ID,
        edge: TimelinePlayheadTrimEdge,
        frameDelta: Int,
        snapThresholdFrames: Int
    ) {
        clearTimelineDragTrimPreview()
        guard let timeline, let selection = timeline.clipSelection(for: clipID) else {
            roughCutCompileStatus = "ドラッグトリムする前にタイムラインのクリップを選択してください。"
            return
        }
        guard !feedbackSession.hasPendingRemove(for: clipID) else {
            roughCutCompileStatus = "\(clipID) は削除保留中のためドラッグトリムできません。"
            return
        }
        guard frameDelta != 0 else { return }

        let targetBoundaryFrame: Int
        switch edge {
        case .start:
            targetBoundaryFrame = selection.clip.timelineInFrame + frameDelta
        case .end:
            targetBoundaryFrame = selection.clip.timelineOutFrame + frameDelta
        }

        guard let plan = TimelineDragTrimPlan.make(
            timeline: timeline,
            selection: selection,
            targetBoundaryFrame: targetBoundaryFrame,
            edge: edge,
            snapThresholdFrames: snapThresholdFrames,
            playheadFrame: playheadFrame,
            assetDurationUS: assetDurationsUSByID[selection.clip.assetID],
            reason: "Studio timeline drag trim \(edge == .start ? "start" : "end")"
        ) else {
            roughCutCompileStatus = "\(selection.clip.id) はこの位置までドラッグトリムできません。クリップの内側で1フレーム以上残し、延長時は前後の空きと素材の余白を確認してください。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        setTimelineClipSelection(primary: clipID, ids: [clipID])
        for operation in plan.operations {
            feedbackSession.addOp(operation)
        }
        let updatedTimeline = timeline.applyingTimelineTrimOperations(plan.operations)
        self.timeline = updatedTimeline
        reconcileTimelineClipSelection(with: updatedTimeline)
        setPlayheadFrame(min(playheadFrame, updatedTimeline.totalFrames), forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let edgeLabel = edge == .start ? "先頭" : "末尾"
        let actionLabel = plan.isExtension ? "伸ばし" : "詰め"
        let deltaText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.changedFrames))
        let snapText = plan.snap.map { "（\($0.label)に吸着）" } ?? ""
        roughCutCompileStatus = "\(selection.clip.id) の\(edgeLabel)をドラッグで \(deltaText) \(actionLabel)、タイムラインとプレビューに反映しました。\(snapText)"
    }

    func dragMoveTimelineClip(
        _ clipID: TimelineClip.ID,
        frameDelta: Int,
        snapThresholdFrames: Int,
        targetTrackID: TimelineTrack.ID? = nil
    ) {
        timelineClipMoveViewerPreview = nil
        timelineRollTrimViewerPreview = nil
        timelineSlipTrimViewerPreview = nil
        guard let timeline, let selection = timeline.clipSelection(for: clipID) else {
            roughCutCompileStatus = "ドラッグ移動する前にタイムラインのクリップを選択してください。"
            return
        }
        let selectedMoveIDs = activeSelectedTimelineClipIDs()
        let shouldMoveSelectedGroup = selectedMoveIDs.contains(clipID) && selectedMoveIDs.count > 1
        let pendingMoveIDs = shouldMoveSelectedGroup ? selectedMoveIDs : [clipID]
        if let pendingRemoveClipID = pendingMoveIDs.first(where: { feedbackSession.hasPendingRemove(for: $0) }) {
            roughCutCompileStatus = "\(pendingRemoveClipID) は削除保留中のためドラッグ移動できません。"
            return
        }
        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        if shouldMoveSelectedGroup {
            guard let plan = TimelineClipGroupMovePlan.make(
                timeline: timeline,
                anchorSelection: selection,
                selectedClipIDs: selectedMoveIDs,
                frameDelta: frameDelta,
                snapThresholdFrames: snapThresholdFrames,
                playheadFrame: playheadFrame,
                reason: "Studio timeline magnetic group drag move",
                preferredTargetTrackID: targetTrackID
            ) else {
                roughCutCompileStatus = "選択中のクリップはその位置へまとめて移動できません。左右へ動かすか、同じ種類の空いているトラックへドラッグしてください。"
                return
            }

            setTimelineClipSelection(primary: clipID, ids: Set(plan.movedClipIDs))
            for operation in plan.operations {
                feedbackSession.addOp(operation)
            }
            let updatedTimeline = timeline.applyingTimelineMoveOperations(plan.operations)
            self.timeline = updatedTimeline
            reconcileTimelineClipSelection(with: updatedTimeline)
            setPlayheadFrame(min(playheadFrame, updatedTimeline.totalFrames), forceSeek: true)
            mediaPlaybackSyncGeneration += 1
            audioPlaybackSyncGeneration += 1

            let shiftText = String(format: "%.1f秒", abs(timeline.sequence.framesToSeconds(plan.resolvedFrameDelta)))
            let directionText: String
            if plan.resolvedFrameDelta == 0 {
                directionText = "タイミングはそのまま"
            } else {
                directionText = "\(shiftText) \(plan.resolvedFrameDelta < 0 ? "前" : "後ろ")"
            }
            let snapText = plan.snap.map { " 吸着: \($0.label)" } ?? ""
            let laneLiftText = plan.laneLift.map {
                $0.createsTrack
                    ? " 重なりを避けて \($0.targetTrackID) を作り、そこへまとめてリフトしました。"
                    : " 重なりを避けて \($0.targetTrackID) へまとめてリフトしました。"
            } ?? ""
            let targetTrackText = plan.laneLift == nil
                ? (plan.targetTrackID.map { " \($0) へまとめて移動しました。" } ?? "")
                : ""
            let displacementText = plan.displacements.isEmpty
                ? ""
                : " 重なった \(plan.displacements.count) 件を後ろへ送っています。"
            roughCutCompileStatus = "選択中の \(plan.movedClipIDs.count) クリップをドラッグで移動しました。\(directionText)。\(targetTrackText)\(laneLiftText)\(snapText)\(displacementText)"
            return
        }
        guard let plan = TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: frameDelta,
            snapThresholdFrames: snapThresholdFrames,
            playheadFrame: playheadFrame,
            reason: "Studio timeline magnetic drag move",
            preferredTargetTrackID: targetTrackID
        ) else {
            roughCutCompileStatus = "\(selection.clip.id) はその位置へ移動できません。クリップ本体を左右または互換トラックへドラッグしてください。"
            return
        }

        setTimelineClipSelection(primary: clipID, ids: [clipID])
        for operation in plan.operations {
            feedbackSession.addOp(operation)
        }
        let updatedTimeline = timeline.applyingTimelineMoveOperations(plan.operations)
        self.timeline = updatedTimeline
        reconcileTimelineClipSelection(with: updatedTimeline)
        setPlayheadFrame(min(playheadFrame, updatedTimeline.totalFrames), forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let shiftFrames = plan.newTimelineInFrame - plan.originalTimelineInFrame
        let shiftText = String(format: "%.1f秒", abs(timeline.sequence.framesToSeconds(shiftFrames)))
        let directionText = shiftFrames < 0 ? "前" : "後ろ"
        let snapText = plan.snap.map { " 吸着: \($0.label)" } ?? ""
        let laneLiftText = plan.laneLift.map {
            $0.createsTrack
                ? " 重なりを避けて \($0.targetTrackID) を作り、そこへリフトしました。"
                : " 重なりを避けて \($0.targetTrackID) へリフトしました。"
        } ?? ""
        let displacementText = plan.displacements.isEmpty
            ? ""
            : " 重なった \(plan.displacements.count) 件を後ろへ送っています。"
        if plan.laneLift == nil, plan.targetTrackID != selection.trackID {
            let timingText = shiftFrames == 0
                ? "タイミングはそのままです。"
                : "\(shiftText) \(directionText)へも移動しています。"
            roughCutCompileStatus = "\(plan.targetClipID) をドラッグで \(plan.targetTrackID) へ移動しました。\(timingText)\(snapText)\(displacementText)"
        } else {
            roughCutCompileStatus = "\(plan.targetClipID) をドラッグで \(shiftText) \(directionText)へ移動しました。\(snapText)\(laneLiftText)\(displacementText)"
        }
    }

    func previewTimelineClipMove(
        _ clipID: TimelineClip.ID,
        frameDelta: Int,
        snapThresholdFrames: Int,
        targetTrackID: TimelineTrack.ID? = nil
    ) {
        guard let timeline, let selection = timeline.clipSelection(for: clipID) else {
            clearTimelineClipMovePreview()
            return
        }
        guard !feedbackSession.hasPendingRemove(for: clipID) else {
            clearTimelineClipMovePreview()
            return
        }

        let selectedMoveIDs = activeSelectedTimelineClipIDs()
        let shouldMoveSelectedGroup = selectedMoveIDs.contains(clipID) && selectedMoveIDs.count > 1
        let preview: TimelineClipMoveViewerPreview?

        if shouldMoveSelectedGroup {
            guard let plan = TimelineClipGroupMovePlan.make(
                timeline: timeline,
                anchorSelection: selection,
                selectedClipIDs: selectedMoveIDs,
                frameDelta: frameDelta,
                snapThresholdFrames: snapThresholdFrames,
                playheadFrame: playheadFrame,
                reason: "Studio timeline magnetic group drag viewer preview",
                preferredTargetTrackID: targetTrackID
            ) else {
                clearTimelineClipMovePreview()
                return
            }
            let previewTimeline = timeline.applyingTimelineMoveOperations(plan.operations)
            preview = TimelineClipMoveViewerPreview(
                clipID: clipID,
                timeline: previewTimeline,
                previewFrame: min(max(plan.newTimelineInFrame(for: clipID) ?? playheadFrame, 0), previewTimeline.totalFrames),
                targetTrackID: plan.targetTrackID ?? selection.trackID,
                movedClipCount: plan.movedClipIDs.count
            )
        } else {
            guard let plan = TimelineClipMovePlan.make(
                timeline: timeline,
                selection: selection,
                frameDelta: frameDelta,
                snapThresholdFrames: snapThresholdFrames,
                playheadFrame: playheadFrame,
                reason: "Studio timeline magnetic drag viewer preview",
                preferredTargetTrackID: targetTrackID
            ) else {
                clearTimelineClipMovePreview()
                return
            }
            let previewTimeline = timeline.applyingTimelineMoveOperations(plan.operations)
            preview = TimelineClipMoveViewerPreview(
                clipID: plan.targetClipID,
                timeline: previewTimeline,
                previewFrame: min(max(plan.newTimelineInFrame, 0), previewTimeline.totalFrames),
                targetTrackID: plan.targetTrackID,
                movedClipCount: 1
            )
        }

        guard let preview, preview != timelineClipMoveViewerPreview else { return }
        sourceMonitorAssetID = nil
        setTimelineTransitionSelection(nil)
        timelineTransitionDurationPreview = nil
        timelineDragTrimViewerPreview = nil
        timelineRollTrimViewerPreview = nil
        timelineSlipTrimViewerPreview = nil
        timelineSkimPreview = nil
        sourceBinSkimPreview = nil
        timelineClipMoveViewerPreview = preview
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
        let previewTimecode = preview.timeline.sequence.framesToTimecode(preview.previewFrame)
        let targetText = preview.targetTrackID == selection.trackID
            ? previewTimecode
            : "\(preview.targetTrackID) \(previewTimecode)"
        let groupText = preview.movedClipCount > 1 ? " / \(preview.movedClipCount) clips" : ""
        roughCutCompileStatus = "\(preview.clipID) のドラッグ移動をViewerでプレビュー中です: \(targetText)\(groupText)。離すと適用します。"
    }

    func clearTimelineClipMovePreview() {
        guard timelineClipMoveViewerPreview != nil else { return }
        timelineClipMoveViewerPreview = nil
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
    }

    func previewTimelineSkim(
        at frame: Int,
        trackID: TimelineTrack.ID,
        clipID: TimelineClip.ID?
    ) {
        guard let timeline,
              sourceMonitorAssetID == nil,
              !isPlaying,
              timelineClipMoveViewerPreview == nil,
              timelineDragTrimViewerPreview == nil,
              timelineRollTrimViewerPreview == nil,
              timelineSlipTrimViewerPreview == nil,
              timelineTransitionDurationPreview == nil
        else {
            clearTimelineSkimPreview()
            return
        }
        let boundedFrame = max(0, min(frame, timeline.totalFrames))
        let previousPreview = timelineSkimPreview
        guard TimelineViewportScale.shouldPublishTimelineSkimPreview(
            previousFrame: previousPreview?.frame,
            previousTrackID: previousPreview?.trackID,
            previousClipID: previousPreview?.clipID,
            nextFrame: boundedFrame,
            nextTrackID: trackID,
            nextClipID: clipID
        ) else { return }

        let preview = TimelineSkimPreview(
            frame: boundedFrame,
            trackID: trackID,
            clipID: clipID
        )
        guard preview != timelineSkimPreview else { return }

        sourceBinSkimPreview = nil
        timelineSkimPreview = preview
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
    }

    func clearTimelineSkimPreview() {
        guard timelineSkimPreview != nil else { return }
        timelineSkimPreview = nil
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
    }

    func previewSourceBinSkim(assetID: String, fraction: Double) {
        guard let project = selectedProject,
              sourceMonitorAssetID == nil,
              !isPlaying,
              timelineClipMoveViewerPreview == nil,
              timelineDragTrimViewerPreview == nil,
              timelineRollTrimViewerPreview == nil,
              timelineSlipTrimViewerPreview == nil,
              timelineTransitionDurationPreview == nil,
              let status = mediaPreviewSummary.items.first(where: { $0.assetID == assetID && $0.playbackStatus.isReady })
        else {
            clearSourceBinSkimPreview()
            return
        }

        let candidate = sourceBinQuickDragCandidate(for: assetID)
        let reference = ProjectMediaResolver.resolvePreviewStatus(
            projectURL: project.path,
            status: status,
            assets: evidenceStore?.assets
        )
        let previewTimeUS = ProjectMediaSkimPreviewTime.previewTimeUS(
            sourceInUS: candidate?.src_in_us ?? reference.sourceInUS,
            sourceOutUS: candidate?.src_out_us ?? reference.sourceOutUS,
            fraction: fraction
        )
        let previousPreview = sourceBinSkimPreview
        guard ProjectMediaSkimPreviewTime.shouldPublishPreview(
            previousAssetID: previousPreview?.assetID,
            previousTimeUS: previousPreview?.previewTimeUS,
            nextAssetID: assetID,
            nextTimeUS: previewTimeUS
        ) else { return }

        let preview = SourceBinSkimPreview(assetID: assetID, previewTimeUS: previewTimeUS)
        guard preview != sourceBinSkimPreview else { return }

        timelineSkimPreview = nil
        sourceBinSkimPreview = preview
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
        roughCutCompileStatus = "\(assetID) を素材棚でスキム中（\(formatMicrosecondClock(previewTimeUS))）。クリックでソース確認できます。"
    }

    func clearSourceBinSkimPreview() {
        guard sourceBinSkimPreview != nil else { return }
        sourceBinSkimPreview = nil
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
    }

    func applyTransitionPreset(
        _ presetID: String,
        trackID: TimelineTrack.ID,
        fromClipID: TimelineClip.ID,
        toClipID: TimelineClip.ID,
        reason: String = "Studio timeline transition drag drop"
    ) {
        timelineClipMoveViewerPreview = nil
        timelineSkimPreview = nil
        sourceBinSkimPreview = nil
        timelineTransitionDurationPreview = nil
        guard let timeline else {
            roughCutCompileStatus = "トランジションを適用する前にタイムラインを読み込んでください。"
            return
        }
        guard let preset = TimelineTransitionPreset(rawValue: presetID) else {
            roughCutCompileStatus = "未対応のトランジションプリセットです。"
            return
        }
        guard !feedbackSession.hasPendingRemove(for: fromClipID),
              !feedbackSession.hasPendingRemove(for: toClipID) else {
            roughCutCompileStatus = "削除保留中のクリップを含む編集点にはトランジションを適用できません。"
            return
        }
        guard let plan = TimelineTransitionDropPlan.make(
            timeline: timeline,
            trackID: trackID,
            fromClipID: fromClipID,
            toClipID: toClipID,
            preset: preset,
            reason: reason
        ) else {
            roughCutCompileStatus = "トランジションは隙間のない映像編集点へドラッグしてください。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        for operation in plan.operations {
            feedbackSession.addOp(operation)
        }
        if let updatedTimeline = timeline.settingTransition(
            fromClipID: fromClipID,
            toClipID: toClipID,
            trackID: trackID,
            transitionType: preset.transitionType,
            transitionFrames: plan.transitionFrames,
            appliedSkillID: preset.appliedSkillID
        ) {
            self.timeline = updatedTimeline
        }
        setTimelineTransitionSelection(TimelineTransition.stableID(
            trackID: trackID,
            fromClipID: fromClipID,
            toClipID: toClipID
        ))
        setPlayheadFrame(plan.boundaryFrame, forceSeek: true)

        let durationText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.transitionFrames))
        roughCutCompileStatus = "\(preset.localizedLabel) を \(fromClipID) → \(toClipID) の編集点へ適用しました（\(durationText)）。中央ドラッグで移動、左右ドラッグで長さを調整できます。"
    }

    func applyTransitionPresetNearContext(_ presetID: String) {
        timelineClipMoveViewerPreview = nil
        timelineTransitionDurationPreview = nil
        guard let timeline else {
            roughCutCompileStatus = "トランジションを適用する前にタイムラインを読み込んでください。"
            return
        }
        guard TimelineTransitionPreset(rawValue: presetID) != nil else {
            roughCutCompileStatus = "未対応のトランジションプリセットです。"
            return
        }

        var selectedClipIDs = selectedTimelineClipIDs
        if let selectedTimelineClipID {
            selectedClipIDs.insert(selectedTimelineClipID)
        }
        let blockedClipIDs = Set(timeline.displayTracks.flatMap(\.clips).map(\.id).filter {
            feedbackSession.hasPendingRemove(for: $0) || feedbackSession.rejectedClipIDs.contains($0)
        })
        guard let target = TimelineTransitionPlacementResolver.resolve(
            timeline: timeline,
            selectedClipIDs: selectedClipIDs,
            selectedTransitionID: selectedTimelineTransitionID,
            playheadFrame: playheadFrame,
            blockedClipIDs: blockedClipIDs
        ) else {
            roughCutCompileStatus = "適用できる映像編集点がありません。隣接した映像クリップの編集点を選択するか、再生位置を近づけてください。"
            return
        }

        applyTransitionPreset(
            presetID,
            trackID: target.trackID,
            fromClipID: target.fromClipID,
            toClipID: target.toClipID,
            reason: "Studio timeline transition quick apply"
        )
    }

    func previewTransitionPresetDrop(
        _ presetID: String,
        trackID: TimelineTrack.ID,
        fromClipID: TimelineClip.ID,
        toClipID: TimelineClip.ID
    ) {
        previewTransitionPreset(
            presetID,
            trackID: trackID,
            fromClipID: fromClipID,
            toClipID: toClipID,
            reason: "Studio timeline transition drag hover preview",
            completionHint: "離すと適用します。"
        )
    }

    func previewDefaultTransitionEditPointHover(
        trackID: TimelineTrack.ID,
        fromClipID: TimelineClip.ID,
        toClipID: TimelineClip.ID
    ) {
        previewTransitionPreset(
            TimelineTransitionPreset.defaultPreset.id,
            trackID: trackID,
            fromClipID: fromClipID,
            toClipID: toClipID,
            reason: "Studio timeline transition edit point hover preview",
            completionHint: "クリックすると適用します。"
        )
    }

    private func previewTransitionPreset(
        _ presetID: String,
        trackID: TimelineTrack.ID,
        fromClipID: TimelineClip.ID,
        toClipID: TimelineClip.ID,
        reason: String,
        completionHint: String
    ) {
        timelineClipMoveViewerPreview = nil
        guard let timeline,
              let preset = TimelineTransitionPreset(rawValue: presetID),
              let plan = TimelineTransitionDropPlan.make(
                timeline: timeline,
                trackID: trackID,
                fromClipID: fromClipID,
                toClipID: toClipID,
                preset: preset,
                reason: reason
              )
        else {
            clearTimelineTransitionDurationPreview()
            return
        }

        let transitionID = TimelineTransition.stableID(trackID: trackID, fromClipID: fromClipID, toClipID: toClipID)
        let preview = TimelineTransitionDurationPreview(
            transitionID: transitionID,
            trackID: trackID,
            fromClipID: fromClipID,
            toClipID: toClipID,
            transitionType: preset.transitionType,
            transitionFrames: plan.transitionFrames,
            previewFrame: plan.boundaryFrame,
            appliedSkillID: preset.appliedSkillID
        )
        guard TimelineTransitionPreviewPublishing.shouldPublish(
            previous: timelineTransitionDurationPreview,
            next: preview,
            currentSelectedTransitionID: selectedTimelineTransitionID
        ) else { return }

        clearTimelineClipSelection()
        setTimelineTransitionSelection(transitionID)
        timelineTransitionDurationPreview = preview

        if let previewTimeline = timelineWithTransitionDurationPreview,
           previewTimeline.activeVisualTransitionPreview(atFrame: playheadFrame)?.transition.id != transitionID {
            setPlayheadFrame(plan.boundaryFrame, forceSeek: true)
        }

        let durationText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.transitionFrames))
        roughCutCompileStatus = "\(preset.localizedLabel) を \(fromClipID) → \(toClipID) の編集点へプレビュー中です（\(durationText)）。\(completionHint)"
    }

    func previewTimelineTransitionMove(
        _ transitionID: TimelineTransition.ID,
        targetTrackID: TimelineTrack.ID,
        targetFromClipID: TimelineClip.ID,
        targetToClipID: TimelineClip.ID
    ) {
        timelineClipMoveViewerPreview = nil
        guard let timeline,
              let plan = TimelineTransitionRelocatePlan.make(
                timeline: timeline,
                sourceTransitionID: transitionID,
                targetTrackID: targetTrackID,
                targetFromClipID: targetFromClipID,
                targetToClipID: targetToClipID,
                reason: "Studio timeline transition drag hover move preview"
              )
        else {
            clearTimelineTransitionDurationPreview()
            return
        }
        let referencedClipIDs = [
            plan.sourceFromClipID,
            plan.sourceToClipID,
            plan.targetFromClipID,
            plan.targetToClipID
        ]
        guard !referencedClipIDs.contains(where: { feedbackSession.hasPendingRemove(for: $0) }) else {
            clearTimelineTransitionDurationPreview()
            return
        }

        let targetTransitionID = TimelineTransition.stableID(
            trackID: targetTrackID,
            fromClipID: targetFromClipID,
            toClipID: targetToClipID
        )
        let preview = TimelineTransitionDurationPreview(
            transitionID: targetTransitionID,
            trackID: targetTrackID,
            fromClipID: targetFromClipID,
            toClipID: targetToClipID,
            transitionType: plan.transitionType,
            transitionFrames: plan.transitionFrames,
            previewFrame: plan.boundaryFrame,
            appliedSkillID: plan.appliedSkillID
        )
        guard TimelineTransitionPreviewPublishing.shouldPublish(
            previous: timelineTransitionDurationPreview,
            next: preview,
            currentSelectedTransitionID: selectedTimelineTransitionID
        ) else { return }

        clearTimelineClipSelection()
        setTimelineTransitionSelection(targetTransitionID)
        timelineTransitionDurationPreview = preview

        if let previewTimeline = timelineWithTransitionDurationPreview,
           previewTimeline.activeVisualTransitionPreview(atFrame: playheadFrame)?.transition.id != targetTransitionID {
            setPlayheadFrame(plan.boundaryFrame, forceSeek: true)
        }

        let durationText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.transitionFrames))
        roughCutCompileStatus = "\(plan.transitionType) を \(plan.sourceFromClipID) → \(plan.sourceToClipID) から \(targetFromClipID) → \(targetToClipID) へ移動プレビュー中です（\(durationText)）。離すと移動します。"
    }

    func moveTimelineTransition(
        _ transitionID: TimelineTransition.ID,
        targetTrackID: TimelineTrack.ID,
        targetFromClipID: TimelineClip.ID,
        targetToClipID: TimelineClip.ID
    ) {
        timelineClipMoveViewerPreview = nil
        timelineTransitionDurationPreview = nil
        guard let timeline else {
            roughCutCompileStatus = "トランジションを移動する前にタイムラインを読み込んでください。"
            return
        }
        guard let plan = TimelineTransitionRelocatePlan.make(
            timeline: timeline,
            sourceTransitionID: transitionID,
            targetTrackID: targetTrackID,
            targetFromClipID: targetFromClipID,
            targetToClipID: targetToClipID,
            reason: "Studio timeline transition drag move"
        ) else {
            roughCutCompileStatus = "トランジションは隙間のない別の映像編集点へドラッグしてください。"
            return
        }
        let referencedClipIDs = [
            plan.sourceFromClipID,
            plan.sourceToClipID,
            plan.targetFromClipID,
            plan.targetToClipID
        ]
        guard !referencedClipIDs.contains(where: { feedbackSession.hasPendingRemove(for: $0) }) else {
            roughCutCompileStatus = "削除保留中のクリップを含む編集点にはトランジションを移動できません。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        for operation in plan.operations {
            feedbackSession.addOp(operation)
        }
        self.timeline = plan.timeline
        clearTimelineClipSelection()
        setTimelineTransitionSelection(TimelineTransition.stableID(
            trackID: plan.targetTrackID,
            fromClipID: plan.targetFromClipID,
            toClipID: plan.targetToClipID
        ))
        setPlayheadFrame(plan.boundaryFrame, forceSeek: true)

        let durationText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.transitionFrames))
        roughCutCompileStatus = "\(plan.transitionType) を \(plan.sourceFromClipID) → \(plan.sourceToClipID) から \(plan.targetFromClipID) → \(plan.targetToClipID) へ移動しました（\(durationText)）。"
    }

    func selectTimelineTransition(trackID: TimelineTrack.ID, fromClipID: TimelineClip.ID, toClipID: TimelineClip.ID) {
        clearSourceMonitorAsset(updateStatus: false)
        timelineClipMoveViewerPreview = nil
        timelineTransitionDurationPreview = nil
        guard let timeline,
              let transition = timeline.transitions.first(where: {
                  $0.trackID == trackID && $0.fromClipID == fromClipID && $0.toClipID == toClipID
              }) else {
            return
        }
        setTimelineTransitionSelection(transition.id)
        clearTimelineClipSelection()
        let frames = transition.transitionFrames ?? 0
        let durationText = frames > 0
            ? String(format: "%.1f秒", timeline.sequence.framesToSeconds(frames))
            : "長さ未設定"
        roughCutCompileStatus = "\(transition.transitionType) \(fromClipID) → \(toClipID) を選択しました（\(durationText)）。中央ドラッグで移動、左右ドラッグで長さを調整できます。"
    }

    func previewTimelineTransitionDuration(
        trackID: TimelineTrack.ID,
        fromClipID: TimelineClip.ID,
        toClipID: TimelineClip.ID,
        frameDelta: Int
    ) {
        guard frameDelta != 0 else {
            clearTimelineTransitionDurationPreview()
            return
        }
        guard let timeline,
              let transition = timeline.transitions.first(where: {
                  $0.trackID == trackID && $0.fromClipID == fromClipID && $0.toClipID == toClipID
              }),
              let handles = timeline.transitionHandles(trackID: trackID, fromClipID: fromClipID, toClipID: toClipID),
              handles > 0
        else {
            clearTimelineTransitionDurationPreview()
            return
        }

        let currentFrames = transition.transitionFrames ?? min(TimelineTransitionPreset.defaultPreset.defaultFrames, handles)
        let nextFrames = min(handles, max(1, currentFrames + frameDelta))
        let transitionID = TimelineTransition.stableID(trackID: trackID, fromClipID: fromClipID, toClipID: toClipID)
        guard let boundaryFrame = transitionBoundaryFrame(
            in: timeline,
            trackID: trackID,
            fromClipID: fromClipID
        ) else {
            clearTimelineTransitionDurationPreview()
            return
        }
        let previewFrame = TimelineViewportScale.transitionDurationDragViewerPreviewFrame(
            boundaryFrame: boundaryFrame,
            existingDurationFrames: currentFrames,
            frameDelta: nextFrames - currentFrames,
            totalFrames: timeline.totalFrames
        )

        let preview = TimelineTransitionDurationPreview(
            transitionID: transitionID,
            trackID: trackID,
            fromClipID: fromClipID,
            toClipID: toClipID,
            transitionType: transition.transitionType,
            transitionFrames: nextFrames,
            previewFrame: previewFrame,
            appliedSkillID: transition.appliedSkillID
        )

        guard TimelineTransitionPreviewPublishing.shouldPublish(
            previous: timelineTransitionDurationPreview,
            next: preview,
            currentSelectedTransitionID: selectedTimelineTransitionID
        ) else { return }

        clearTimelineClipSelection()
        setTimelineTransitionSelection(transitionID)
        timelineClipMoveViewerPreview = nil
        timelineDragTrimViewerPreview = nil
        timelineRollTrimViewerPreview = nil
        timelineSlipTrimViewerPreview = nil
        timelineTransitionDurationPreview = preview

        if let previewTimeline = timelineWithTransitionDurationPreview,
           previewTimeline.activeVisualTransitionPreview(atFrame: playheadFrame)?.transition.id != transitionID,
           playheadFrame != previewFrame {
            setPlayheadFrame(boundaryFrame, forceSeek: true)
        }
    }

    func clearTimelineTransitionDurationPreview() {
        guard TimelineTransitionPreviewPublishing.shouldClear(timelineTransitionDurationPreview) else { return }
        timelineTransitionDurationPreview = nil
    }

    func shortenSelectedTimelineTransitionDuration() {
        adjustSelectedTimelineTransitionDuration(
            by: -timelineTransitionDurationStepFrames,
            reason: "Studio timeline transition duration shorter"
        )
    }

    func lengthenSelectedTimelineTransitionDuration() {
        adjustSelectedTimelineTransitionDuration(
            by: timelineTransitionDurationStepFrames,
            reason: "Studio timeline transition duration longer"
        )
    }

    private func adjustSelectedTimelineTransitionDuration(by frameDelta: Int, reason: String) {
        guard let transition = selectedTimelineTransition else {
            roughCutCompileStatus = "長さを調整するトランジションを選択してください。"
            return
        }
        adjustTimelineTransitionDuration(
            trackID: transition.trackID,
            fromClipID: transition.fromClipID,
            toClipID: transition.toClipID,
            frameDelta: frameDelta,
            reason: reason
        )
    }

    func adjustTimelineTransitionDuration(
        trackID: TimelineTrack.ID,
        fromClipID: TimelineClip.ID,
        toClipID: TimelineClip.ID,
        frameDelta: Int,
        reason: String = "Studio timeline transition duration drag"
    ) {
        timelineTransitionDurationPreview = nil
        guard frameDelta != 0 else { return }
        guard let timeline else {
            roughCutCompileStatus = "トランジションを調整する前にタイムラインを読み込んでください。"
            return
        }
        guard let transition = timeline.transitions.first(where: {
            $0.trackID == trackID && $0.fromClipID == fromClipID && $0.toClipID == toClipID
        }) else {
            roughCutCompileStatus = "調整するトランジションを先に適用してください。"
            return
        }
        guard let handles = timeline.transitionHandles(trackID: trackID, fromClipID: fromClipID, toClipID: toClipID),
              handles > 0 else {
            roughCutCompileStatus = "隣接していない編集点のトランジションは調整できません。"
            return
        }

        let currentFrames = transition.transitionFrames ?? min(TimelineTransitionPreset.defaultPreset.defaultFrames, handles)
        let nextFrames = min(handles, max(1, currentFrames + frameDelta))
        guard nextFrames != currentFrames else {
            roughCutCompileStatus = "トランジションはこれ以上\(frameDelta > 0 ? "長く" : "短く")できません。"
            return
        }
        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }

        let operation = ReviewPatchOperation.setTransition(
            from_clip_id: fromClipID,
            to_clip_id: toClipID,
            track_id: trackID,
            transition_type: transition.transitionType,
            transition_frames: nextFrames,
            applied_skill_id: transition.appliedSkillID,
            reason: reason
        )
        feedbackSession.addOp(operation)
        if let updatedTimeline = timeline.settingTransition(
            fromClipID: fromClipID,
            toClipID: toClipID,
            trackID: trackID,
            transitionType: transition.transitionType,
            transitionFrames: nextFrames,
            appliedSkillID: transition.appliedSkillID
        ) {
            self.timeline = updatedTimeline
        }
        setTimelineTransitionSelection(TimelineTransition.stableID(
            trackID: trackID,
            fromClipID: fromClipID,
            toClipID: toClipID
        ))
        setPlayheadFrame(playheadFrame, forceSeek: true)
        let durationText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(nextFrames))
        roughCutCompileStatus = "\(transition.transitionType) \(fromClipID) → \(toClipID) を \(durationText) に調整しました。"
    }

    func removeSelectedTimelineTransition() {
        timelineClipMoveViewerPreview = nil
        timelineTransitionDurationPreview = nil
        guard let timeline else {
            roughCutCompileStatus = "トランジションを削除する前にタイムラインを読み込んでください。"
            return
        }
        guard let transition = selectedTimelineTransition else {
            roughCutCompileStatus = "削除するトランジションを選択してください。"
            return
        }
        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        let operation = ReviewPatchOperation.setTransition(
            from_clip_id: transition.fromClipID,
            to_clip_id: transition.toClipID,
            track_id: transition.trackID,
            transition_type: "cut",
            transition_frames: max(1, transition.transitionFrames ?? 1),
            applied_skill_id: nil,
            reason: "Studio timeline transition remove"
        )
        feedbackSession.addOp(operation)
        if let updatedTimeline = timeline.settingTransition(
            fromClipID: transition.fromClipID,
            toClipID: transition.toClipID,
            trackID: transition.trackID,
            transitionType: "cut",
            transitionFrames: max(1, transition.transitionFrames ?? 1),
            appliedSkillID: nil
        ) {
            self.timeline = updatedTimeline
        }
        setTimelineTransitionSelection(nil)
        if let boundaryFrame = transitionBoundaryFrame(
            in: timeline,
            trackID: transition.trackID,
            fromClipID: transition.fromClipID
        ) {
            setPlayheadFrame(boundaryFrame, forceSeek: true)
        } else {
            setPlayheadFrame(playheadFrame, forceSeek: true)
        }
        roughCutCompileStatus = "\(transition.transitionType) \(transition.fromClipID) → \(transition.toClipID) を外しました。未保存のStudio修正です。"
    }

    private func transitionBoundaryFrame(
        in timeline: TimelineDocument,
        trackID: TimelineTrack.ID,
        fromClipID: TimelineClip.ID
    ) -> Int? {
        timeline.displayTracks
            .first { $0.id == trackID }?
            .clips
            .first { $0.id == fromClipID }?
            .timelineOutFrame
    }

    func deleteTimelineSelection() {
        if selectedTimelineTransition != nil {
            removeSelectedTimelineTransition()
            return
        }
        guard let timeline else {
            roughCutCompileStatus = "削除する前にタイムラインの項目を選択してください。"
            return
        }
        let clipIDs = activeSelectedTimelineClipIDs()
        guard !clipIDs.isEmpty else {
            roughCutCompileStatus = "削除する前にタイムラインの項目を選択してください。"
            return
        }
        if makeRippleDeleteSelectionPlan(
            timeline: timeline,
            reason: "Studio timeline delete selection"
        ) != nil {
            rippleDeleteSelectedTimelineClip()
        } else {
            liftDeleteSelectedTimelineClips()
        }
    }

    func splitSelectedTimelineClipAtPlayhead() {
        guard let timeline, let selection = selectedTimelineClip else {
            roughCutCompileStatus = "分割する前にタイムラインのクリップを選択してください。"
            return
        }
        splitTimelineClip(
            selection,
            in: timeline,
            at: playheadFrame,
            reason: "Studio timeline toolbar split at playhead",
            failureMessage: "\(selection.clip.id) は現在の再生位置では分割できません。再生位置をクリップの内側に移動してください。",
            statusPrefix: "\(selection.clip.id) を再生位置で分割しました。"
        )
    }

    func bladeSplitTimelineClip(_ clipID: TimelineClip.ID, at splitFrame: Int) {
        guard let timeline, let selection = timeline.clipSelection(for: clipID) else {
            roughCutCompileStatus = "ブレードで分割するクリップを確認できません。"
            return
        }
        splitTimelineClip(
            selection,
            in: timeline,
            at: splitFrame,
            reason: "Studio timeline blade click split",
            failureMessage: "\(selection.clip.id) はその位置では分割できません。クリップの内側をクリックしてください。",
            statusPrefix: "\(selection.clip.id) をブレードクリックで分割しました。"
        )
    }

    private func splitTimelineClip(
        _ selection: TimelineClipSelection,
        in timeline: TimelineDocument,
        at splitFrame: Int,
        reason: String,
        failureMessage: String,
        statusPrefix: String
    ) {
        guard !feedbackSession.hasPendingRemove(for: selection.clip.id),
              let plan = TimelineSplitPlan.make(
                selection: selection,
                playheadFrame: splitFrame,
                reason: reason
              ) else {
            roughCutCompileStatus = failureMessage
            return
        }

        let rightClipID = TimelineSplitPlan.nextClipID(in: timeline)
        guard let updatedTimeline = timeline.splittingClip(
            selection.clip.id,
            atTimelineFrame: plan.playheadFrame,
            rightClipID: rightClipID,
            reason: reason
        ) else {
            roughCutCompileStatus = failureMessage
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        for operation in plan.operations {
            feedbackSession.addOp(operation)
        }

        self.timeline = updatedTimeline
        setTimelineClipSelection(primary: rightClipID, ids: [rightClipID])
        showChangedClipHighlight([selection.clip.id, rightClipID])
        setPlayheadFrame(plan.playheadFrame, forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let leftText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.leftDurationFrames))
        let rightText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.rightDurationFrames))
        roughCutCompileStatus = "\(statusPrefix) 前半\(leftText) / 後半\(rightText)。タイムラインとプレビューに反映しました。"
    }

    func rippleDeleteSelectedTimelineClip() {
        timelineClipMoveViewerPreview = nil
        timelineTransitionDurationPreview = nil
        guard let timeline else {
            roughCutCompileStatus = "リップル削除する前にタイムラインのクリップを選択してください。"
            return
        }
        let clipIDs = activeSelectedTimelineClipIDs()
        guard !clipIDs.isEmpty else {
            roughCutCompileStatus = "リップル削除する前にタイムラインのクリップを選択してください。"
            return
        }
        guard let plan = makeRippleDeleteSelectionPlan(
            timeline: timeline,
            reason: "Studio timeline toolbar ripple delete"
        ) else {
            roughCutCompileStatus = rippleDeleteFailureMessage(timeline: timeline, clipIDs: clipIDs)
            return
        }
        guard let updatedTimeline = timeline.applyingRippleDelete(plan) else {
            roughCutCompileStatus = "選択クリップのリップル削除をタイムラインへ反映できません。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        feedbackSession.queueRippleDelete(plan)
        self.timeline = updatedTimeline
        setTimelineTransitionSelection(nil)
        setTimelineClipSelection(primary: nil, ids: [])
        showChangedClipHighlight(plan.movedClipIDs)
        clearSourceMonitorAsset(updateStatus: false)
        let playheadTarget = plan.deletedClipIDs
            .compactMap { timeline.clipSelection(for: $0)?.clip.timelineInFrame }
            .min() ?? playheadFrame
        setPlayheadFrame(playheadTarget, forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let shiftSeconds = timeline.sequence.framesToSeconds(plan.shiftFrames)
        let shiftText = String(format: "%.1f秒", shiftSeconds)
        let movedText = plan.movedClipIDs.isEmpty
            ? "後続クリップはありません。"
            : "後続\(plan.movedClipIDs.count)件を \(shiftText) 前へ詰めました。"
        let deletedText: String
        if plan.deletedClipIDs.count == 1 {
            deletedText = "\(plan.deletedClipIDs[0])"
        } else if plan.isCrossTrackRipple {
            deletedText = "\(plan.trackIDs.count)トラックの\(plan.deletedClipIDs.count)件"
        } else {
            deletedText = "\(plan.trackID) の\(plan.deletedClipIDs.count)件"
        }
        roughCutCompileStatus = "\(deletedText) をリップル削除しました。\(movedText)未保存のStudio修正です。"
    }

    private func liftDeleteSelectedTimelineClips() {
        timelineClipMoveViewerPreview = nil
        timelineTransitionDurationPreview = nil
        guard let timeline else {
            roughCutCompileStatus = "削除する前にタイムラインのクリップを選択してください。"
            return
        }
        let clipIDs = activeSelectedTimelineClipIDs()
        guard !clipIDs.isEmpty else {
            roughCutCompileStatus = "削除する前にタイムラインのクリップを選択してください。"
            return
        }
        guard let plan = makeLiftDeleteSelectionPlan(
            timeline: timeline,
            reason: "Studio timeline lift delete selection"
        ) else {
            roughCutCompileStatus = "選択クリップを削除できません。"
            return
        }
        guard let updatedTimeline = timeline.applyingLiftDelete(plan) else {
            roughCutCompileStatus = "選択クリップの削除をタイムラインへ反映できません。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        feedbackSession.queueLiftDelete(plan)
        self.timeline = updatedTimeline
        setTimelineTransitionSelection(nil)
        setTimelineClipSelection(primary: nil, ids: [])
        showChangedClipHighlight([])
        clearSourceMonitorAsset(updateStatus: false)
        let playheadTarget = plan.deletedClipIDs
            .compactMap { timeline.clipSelection(for: $0)?.clip.timelineInFrame }
            .min() ?? playheadFrame
        setPlayheadFrame(playheadTarget, forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let trackText = plan.trackIDs.count == 1
            ? plan.trackIDs[0]
            : "\(plan.trackIDs.count)トラック"
        let deletedText = plan.deletedClipIDs.count == 1
            ? "\(plan.deletedClipIDs[0])"
            : "\(trackText)の\(plan.deletedClipIDs.count)件"
        roughCutCompileStatus = "\(deletedText) を削除しました。リップルせず空き時間は保持します。未保存のStudio修正です。"
    }

    private func makeRippleDeleteSelectionPlan(
        reason: String
    ) -> TimelineRippleDeleteGroupPlan? {
        guard let timeline else { return nil }
        return makeRippleDeleteSelectionPlan(timeline: timeline, reason: reason)
    }

    private func makeRippleDeleteSelectionPlan(
        timeline: TimelineDocument,
        reason: String
    ) -> TimelineRippleDeleteGroupPlan? {
        TimelineRippleDeleteGroupPlan.make(
            timeline: timeline,
            clipIDs: activeSelectedTimelineClipIDs(),
            reason: reason
        )
    }

    private func makeLiftDeleteSelectionPlan(
        timeline: TimelineDocument,
        reason: String
    ) -> TimelineLiftDeletePlan? {
        TimelineLiftDeletePlan.make(
            timeline: timeline,
            clipIDs: activeSelectedTimelineClipIDs(),
            reason: reason
        )
    }

    private func rippleDeleteFailureMessage(
        timeline: TimelineDocument,
        clipIDs: Set<TimelineClip.ID>
    ) -> String {
        let selections = clipIDs.compactMap { timeline.clipSelection(for: $0) }
        guard !selections.isEmpty else {
            return "リップル削除するクリップを確認できません。"
        }
        let trackIDs = Set(selections.map(\.trackID))
        if trackIDs.count > 1 {
            return "複数トラックのリップル削除は、同じ時間範囲を連続して選択した場合だけ対応しています。範囲がずれる場合は通常の削除で空きを保持してください。"
        }
        return "選択クリップはリップル削除できません。"
    }

    private func trimSelectedTimelineClip(edge: TimelineTrimEdge, seconds: Double) {
        guard let timeline, let selection = selectedTimelineClip else {
            roughCutCompileStatus = "トリムする前にタイムラインのクリップを選択してください。"
            return
        }

        let clip = selection.clip
        guard let sourceInUS = clip.sourceInUS,
              let sourceOutUS = clip.sourceOutUS,
              sourceOutUS > sourceInUS else {
            roughCutCompileStatus = "\(clip.id) はソース範囲がないためトリムできません。"
            return
        }

        let requestedFrames = max(1, Int((timeline.sequence.fps * seconds).rounded()))
        let availableFrames = clip.timelineDurationFrames - 1
        guard availableFrames > 0 else {
            roughCutCompileStatus = "\(clip.id) はこれ以上短くできません。"
            return
        }
        let deltaFrames = min(requestedFrames, availableFrames)
        let trimEdge: TimelinePlayheadTrimEdge = edge == .start ? .start : .end
        let targetBoundaryFrame = edge == .start
            ? clip.timelineInFrame + deltaFrames
            : clip.timelineOutFrame - deltaFrames
        guard let plan = TimelineDragTrimPlan.make(
            timeline: timeline,
            selection: selection,
            targetBoundaryFrame: targetBoundaryFrame,
            edge: trimEdge,
            snapThresholdFrames: 0,
            playheadFrame: playheadFrame,
            assetDurationUS: assetDurationsUSByID[clip.assetID],
            reason: "Studio timeline toolbar trimmed \(edge == .start ? "start" : "end") by \(String(format: "%.1f秒", timeline.sequence.framesToSeconds(deltaFrames)))"
        ) else {
            roughCutCompileStatus = "\(clip.id) はこれ以上短くできません。"
            return
        }

        queueAndApplyTimelineTrimOperations(plan.operations, to: timeline)
        let edgeLabel = edge == .start ? "先頭" : "末尾"
        let deltaText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.removedFrames))
        roughCutCompileStatus = "\(clip.id) の\(edgeLabel)を \(deltaText) 詰め、タイムラインとViewerに反映しました。"
    }

    private func trimSelectedTimelineClipToPlayhead(edge: TimelinePlayheadTrimEdge) {
        guard let timeline, let selection = selectedTimelineClip else {
            roughCutCompileStatus = "再生位置でトリムする前にタイムラインのクリップを選択してください。"
            return
        }
        guard let plan = makePlayheadTrimPlan(
            edge: edge,
            reason: "Studio timeline toolbar trim \(edge == .start ? "start" : "end") to playhead"
        ) else {
            roughCutCompileStatus = "\(selection.clip.id) は現在の再生位置ではトリムできません。再生位置をクリップの内側に移動してください。"
            return
        }

        queueAndApplyTimelineTrimOperations(plan.operations, to: timeline)

        let edgeLabel = edge == .start ? "先頭" : "末尾"
        let deltaText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.removedFrames))
        roughCutCompileStatus = "\(selection.clip.id) の\(edgeLabel)を再生位置まで \(deltaText) 詰め、タイムラインとプレビューに反映しました。"
    }

    private func rollSelectedTimelineEdit(
        boundary: TimelineRollTrimBoundary,
        direction: TimelineRollTrimDirection
    ) {
        guard let timeline, let selection = selectedTimelineClip else {
            roughCutCompileStatus = "ロールトリムする前にタイムラインのクリップを選択してください。"
            return
        }
        guard let plan = makeRollTrimPlan(
            boundary: boundary,
            direction: direction,
            reason: "Studio timeline toolbar roll \(boundary.rawValue) edit \(direction.rawValue)"
        ) else {
            roughCutCompileStatus = "\(selection.clip.id) はこの方向へロールトリムできません。隣接クリップ、素材尺、削除保留状態を確認してください。"
            return
        }

        queueAndApplyTimelineTrimOperations(plan.operations, to: timeline)

        let boundaryLabel = boundary == .incoming ? "前の編集点" : "次の編集点"
        let directionLabel = direction == .left ? "左" : "右"
        let shiftText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.shiftFrames))
        roughCutCompileStatus = "\(plan.leftClipID) / \(plan.rightClipID) の\(boundaryLabel)を\(directionLabel)へ \(shiftText) ロールし、タイムラインとViewerに反映しました。"
    }

    private func extendSelectedTimelineClip(edge: TimelineExtendTrimEdge) {
        guard let timeline, let selection = selectedTimelineClip else {
            roughCutCompileStatus = "伸ばす前にタイムラインのクリップを選択してください。"
            return
        }
        guard let plan = makeExtendTrimPlan(
            edge: edge,
            reason: "Studio timeline toolbar extend \(edge.rawValue)"
        ) else {
            roughCutCompileStatus = "\(selection.clip.id) はこの方向へ伸ばせません。前後の空き、素材の余白、削除保留状態を確認してください。"
            return
        }

        queueAndApplyTimelineTrimOperations(plan.operations, to: timeline)

        let edgeLabel = edge == .start ? "先頭" : "末尾"
        let addedText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.addedFrames))
        roughCutCompileStatus = "\(plan.clipID) の\(edgeLabel)を \(addedText) 伸ばし、タイムラインとViewerに反映しました。"
    }

    private func slipSelectedTimelineClip(direction: TimelineSlipTrimDirection) {
        guard let timeline, let selection = selectedTimelineClip else {
            roughCutCompileStatus = "スリップする前にタイムラインのクリップを選択してください。"
            return
        }
        guard let plan = makeSlipTrimPlan(
            direction: direction,
            reason: "Studio timeline toolbar slip \(direction.rawValue)"
        ) else {
            roughCutCompileStatus = "\(selection.clip.id) はこの方向へスリップできません。素材の前後余白、素材尺、削除保留状態を確認してください。"
            return
        }

        queueAndApplyTimelineTrimOperations(plan.operations, to: timeline)

        let directionLabel = direction == .left ? "左" : "右"
        let shiftText = String(format: "%.1f秒", timeline.sequence.framesToSeconds(plan.shiftFrames))
        roughCutCompileStatus = "\(plan.clipID) の素材範囲を\(directionLabel)へ \(shiftText) スリップし、Viewerに反映しました。タイムライン上の位置と尺は変わりません。"
    }

    private func queueAndApplyTimelineTrimOperations(
        _ operations: [ReviewPatchOperation],
        to timeline: TimelineDocument
    ) {
        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        timelineClipMoveViewerPreview = nil
        timelineTransitionDurationPreview = nil
        timelineRollTrimViewerPreview = nil
        timelineSlipTrimViewerPreview = nil
        sourceMonitorAssetID = nil
        setTimelineTransitionSelection(nil)
        for operation in operations {
            feedbackSession.addOp(operation)
        }
        let updatedTimeline = timeline.applyingTimelineTrimOperations(operations)
        self.timeline = updatedTimeline
        reconcileTimelineClipSelection(with: updatedTimeline)
        setPlayheadFrame(min(playheadFrame, updatedTimeline.totalFrames), forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
    }

    private func nudgeSelectedTimelineClip(direction: TimelineClipNudgeDirection) {
        guard let timeline, let selection = selectedTimelineClip else {
            roughCutCompileStatus = "位置を移動する前にタイムラインのクリップを選択してください。"
            return
        }
        let selectedMoveIDs = activeSelectedTimelineClipIDs()
        let shouldMoveSelectedGroup = selectedMoveIDs.contains(selection.clip.id) && selectedMoveIDs.count > 1
        let pendingMoveIDs = shouldMoveSelectedGroup ? selectedMoveIDs : [selection.clip.id]
        if let pendingRemoveClipID = pendingMoveIDs.first(where: { feedbackSession.hasPendingRemove(for: $0) }) {
            roughCutCompileStatus = "\(pendingRemoveClipID) は削除保留中のため位置を移動できません。"
            return
        }
        guard let plan = makeSelectedTimelineClipNudgePlan(
            direction: direction,
            reason: "Studio timeline toolbar magnetic nudge \(direction == .earlier ? "earlier" : "later")"
        ) else {
            roughCutCompileStatus = "\(selection.clip.id) はこの方向へ移動できません。タイムライン先頭、重なり、選択状態を確認してください。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        timelineClipMoveViewerPreview = nil
        timelineTransitionDurationPreview = nil
        sourceMonitorAssetID = nil
        setTimelineTransitionSelection(nil)
        setTimelineClipSelection(primary: plan.primaryClipID, ids: Set(plan.movedClipIDs))
        for operation in plan.operations {
            feedbackSession.addOp(operation)
        }
        let updatedTimeline = timeline.applyingTimelineMoveOperations(plan.operations)
        self.timeline = updatedTimeline
        reconcileTimelineClipSelection(with: updatedTimeline)
        setPlayheadFrame(min(playheadFrame, updatedTimeline.totalFrames), forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let shiftText = String(format: "%.1f秒", abs(timeline.sequence.framesToSeconds(plan.shiftFrames)))
        let clipText = plan.movedClipIDs.count > 1
            ? "選択中の \(plan.movedClipIDs.count) クリップ"
            : plan.primaryClipID
        let snapText = plan.snap.map { " 吸着: \($0.label)" } ?? ""
        let laneLiftText = plan.laneLift.map {
            $0.createsTrack
                ? " 重なりを避けて \($0.targetTrackID) を作り、そこへリフトしました。"
                : " 重なりを避けて \($0.targetTrackID) へリフトしました。"
        } ?? ""
        let displacementText = plan.displacements.isEmpty
            ? ""
            : " 重なった \(plan.displacements.count) 件を後ろへ送っています。"
        roughCutCompileStatus = "\(clipText) を \(shiftText) \(direction.localizedLabel)へ移動し、タイムラインとViewerに反映しました。\(snapText)\(laneLiftText)\(displacementText)"
    }

    private func makeSelectedTimelineClipNudgePlan(
        direction: TimelineClipNudgeDirection,
        reason: String
    ) -> SelectedTimelineClipMovePlan? {
        guard let timeline, let selection = selectedTimelineClip else { return nil }
        let frameDelta = nudgeFrameDelta(for: timeline.sequence, direction: direction)
        let selectedMoveIDs = activeSelectedTimelineClipIDs()
        let shouldMoveSelectedGroup = selectedMoveIDs.contains(selection.clip.id) && selectedMoveIDs.count > 1
        let pendingMoveIDs = shouldMoveSelectedGroup ? selectedMoveIDs : [selection.clip.id]
        guard !pendingMoveIDs.contains(where: { feedbackSession.hasPendingRemove(for: $0) }) else { return nil }

        if shouldMoveSelectedGroup {
            guard let plan = TimelineClipGroupMovePlan.make(
                timeline: timeline,
                anchorSelection: selection,
                selectedClipIDs: selectedMoveIDs,
                frameDelta: frameDelta,
                snapThresholdFrames: 0,
                playheadFrame: playheadFrame,
                reason: reason
            ) else { return nil }
            return .group(plan)
        }

        guard let plan = TimelineClipMovePlan.make(
            timeline: timeline,
            selection: selection,
            frameDelta: frameDelta,
            snapThresholdFrames: 0,
            playheadFrame: playheadFrame,
            reason: reason
        ) else { return nil }
        return .single(plan)
    }

    private func nudgeFrameDelta(for sequence: TimelineSequence, direction: TimelineClipNudgeDirection) -> Int {
        max(1, Int((sequence.fps * 0.5).rounded())) * direction.multiplier
    }

    private func makeExtendTrimPlan(
        edge: TimelineExtendTrimEdge,
        reason: String
    ) -> TimelineExtendTrimPlan? {
        guard !hasMultipleTimelineClipSelection else { return nil }
        guard let timeline, let selection = selectedTimelineClip else { return nil }
        guard !feedbackSession.hasPendingRemove(for: selection.clip.id) else { return nil }
        return TimelineExtendTrimPlan.make(
            timeline: timeline,
            selection: selection,
            edge: edge,
            deltaFrames: max(1, Int((timeline.sequence.fps * 0.5).rounded())),
            assetDurationUS: assetDurationsUSByID[selection.clip.assetID],
            reason: reason
        )
    }

    private func makePlayheadTrimPlan(edge: TimelinePlayheadTrimEdge, reason: String) -> TimelinePlayheadTrimPlan? {
        guard !hasMultipleTimelineClipSelection else { return nil }
        guard let selection = selectedTimelineClip else { return nil }
        return TimelinePlayheadTrimPlan.make(
            selection: selection,
            playheadFrame: playheadFrame,
            edge: edge,
            reason: reason
        )
    }

    private func makeRollTrimPlan(
        boundary: TimelineRollTrimBoundary,
        direction: TimelineRollTrimDirection,
        reason: String
    ) -> TimelineRollTrimPlan? {
        guard !hasMultipleTimelineClipSelection else { return nil }
        guard let timeline, let selection = selectedTimelineClip else { return nil }
        return makeRollTrimPlan(
            selection: selection,
            boundary: boundary,
            direction: direction,
            deltaFrames: max(1, Int((timeline.sequence.fps * 0.5).rounded())),
            reason: reason
        )
    }

    private func makeRollTrimPlan(
        selection: TimelineClipSelection,
        boundary: TimelineRollTrimBoundary,
        direction: TimelineRollTrimDirection,
        deltaFrames: Int,
        reason: String
    ) -> TimelineRollTrimPlan? {
        guard deltaFrames > 0,
              let timeline
        else { return nil }
        let plan = TimelineRollTrimPlan.make(
            timeline: timeline,
            selection: selection,
            boundary: boundary,
            direction: direction,
            deltaFrames: deltaFrames,
            assetDurationsUSByID: assetDurationsUSByID,
            reason: reason
        )
        guard let plan else { return nil }
        guard !plan.affectedClipIDs.contains(where: { feedbackSession.hasPendingRemove(for: $0) }) else {
            return nil
        }
        return plan
    }

    private func rollDirectionAndFrameCount(for frameDelta: Int) -> (direction: TimelineRollTrimDirection, frames: Int)? {
        guard frameDelta != 0 else { return nil }
        return frameDelta < 0 ? (.left, abs(frameDelta)) : (.right, frameDelta)
    }

    private func makeSlipTrimPlan(
        direction: TimelineSlipTrimDirection,
        reason: String
    ) -> TimelineSlipTrimPlan? {
        guard !hasMultipleTimelineClipSelection else { return nil }
        guard let timeline, let selection = selectedTimelineClip else { return nil }
        return makeSlipTrimPlan(
            selection: selection,
            direction: direction,
            deltaFrames: max(1, Int((timeline.sequence.fps * 0.5).rounded())),
            reason: reason
        )
    }

    private func makeSlipTrimPlan(
        selection: TimelineClipSelection,
        direction: TimelineSlipTrimDirection,
        deltaFrames: Int,
        reason: String
    ) -> TimelineSlipTrimPlan? {
        guard deltaFrames > 0 else { return nil }
        guard !feedbackSession.hasPendingRemove(for: selection.clip.id) else { return nil }
        return TimelineSlipTrimPlan.make(
            selection: selection,
            direction: direction,
            deltaFrames: deltaFrames,
            assetDurationUS: assetDurationsUSByID[selection.clip.assetID],
            reason: reason
        )
    }

    private func slipDirectionAndFrameCount(for frameDelta: Int) -> (direction: TimelineSlipTrimDirection, frames: Int)? {
        guard frameDelta != 0 else { return nil }
        return frameDelta < 0 ? (.left, abs(frameDelta)) : (.right, frameDelta)
    }

    private func makeSplitPlan(reason: String) -> TimelineSplitPlan? {
        guard !hasMultipleTimelineClipSelection else { return nil }
        guard let selection = selectedTimelineClip else { return nil }
        guard !feedbackSession.hasPendingRemove(for: selection.clip.id) else { return nil }
        return TimelineSplitPlan.make(
            selection: selection,
            playheadFrame: playheadFrame,
            reason: reason
        )
    }

    private var assetDurationsUSByID: [String: Int] {
        var durations: [String: Int] = [:]
        for asset in evidenceStore?.assets?.items ?? [] {
            guard let durationUS = asset.durationUS, durationUS > 0 else { continue }
            durations[asset.id] = durationUS
        }
        return durations
    }

    var timelineAssetDurationsUSByID: [String: Int] {
        assetDurationsUSByID
    }

    var timelineThumbnailURLByAssetID: [String: URL] {
        guard let selectedProject, let timeline else { return [:] }

        var thumbnailURLs: [String: URL] = [:]
        let assetIDs = Set(timeline.displayTracks.flatMap(\.clips).map(\.assetID))
        for assetID in assetIDs {
            guard let thumbnailURL = ProjectThumbnailCache.thumbnailURL(
                projectURL: selectedProject.path,
                assetID: assetID,
                assets: evidenceStore?.assets
            ) else {
                continue
            }
            thumbnailURLs[assetID] = thumbnailURL
        }
        return thumbnailURLs
    }

    private func formatTrimDelta(_ microseconds: Int) -> String {
        String(format: "%.1f秒", Double(microseconds) / 1_000_000)
    }

    func openSwapBrowserForSelectedClip() {
        guard let clip = selectedTimelineClip?.clip ?? programTimelineClip?.clip else {
            roughCutCompileStatus = "差し替え候補を開く前にクリップを選択するか、再生位置をクリップ上に移動してください。"
            return
        }
        openSwapBrowser(for: clip)
    }

    func saveSelectedClipNote() {
        guard let selectedProject, let clipID = selectedTimelineClipID else {
            editorAnnotationStatus = "メモを保存する前にタイムラインのクリップを選択してください。"
            return
        }
        do {
            editorAnnotations = try ProjectEditorAnnotationStore.upsertNote(
                projectURL: selectedProject.path,
                clipID: clipID,
                note: selectedClipNoteDraft,
                handoffInstruction: selectedClipHandoffInstructionDraft
            )
            editorAnnotationSummary = ProjectEditorAnnotationStore.summary(projectURL: selectedProject.path, timeline: timeline)
            editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path, assets: evidenceStore?.assets)
            editorPacketStatus = editorPacketPlan?.readinessLabel ?? "編集者パケットはまだ確認されていません。"
            editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: selectedProject.path)
            refreshLibraryReadiness(projectURL: selectedProject.path)
            editorAnnotationStatus = "\(clipID) のメモを保存しました。"
            loadSelectedClipNoteDraft()
        } catch {
            editorAnnotationStatus = "メモの保存に失敗しました: \(error)"
        }
    }

    func pinSelectedAgentTurnToClipNoteDraft() {
        guard let clipID = selectedTimelineClipID else {
            editorAnnotationStatus = "AI相談結果をメモ下書きへ追加する前にタイムラインのクリップを選択してください。"
            return
        }
        guard let record = selectedTurnRecord else {
            editorAnnotationStatus = "メモ下書きへ追加できるAI相談結果がありません。"
            return
        }
        guard record.readOnly else {
            editorAnnotationStatus = "読み取り専用のAI相談結果だけをメモ下書きへ追加できます。"
            return
        }
        guard let draft = TimelineAgentResultHandoffDraft.make(
            clipID: clipID,
            sourceLabel: record.title,
            assistantText: record.assistantText,
            existingNoteDraft: selectedClipNoteDraft,
            existingHandoffInstructionDraft: selectedClipHandoffInstructionDraft
        ) else {
            editorAnnotationStatus = "選択中のAI相談結果にメモへ追加できる本文がありません。"
            return
        }

        selectedClipNoteDraft = draft.noteDraft
        selectedClipHandoffInstructionDraft = draft.handoffInstructionDraft
        let primaryLabel = selectedTimelineClipCount > 1 ? "\(clipID) (複数選択の主クリップ)" : clipID
        editorAnnotationStatus = "\(primaryLabel) のメモ下書きへAI相談結果を追加しました。まだ保存していません。"
        turnStatus = "\(primaryLabel) のメモ下書きへAI相談結果を追加しました。timelineには適用していません。"
    }

    func clearSelectedClipNote() {
        guard let selectedProject, let clipID = selectedTimelineClipID else {
            editorAnnotationStatus = "メモを消去する前にタイムラインのクリップを選択してください。"
            return
        }
        do {
            editorAnnotations = try ProjectEditorAnnotationStore.removeNote(projectURL: selectedProject.path, clipID: clipID)
            editorAnnotationSummary = ProjectEditorAnnotationStore.summary(projectURL: selectedProject.path, timeline: timeline)
            editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path, assets: evidenceStore?.assets)
            editorPacketStatus = editorPacketPlan?.readinessLabel ?? "編集者パケットはまだ確認されていません。"
            editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: selectedProject.path)
            refreshLibraryReadiness(projectURL: selectedProject.path)
            selectedClipNoteDraft = ""
            selectedClipHandoffInstructionDraft = ""
            editorAnnotationStatus = "\(clipID) のメモを消去しました。"
        } catch {
            editorAnnotationStatus = "メモの消去に失敗しました: \(error)"
        }
    }

    func proposeSelectedClipNoteWithCodex() {
        runSelectedClipAnnotationProposal(job: nil)
    }

    private func runSelectedClipAnnotationProposal(job: VideoOSAgentJob?) {
        guard appServerStatus != .checking else { return }
        guard let selectedProject, let timeline, let selection = selectedTimelineClip else {
            editorAnnotationStatus = "Codexに相談する前にタイムラインのクリップを選択してください。"
            appServerDetail = "クリップメモジョブを実行する前にタイムラインのクリップを選択してください。"
            return
        }
        guard let activeSession, let activeThreadID else {
            editorAnnotationStatus = "Codexに相談する前にエージェントセッションを開始してください。"
            appServerDetail = "クリップメモジョブを実行する前にエージェントセッションを開始してください。"
            return
        }

        let agentJob = job ?? .clipAnnotation
        let prompt = agentJob.prompt(
            project: selectedProject,
            repositoryRoot: repositoryRoot,
            selection: selection,
            timeline: timeline,
            evidence: selectedClipEvidence,
            existingNote: selectedClipNote
        )
        let clipID = selection.clip.id
        appServerStatus = .checking
        editorAnnotationStatus = "Codexが編集者向けメモを提案しています..."
        turnStatus = "アノテーション提案を実行中..."
        let startedAt = Date()

        Task {
            do {
                let summary = try await Task.detached(priority: .userInitiated) {
                    try activeSession.runTurnAndWait(
                        threadID: activeThreadID,
                        text: prompt,
                        readOnly: true,
                        timeout: 180
                    )
                }.value
                appServerStatus = summary.status == "completed" ? .ready : .failed
                turnStatus = "ターン \(summary.turnId): \(localizedRunStatus(summary.status))"
                turnTranscript = summary.assistantText
                if let proposal = ProjectEditorAnnotationProposal.extract(from: summary.assistantText, expectedClipID: clipID) {
                    selectedClipNoteDraft = proposal.note
                    selectedClipHandoffInstructionDraft = proposal.handoffInstruction
                    editorAnnotationStatus = "\(clipID) の下書きへCodex提案を反映しました。保存すると書き込まれます。"
                } else {
                    editorAnnotationStatus = "\(clipID) の解析可能な提案はCodexから返りませんでした。"
                }

                let record = AgentTurnRecord(
                    turnID: summary.turnId,
                    title: job?.title ?? "アノテーション提案",
                    projectName: selectedProject.name,
                    status: summary.status,
                    readOnly: true,
                    approvedWrite: false,
                    plannedWriteScopes: job?.plannedWriteScopes ?? [],
                    engineStatus: nil,
                    assistantText: summary.assistantText,
                    events: summary.events,
                    eventMethods: summary.eventMethods,
                    artifactDiffs: [],
                    writeViolations: [],
                    startedAt: startedAt,
                    durationMs: summary.durationMs
                )
                turnHistory.insert(record, at: 0)
                selectedTurnID = record.id
            } catch {
                appServerStatus = .failed
                turnStatus = "アノテーション提案に失敗しました"
                editorAnnotationStatus = "Codex提案に失敗しました: \(error)"
            }
        }
    }

    private func loadEditorAnnotations(project: ProjectSummary, timeline: TimelineDocument?) {
        editorAnnotations = ProjectEditorAnnotationStore.load(projectURL: project.path)
        editorAnnotationSummary = ProjectEditorAnnotationStore.summary(projectURL: project.path, timeline: timeline)
        editorAnnotationStatus = editorAnnotationSummary?.statusLabel ?? "編集者アノテーションはありません。"
        loadSelectedClipNoteDraft()
    }

    private func loadSelectedClipNoteDraft() {
        guard let clipID = selectedTimelineClipID else {
            selectedClipNoteDraft = ""
            selectedClipHandoffInstructionDraft = ""
            return
        }
        let note = editorAnnotations?.note(for: clipID)
        selectedClipNoteDraft = note?.note ?? ""
        selectedClipHandoffInstructionDraft = note?.handoffInstruction ?? ""
    }

    private func refreshLibraryReadiness(projectURL: URL) {
        libraryReadinessStatus = ProjectLibraryReadinessStatusReader.status(projectURL: projectURL)
        audioStoryGraphRunPlan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: projectURL)
        intentAlignmentStatus = ProjectIntentAlignmentStatusReader.status(projectURL: projectURL)
        reviewArtifactStatus = ProjectReviewArtifactStatusReader.status(projectURL: projectURL)
        qaDashboard = QADashboardDocument.load(projectURL: projectURL)
        pipelineGateStatus = ProjectPipelineGateStatusReader.status(repositoryRoot: repositoryRoot, projectURL: projectURL)
        studioReadinessStatus = ProjectStudioReadinessStatusReader.status(repositoryRoot: repositoryRoot, projectURL: projectURL)
        studioGoalStatus = makeStudioGoalStatus(projectURL: projectURL)
    }

    func scrubPlayhead(to frame: Int) {
        clearTimelineSkimPreview()
        pausePlayback()
        setPlayheadFrame(frame, forceSeek: true)
    }

    func jumpToQATimestamp(_ timestampSec: Double) {
        guard let timeline else { return }
        pausePlayback()
        let target = timeline.qaTimestampJumpTarget(for: timestampSec)
        setPlayheadFrame(target.frame, forceSeek: true)
        setTimelineClipSelection(
            primary: target.clipID,
            ids: TimelineClipSelectionPublishing.singleSelectionIDs(primaryID: target.clipID)
        )
        requestTimelinePlayheadReveal()
    }

    func togglePlayback() {
        isPlaying ? pausePlayback() : startPlayback()
    }

    var playbackRate: Double {
        TimelinePlaybackShuttle.signedRate(
            isPlaying: isPlaying,
            direction: playbackDirection,
            speed: playbackSpeed
        )
    }

    var playbackRateLabel: String? {
        guard isPlaying else { return nil }
        let directionLabel = playbackDirection == .reverse ? "逆再生" : "再生"
        return "\(directionLabel) \(formattedPlaybackSpeed)x"
    }

    var activePlaybackLoopRange: TimelinePlaybackRange? {
        guard isLoopPlaybackEnabled, sourceMonitorAssetID == nil, let timeline else { return nil }
        return TimelinePlaybackLoop.normalizedRange(playbackLoopRange, totalFrames: timeline.totalFrames)
    }

    var playbackLoopLabel: String? {
        guard let timeline, let range = TimelinePlaybackLoop.normalizedRange(playbackLoopRange, totalFrames: timeline.totalFrames) else {
            return nil
        }
        let prefix = isLoopPlaybackEnabled ? "ループ" : "範囲"
        return "\(prefix) \(timeline.sequence.framesToTimecode(range.startFrame))-\(timeline.sequence.framesToTimecode(range.endFrame))"
    }

    func toggleMonitorAudioMute() {
        monitorAudioMuted.toggle()
    }

    func setMonitorAudioVolume(_ volume: Double) {
        let nextVolume = MonitorAudioPublishing.clampedVolume(volume)
        if MonitorAudioPublishing.shouldPublishVolume(previous: monitorAudioVolume, next: nextVolume) {
            monitorAudioVolume = nextVolume
        }
        if MonitorAudioPublishing.shouldClearMute(previousMuted: monitorAudioMuted, volume: nextVolume) {
            monitorAudioMuted = false
        }
    }

    func startPlayback() {
        startPlayback(direction: .forward, speed: 1)
    }

    func playForwardShuttle() {
        startPlayback(direction: .forward, speed: nextShuttleSpeed(for: .forward))
    }

    func playReverseShuttle() {
        startPlayback(direction: .reverse, speed: nextShuttleSpeed(for: .reverse))
    }

    private func startPlayback(direction: TimelinePlaybackDirection, speed: Double) {
        guard let timeline else { return }
        clearTimelineSkimPreview()
        clearSourceBinSkimPreview()
        if let loopRange = activePlaybackLoopRange {
            let preparedFrame = TimelinePlaybackLoop.preparedStartFrame(
                currentFrame: playheadFrame,
                direction: direction,
                range: loopRange
            )
            if preparedFrame != playheadFrame {
                setPlayheadFrame(preparedFrame, forceSeek: true)
            }
        }
        if direction == .forward, playheadFrame >= timeline.totalFrames {
            setPlayheadFrame(0, forceSeek: true)
        }
        if direction == .reverse, playheadFrame <= 0, activePlaybackLoopRange == nil {
            roughCutCompileStatus = "先頭にいるため逆再生できません。J/Lで方向、Kで停止します。"
            pausePlayback()
            return
        }
        playbackAnchorFrame = playheadFrame
        playbackAnchorDate = Date()
        publishPlaybackDirection(direction)
        publishPlaybackSpeed(TimelinePlaybackTransportPublishing.clampedSpeed(speed))
        publishPlaying(true)
        playbackTimer?.invalidate()
        let interval = 1.0 / min(max(timeline.sequence.fps, 1), 60)
        playbackTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                self.advancePlaybackTick()
            }
        }
    }

    func pausePlayback() {
        publishPlaying(false)
        publishPlaybackSpeed(0)
        playbackTimer?.invalidate()
        playbackTimer = nil
        playbackAnchorDate = nil
    }

    private func publishPlaybackDirection(_ direction: TimelinePlaybackDirection) {
        guard TimelinePlaybackTransportPublishing.shouldPublishDirection(
            previous: playbackDirection,
            next: direction
        ) else { return }
        playbackDirection = direction
    }

    private func publishPlaybackSpeed(_ speed: Double) {
        guard TimelinePlaybackTransportPublishing.shouldPublishSpeed(
            previous: playbackSpeed,
            next: speed
        ) else { return }
        playbackSpeed = speed
    }

    private func publishPlaying(_ playing: Bool) {
        guard TimelinePlaybackTransportPublishing.shouldPublishPlaying(
            previous: isPlaying,
            next: playing
        ) else { return }
        isPlaying = playing
    }

    func stepBackward() {
        if sourceMonitorAssetID != nil {
            stepSourceMonitor(byFrames: -1)
            return
        }
        pausePlayback()
        guard timeline != nil else { return }
        setPlayheadFrame(max(0, playheadFrame - 1), forceSeek: true)
    }

    func stepForward() {
        if sourceMonitorAssetID != nil {
            stepSourceMonitor(byFrames: 1)
            return
        }
        pausePlayback()
        guard let timeline else { return }
        setPlayheadFrame(min(timeline.totalFrames, playheadFrame + 1), forceSeek: true)
    }

    func jumpToPreviousTimelineEditPoint() {
        jumpToTimelineEditPoint(direction: .previous)
    }

    func jumpToNextTimelineEditPoint() {
        jumpToTimelineEditPoint(direction: .next)
    }

    private func jumpToTimelineEditPoint(direction: TimelineEditPointNavigationDirection) {
        guard let timeline else {
            roughCutCompileStatus = "編集点へ移動する前にタイムラインを生成してください。"
            return
        }
        guard let plan = TimelineEditPointNavigationPlan.make(
            timeline: timeline,
            playheadFrame: playheadFrame,
            direction: direction
        ) else {
            let directionLabel = direction == .next ? "次" : "前"
            roughCutCompileStatus = "\(directionLabel)に移動できる編集点がありません。"
            return
        }

        clearSourceMonitorAsset(updateStatus: false)
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        timelineDragTrimViewerPreview = nil
        timelineRollTrimViewerPreview = nil
        timelineSlipTrimViewerPreview = nil
        timelineSkimPreview = nil
        sourceBinSkimPreview = nil
        pausePlayback()
        setPlayheadFrame(plan.frame, forceSeek: true)
        requestTimelinePlayheadReveal()
        roughCutCompileStatus = plan.statusMessage
    }

    private func requestTimelinePlayheadReveal() {
        timelinePlayheadRevealRequest &+= 1
    }

    private func advancePlaybackTick() {
        guard let timeline else {
            pausePlayback()
            return
        }
        guard timeline.totalFrames > 0 else {
            pausePlayback()
            return
        }
        if playbackDirection == .forward, playheadFrame >= timeline.totalFrames {
            pausePlayback()
            return
        }
        if playbackDirection == .reverse, playheadFrame <= 0 {
            pausePlayback()
            return
        }
        let elapsed = playbackAnchorDate.map { max(0, Date().timeIntervalSince($0)) } ?? 0
        let elapsedFrames = Int((elapsed * timeline.sequence.fps * max(playbackSpeed, 1)).rounded(.down))
        guard elapsedFrames > 0 else { return }
        let signedDelta = playbackDirection == .reverse ? -elapsedFrames : elapsedFrames
        let nextFrame = playbackAnchorFrame + signedDelta
        let needsSeekedPlayback = playbackDirection == .reverse || playbackSpeed != 1
        if let loopRange = activePlaybackLoopRange,
           let loopedFrame = TimelinePlaybackLoop.loopedFrame(
            proposedFrame: nextFrame,
            direction: playbackDirection,
            range: loopRange
           ) {
            setPlayheadFrame(loopedFrame, forceSeek: true)
            playbackAnchorFrame = loopedFrame
            playbackAnchorDate = Date()
            return
        }
        setPlayheadFrame(nextFrame, forceSeek: needsSeekedPlayback)
        if playheadFrame <= 0 || playheadFrame >= timeline.totalFrames {
            pausePlayback()
        }
    }

    private func nextShuttleSpeed(for direction: TimelinePlaybackDirection) -> Double {
        TimelinePlaybackShuttle.nextSpeed(
            isPlaying: isPlaying,
            currentDirection: playbackDirection,
            currentSpeed: playbackSpeed,
            requestedDirection: direction
        )
    }

    private var formattedPlaybackSpeed: String {
        let speed = max(playbackSpeed, 1)
        if speed.rounded() == speed {
            return String(Int(speed))
        }
        return String(format: "%.1f", speed)
    }

    func setLoopPlaybackRangeToSelectedClip() {
        guard let timeline else {
            roughCutCompileStatus = "タイムラインがないためループ範囲を設定できません。"
            return
        }
        guard sourceMonitorAssetID == nil else {
            roughCutCompileStatus = "ソース確認中です。タイムラインへ戻ってからループ範囲を設定してください。"
            return
        }

        if let transition = selectedTimelineTransition {
            guard let range = TimelinePlaybackLoop.transitionReviewRange(timeline: timeline, transition: transition) else {
                roughCutCompileStatus = "選択トランジションの周辺をループ範囲にできません。隣接した映像編集点を選択してください。"
                return
            }
            setPlaybackLoopRange(range)
            let label = "\(timeline.sequence.framesToTimecode(range.startFrame))-\(timeline.sequence.framesToTimecode(range.endFrame))"
            roughCutCompileStatus = "\(transition.transitionType) \(transition.fromClipID) → \(transition.toClipID) 周辺をループ範囲に設定しました（\(label)）。Rでオン/オフできます。"
            return
        }

        let selectedClipIDs = activeSelectedTimelineClipIDs()
        let selections = selectedClipIDs.compactMap { timeline.clipSelection(for: $0) }
        guard !selections.isEmpty else {
            roughCutCompileStatus = "ループ範囲にするクリップまたはトランジションをタイムラインで選択してください。"
            return
        }
        let clips = selections.map(\.clip)
        guard let range = TimelinePlaybackLoop.range(covering: clips) else {
            roughCutCompileStatus = "選択範囲の尺がないためループ範囲を設定できません。"
            return
        }
        setPlaybackLoopRange(range)
        let label = "\(timeline.sequence.framesToTimecode(range.startFrame))-\(timeline.sequence.framesToTimecode(range.endFrame))"
        let selectionLabel = clips.count == 1 ? clips[0].id : "\(clips.count)件の選択クリップ"
        roughCutCompileStatus = "\(selectionLabel) をループ範囲に設定しました（\(label)）。Rでオン/オフ、解除はコマンド検索から実行できます。"
    }

    private func setPlaybackLoopRange(_ range: TimelinePlaybackRange) {
        publishPlaybackLoopRange(range)
        publishLoopPlaybackEnabled(true)
        if !range.contains(playheadFrame) {
            setPlayheadFrame(range.startFrame, forceSeek: true)
        }
    }

    func toggleLoopPlayback() {
        if playbackLoopRange == nil {
            setLoopPlaybackRangeToSelectedClip()
            return
        }
        guard let timeline else {
            clearPublishedPlaybackLoopState()
            roughCutCompileStatus = "タイムラインがないためループ範囲を解除しました。"
            return
        }
        guard TimelinePlaybackLoop.normalizedRange(playbackLoopRange, totalFrames: timeline.totalFrames) != nil else {
            clearPublishedPlaybackLoopState()
            roughCutCompileStatus = "有効なループ範囲がないため解除しました。"
            return
        }
        let nextEnabled = !isLoopPlaybackEnabled
        publishLoopPlaybackEnabled(nextEnabled)
        roughCutCompileStatus = nextEnabled ? "ループ再生をオンにしました。" : "ループ再生をオフにしました。範囲は保持しています。"
    }

    func clearLoopPlaybackRange() {
        clearPublishedPlaybackLoopState()
        roughCutCompileStatus = "ループ範囲を解除しました。"
    }

    private func clearPublishedPlaybackLoopState() {
        publishPlaybackLoopRange(nil)
        publishLoopPlaybackEnabled(false)
    }

    private func publishPlaybackLoopRange(_ range: TimelinePlaybackRange?) {
        guard TimelinePlaybackLoopPublishing.shouldPublishRange(
            previous: playbackLoopRange,
            next: range
        ) else { return }
        playbackLoopRange = range
    }

    private func publishLoopPlaybackEnabled(_ enabled: Bool) {
        guard TimelinePlaybackLoopPublishing.shouldPublishEnabled(
            previous: isLoopPlaybackEnabled,
            next: enabled
        ) else { return }
        isLoopPlaybackEnabled = enabled
    }

    private func setPlayheadFrame(_ frame: Int, forceSeek: Bool) {
        timelineSkimPreview = nil
        sourceBinSkimPreview = nil
        let maxFrame = timeline?.totalFrames ?? max(frame, 0)
        let nextFrame = max(0, min(frame, maxFrame))
        playheadFrame = nextFrame
        let nextGeneration = playbackSyncState.update(currentClipID: mediaSyncClipID(atFrame: nextFrame), forceSeek: forceSeek)
        if nextGeneration != mediaPlaybackSyncGeneration {
            mediaPlaybackSyncGeneration = nextGeneration
        }
        let audioClipID = timeline?.audioProgramSelection(atFrame: nextFrame)?.clip.id
        let nextAudioGeneration = audioPlaybackSyncState.update(currentClipID: audioClipID, forceSeek: forceSeek)
        if nextAudioGeneration != audioPlaybackSyncGeneration {
            audioPlaybackSyncGeneration = nextAudioGeneration
        }
    }

    private func mediaSyncClipID(atFrame frame: Int) -> TimelineClip.ID? {
        if shouldUseTimelinePreviewPlayback && timelinePreviewCovers(frame: frame) {
            return timelinePreviewSyncClipID
        }
        return timeline?.programSelection(atFrame: frame)?.clip.id
    }

    private func timelinePreviewCovers(frame: Int) -> Bool {
        guard timelinePreviewDiagnostics.hasTimeline,
              timelinePreviewDiagnostics.previewMediaFilename != nil
        else {
            return false
        }
        guard let duration = timelinePreviewDiagnostics.previewDurationSeconds,
              duration.isFinite,
              let timeline
        else {
            return true
        }
        let seconds = timeline.sequence.framesToSeconds(frame)
        if seconds <= duration + 0.25 {
            return true
        }
        guard let selectedProject else { return false }
        return ProjectMediaResolver.resolveTimelinePreview(
            projectURL: selectedProject.path,
            playheadSeconds: seconds
        ) != nil
    }

    func checkAppServer() {
        guard appServerStatus != .checking else { return }
        let plan = preferredAppServerLaunchPlan()
        appServerStatus = .checking
        appServerDetail = "Starting Codex App Server over \(plan.displayName)..."

        Task {
            do {
                let response = try await Task.detached(priority: .userInitiated) {
                    let session = CodexAppServerSession(
                        launchPlan: plan,
                        requestFactory: CodexAppServerRequestFactory(workspace: plan.workspace)
                    )
                    defer { session.stop() }
                    try session.start()
                    return try session.initialize(timeout: 15)
                }.value

                appServerStatus = .ready
                appServerDetail = "\(response.platformOs) / \(response.userAgent)"
            } catch {
                appServerStatus = .failed
                appServerDetail = "\(error)"
            }
        }
    }

    func startAgentSession() {
        startAgentSession(afterStart: nil)
    }

    private func startAgentSession(afterStart: (@MainActor () -> Void)?) {
        guard appServerStatus != .checking else { return }
        let plan = preferredAppServerLaunchPlan()
        appServerStatus = .checking
        appServerDetail = "Starting a Codex thread over \(plan.displayName)..."

        Task {
            do {
                let result = try await Task.detached(priority: .userInitiated) {
                    let session = CodexAppServerSession(
                        launchPlan: plan,
                        requestFactory: CodexAppServerRequestFactory(workspace: plan.workspace)
                    )
                    try session.start()
                    _ = try session.initialize(timeout: 15)
                    let thread = try session.startThread(ephemeral: false, timeout: 20)
                    return (session, thread)
                }.value

                activeSession?.stop()
                activeSession = result.0
                activeThreadID = result.1.thread.id
                activeModel = result.1.model
                appServerStatus = .ready
                appServerDetail = "Thread \(result.1.thread.id) / \(result.1.model)"
                afterStart?()
            } catch {
                appServerStatus = .failed
                appServerDetail = "\(error)"
            }
        }
    }

    private func preferredAppServerLaunchPlan() -> CodexAppServerLaunchPlan {
        let plan = CodexAppServerTransportPreferences.launchPlan(workspace: repositoryRoot)
        appServerPlan = plan
        return plan
    }

    func stopAgentSession() {
        activeSession?.stop()
        activeSession = nil
        activeThreadID = nil
        activeModel = nil
        appServerStatus = .unchecked
        appServerDetail = "Agent session stopped."
        turnStatus = "アクティブなセッションがありません。"
    }

    func runAgentTurn() {
        runPromptTurn(agentPrompt, readOnly: true, job: nil, project: selectedProject, approvedWrite: false)
    }

    func runSelectedJob() {
        guard let selectedProject else {
            appServerStatus = .failed
            appServerDetail = "ジョブを実行する前にプロジェクトを選択してください。"
            return
        }
        guard selectedJobReadiness.canRun else {
            turnStatus = selectedJobReadiness.label
            return
        }
        if selectedJob == .clipAnnotation {
            runSelectedClipAnnotationProposal(job: selectedJob)
            return
        }
        let activeRAGContext = indexContextPack.isEmpty ? nil : indexContextPack
        let prompt = selectedJob.prompt(project: selectedProject, repositoryRoot: repositoryRoot, ragContext: activeRAGContext)
        if selectedJob.requiresOperatorApproval {
            pendingApproval = AgentJobApproval(job: selectedJob, project: selectedProject, prompt: prompt, ragContext: activeRAGContext)
            turnStatus = "\(localizedAgentJobTitle(selectedJob))にはオペレーター承認が必要です。\(activeAgentRAGContextSummary)"
            return
        }
        runPromptTurn(prompt, readOnly: selectedJob.readOnly, job: selectedJob, project: selectedProject, approvedWrite: false)
    }

    func runReviewAgentJob() {
        selectSurface(.review)
        selectedJob = .review
        runSelectedJob()
    }

    func selectSurface(_ surface: StudioAgentSurface) {
        guard StudioAgentSurfacePublishing.shouldPublish(
            previous: selectedSurface,
            next: surface
        ) else { return }

        selectedSurface = surface
    }

    var selectedProductStage: StudioProductStage {
        StudioProductStage.stage(for: selectedSurface)
    }

    func selectProductStage(_ stage: StudioProductStage) {
        let surface = stage.preferredSurface(analysisReady: planningStatus.analysisReady)
        selectSurface(surface)
        switch surface {
        case .triage:
            selectedJob = .triage
        case .blueprint:
            selectedJob = .blueprint
        case .compile:
            selectedJob = .compile
        case .review:
            selectedJob = .review
        case .package:
            selectedJob = .render
        case .ingest, .intent:
            break
        }
    }

    func performStudioReadinessAction(_ action: ProjectStudioReadinessAction) {
        selectSurface(surface(for: action))
        guard selectedProject != nil || action.id == "codex-runtime" || action.id == "marlin-default" else {
            studioReadinessActionStatus = "\(action.title) を実行する前にプロジェクトを選択してください。"
            return
        }

        guard let command = action.command else {
            studioReadinessActionStatus = "\(action.title) のパネルを開き、不足しているプロジェクト入力を完了してください。"
            return
        }

        switch command {
        case let value where value.contains("app-server-smoke"):
            studioReadinessActionStatus = "Codex App Serverを確認しています..."
            checkAppServer()
        case let value where value.contains("analysis-run"):
            studioReadinessActionStatus = "素材解析を実行しています..."
            runSelectedProjectAnalysis()
        case let value where value.contains("index-rebuild"):
            studioReadinessActionStatus = "素材/RAGインデックスを再構築しています..."
            rebuildSelectedProjectIndex()
        case let value where value.contains("media-relink-plan"):
            if value.contains("--from-source-map") {
                studioReadinessActionStatus = "素材マップの候補フォルダから再リンクしています..."
                relinkSelectedProjectMediaFromSourceMap()
            } else {
                studioReadinessActionStatus = "未リンク素材の再接続画面を開いています..."
                chooseAndRelinkSelectedProjectMedia()
            }
        case let value where value.contains("media-proxy-build"):
            studioReadinessActionStatus = "プレビュー用プロキシを作成しています..."
            buildSelectedProjectMediaProxies()
        case let value where value.contains("audio-story"):
            studioReadinessActionStatus = "音声ストーリー根拠を作成しています..."
            buildSelectedProjectAudioStoryGraph()
        case let value where value.contains("marlin-materialize"):
            studioReadinessActionStatus = "既存のMarlin根拠を反映しています..."
            materializeSelectedProjectMarlinEvidence()
        case let value where value.contains("marlin-eval-run"):
            studioReadinessActionStatus = "Marlin temporal VLM評価を実行しています..."
            runSelectedProjectMarlinEvaluation()
        case let value where value.contains("marlin-eval-next"):
            studioReadinessActionStatus = "次のMarlin temporal VLM評価を実行しています..."
            runNextMarlinEvaluation()
        case let value where value.contains("marlin-preference-apply"):
            studioReadinessActionStatus = "Marlin優先のtemporal VLMポリシーを適用しています..."
            applyMarlinPreferencePolicy()
        case let value where value.contains("marlin-representative-plan"):
            refreshMarlinRepresentativePlan()
        case let value where value.contains("agent-prompt"):
            runAgentJob(fromReadinessCommand: value, action: action)
        case let value where value.contains("compile-run"):
            studioReadinessActionStatus = value.contains("--review-patch")
                ? "レビュー修正を確定的コンパイラで反映しています..."
                : "粗編集タイムラインを生成しています..."
            if value.contains("--review-patch") {
                compileSelectedProjectWithReviewPatch()
            } else {
                compileSelectedProjectRoughCut()
            }
        case let value where value.contains("handoff-export-packet"):
            studioReadinessActionStatus = "編集者パケットを書き出しています..."
            exportSelectedProjectEditorPacket()
        case let value where value.contains("handoff-packet-status"):
            refresh()
            studioReadinessActionStatus = "編集者パケットの準備状況を更新しました。"
        case let value where value.contains("render-run"):
            studioReadinessActionStatus = "最終レンダー/パッケージを実行しています..."
            runSelectedProjectRender()
        case let value where value.contains("render-status") || value.contains("gate-status") || value.contains("library-status"):
            refresh()
            studioReadinessActionStatus = "Studioの準備状況を更新しました。"
        default:
            studioReadinessActionStatus = "このコマンドに対応するGUI実行はありません: \(command)"
        }
    }

    func copyStudioReadinessActionCommand(_ action: ProjectStudioReadinessAction) {
        guard let command = action.command else {
            studioReadinessActionStatus = "\(action.title) にはコピーできるCLIコマンドがありません。"
            return
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        studioReadinessActionStatus = "\(action.title) のコマンドをコピーしました。"
    }

    func canPerformStudioReadinessAction(_ action: ProjectStudioReadinessAction) -> Bool {
        guard selectedProject != nil || action.id == "codex-runtime" || action.id == "marlin-default" else {
            return false
        }
        guard let command = action.command else {
            return false
        }
        if command.contains("app-server-smoke") {
            return appServerStatus != .checking
        }
        if command.contains("analysis-run") {
            return !isRunningAnalysis && analysisRunPlan.canRun
        }
        if command.contains("index-rebuild") {
            return selectedProject != nil
        }
        if command.contains("media-relink-plan") {
            if command.contains("--from-source-map"), let selectedProject {
                return !isRelinkingMedia && !ProjectMediaRelinker.availableSuggestedSearchRoots(projectURL: selectedProject.path).isEmpty
            }
            return selectedProject != nil && !isRelinkingMedia
        }
        if command.contains("media-proxy-build") {
            return !isBuildingMediaProxies && mediaProxyPlan.pendingCount > 0
        }
        if command.contains("audio-story") {
            return !isBuildingAudioStoryGraph && audioStoryGraphRunPlan.canRun
        }
        if command.contains("marlin-materialize") {
            guard let selectedProject else { return false }
            let plan = ProjectMarlinMaterializationPlanner.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path)
            return !isRunningMarlinEvaluation && plan.canRun
        }
        if command.contains("marlin-eval-run") {
            return !isRunningMarlinEvaluation
                && marlinEvaluationRunPlan.canRun
                && marlinRuntimeStatus.isReadyForLiveMarlin
                && marlinModelAccessStatus.isReadyForLiveMarlin
        }
        if command.contains("marlin-eval-next") {
            let hasEvaluationCandidate = marlinEvaluationQueue.items.contains {
                $0.canRunEvaluation && !$0.canPreferMarlin && !$0.needsSegmentMaterialization
            }
            return !isRunningMarlinEvaluation
                && hasEvaluationCandidate
                && marlinRuntimeStatus.isReadyForLiveMarlin
                && marlinModelAccessStatus.isReadyForLiveMarlin
        }
        if command.contains("marlin-preference-apply") {
            return marlinPreferenceDecision.canPreferMarlinAsDefault
        }
        if command.contains("marlin-representative-plan") {
            return true
        }
        if command.contains("agent-prompt") {
            return appServerStatus != .checking
        }
        if command.contains("compile-run") {
            return !isCompilingRoughCut && roughCutCompilePlan.canRun
        }
        if command.contains("handoff-export-packet") {
            return !isExportingEditorPacket && (editorPacketPlan?.canExportPacket ?? false)
        }
        if command.contains("render-run") {
            return !isRunningRender && renderRunPlan.canRun
        }
        return command.contains("status")
    }

    func studioReadinessActionDisabledReason(_ action: ProjectStudioReadinessAction) -> String? {
        guard selectedProject != nil || action.id == "codex-runtime" || action.id == "marlin-default" else {
            return "プロジェクト未選択"
        }
        guard let command = action.command else {
            return "手動入力が必要"
        }
        if command.contains("agent-prompt"), activeThreadID == nil { return nil }
        if command.contains("analysis-run"), !analysisRunPlan.canRun {
            return localizedStudioLabel(analysisRunPlan.readinessLabel)
        }
        if command.contains("audio-story"), !audioStoryGraphRunPlan.canRun {
            return localizedStudioLabel(audioStoryGraphRunPlan.readinessLabel)
        }
        if command.contains("marlin-materialize"), let selectedProject {
            let plan = ProjectMarlinMaterializationPlanner.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path)
            if !plan.canRun {
                return localizedStudioLabel(plan.readinessLabel)
            }
        }
        if command.contains("marlin-eval-run"), !marlinEvaluationRunPlan.canRun {
            return localizedStudioLabel(marlinEvaluationRunPlan.readinessLabel)
        }
        if (command.contains("marlin-eval-run") || command.contains("marlin-eval-next")), !marlinRuntimeStatus.isReadyForLiveMarlin {
            return localizedStudioLabel(marlinRuntimeStatus.readinessLabel)
        }
        if (command.contains("marlin-eval-run") || command.contains("marlin-eval-next")), !marlinModelAccessStatus.isReadyForLiveMarlin {
            return localizedStudioLabel(marlinModelAccessStatus.readinessLabel)
        }
        if command.contains("marlin-eval-next"),
           !marlinEvaluationQueue.items.contains(where: { $0.canRunEvaluation && !$0.canPreferMarlin && !$0.needsSegmentMaterialization }) {
            return localizedStudioLabel(marlinEvaluationQueue.readinessLabel)
        }
        if command.contains("marlin-preference-apply"), !marlinPreferenceDecision.canPreferMarlinAsDefault {
            return localizedStudioLabel(marlinPreferenceDecision.decisionLabel)
        }
        if command.contains("media-relink-plan"), command.contains("--from-source-map"), let selectedProject {
            let suggestions = ProjectMediaRelinker.suggestedSearchRoots(projectURL: selectedProject.path)
            if suggestions.isEmpty {
                return "候補フォルダがありません"
            }
            if suggestions.allSatisfy({ !$0.exists }) {
                return "素材ボリュームがマウントされていません"
            }
        }
        if command.contains("compile-run"), !roughCutCompilePlan.canRun {
            return localizedStudioLabel(roughCutCompilePlan.readinessLabel)
        }
        if command.contains("handoff-export-packet"), editorPacketPlan?.canExportPacket != true {
            return editorPacketPlan.map { localizedStudioLabel($0.readinessLabel) } ?? "未準備"
        }
        if command.contains("render-run"), !renderRunPlan.canRun {
            return localizedStudioLabel(renderRunPlan.readinessLabel)
        }
        if !canPerformStudioReadinessAction(action) {
            return "実行中"
        }
        return nil
    }

    private func runAgentJob(fromReadinessCommand command: String, action: ProjectStudioReadinessAction) {
        guard let job = agentJob(fromReadinessCommand: command) else {
            studioReadinessActionStatus = "\(action.title) に対応するCodexジョブがありません。"
            return
        }
        selectedJob = job
        selectSurface(surface(for: job))
        guard activeThreadID != nil else {
            studioReadinessActionStatus = "\(localizedAgentJobTitle(job))のCodexセッションを開始しています..."
            startAgentSession(afterStart: {
                self.studioReadinessActionStatus = "\(localizedAgentJobTitle(job))のCodex承認ゲートを開いています。\(self.activeAgentRAGContextSummary)"
                self.runSelectedJob()
            })
            return
        }
        studioReadinessActionStatus = "\(localizedAgentJobTitle(job))のCodex承認ゲートを開いています。\(activeAgentRAGContextSummary)"
        runSelectedJob()
    }

    func studioReadinessActionButtonTitle(_ action: ProjectStudioReadinessAction) -> String {
        guard let command = action.command else { return "開く" }
        if command.contains("agent-prompt"), activeThreadID == nil {
            return "開始して実行"
        }
        return action.isBlocking ? "実行" : "開く"
    }

    private func refreshMarlinRepresentativePlan() {
        marlinPreferenceDecision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: repositoryRoot)
        marlinEvaluationQueue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: repositoryRoot)
        marlinRepresentativePlan = ProjectMarlinRepresentativePlanReader.plan(repositoryRoot: repositoryRoot)
        if let selectedProject {
            studioGoalStatus = makeStudioGoalStatus(projectURL: selectedProject.path)
        }
        studioReadinessActionStatus = "代表Marlin評価計画を更新しました: \(marlinRepresentativePlan.coveredBucketCount)/\(marlinRepresentativePlan.targetBucketCount)バケットを網羅。"
    }

    func applyMarlinPreferencePolicy() {
        do {
            let result = try ProjectMarlinPreferenceApplier.apply(repositoryRoot: repositoryRoot, confirm: true)
            marlinPreferenceDecision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: repositoryRoot)
            policyStatus = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: repositoryRoot)
            studioReadinessStatus = selectedProject.map {
                ProjectStudioReadinessStatusReader.status(repositoryRoot: repositoryRoot, projectURL: $0.path)
            } ?? studioReadinessStatus
            studioGoalStatus = selectedProject.map {
                makeStudioGoalStatus(projectURL: $0.path)
            } ?? studioGoalStatus
            marlinEvaluationRunStatus = result.wrotePolicy
                ? "Applied Marlin-first temporal VLM policy: \(result.previousPolicyLabel) -> \(result.nextPolicyLabel)."
                : "Marlin-first temporal VLM policy was already applied."
            studioReadinessActionStatus = marlinEvaluationRunStatus
        } catch {
            marlinEvaluationRunStatus = "Marlin preference apply failed: \(error)"
            studioReadinessActionStatus = marlinEvaluationRunStatus
        }
    }

    private func agentJob(fromReadinessCommand command: String) -> VideoOSAgentJob? {
        if command.contains(" triage") { return .triage }
        if command.contains(" blueprint") { return .blueprint }
        if command.contains(" review") { return .review }
        if command.contains(" render") { return .render }
        if command.contains(" compile") { return .compile }
        return nil
    }

    private func surface(for action: ProjectStudioReadinessAction) -> StudioAgentSurface {
        switch action.id {
        case "material-rag", "marlin-temporal-vlm", "audio-story":
            return .ingest
        case "intent":
            return .intent
        case "planning":
            if let command = action.command, let job = agentJob(fromReadinessCommand: command) {
                return surface(for: job)
            }
            return .triage
        case "rough-cut-review":
            if action.command?.contains("review") == true { return .review }
            return .compile
        case "editor-handoff", "final-render":
            return .package
        default:
            return selectedSurface
        }
    }

    private func surface(for job: VideoOSAgentJob) -> StudioAgentSurface {
        switch job {
        case .triage:
            return .triage
        case .blueprint:
            return .blueprint
        case .compile:
            return .compile
        case .review:
            return .review
        case .render:
            return .package
        case .status, .validate, .clipAnnotation:
            return selectedSurface
        }
    }

    func approvePendingJob() {
        guard let approval = pendingApproval else { return }
        pendingApproval = nil
        runPromptTurn(approval.prompt, readOnly: approval.job.readOnly, job: approval.job, projectID: approval.projectID, projectName: approval.projectName, projectURL: approval.projectURL, approvedWrite: true)
    }

    func cancelPendingJob() {
        guard let approval = pendingApproval else { return }
        pendingApproval = nil
        turnStatus = "\(localizedAgentJobTitle(approval.job))は実行されませんでした。"
    }

    private func runPromptTurn(
        _ prompt: String,
        readOnly: Bool,
        job: VideoOSAgentJob?,
        project: ProjectSummary?,
        approvedWrite: Bool
    ) {
        runPromptTurn(prompt, readOnly: readOnly, job: job, projectID: project?.id, projectName: project?.name, projectURL: project?.path, approvedWrite: approvedWrite)
    }

    private func runPromptTurn(
        _ prompt: String,
        readOnly: Bool,
        job: VideoOSAgentJob?,
        projectID: String? = nil,
        projectName: String?,
        projectURL: URL?,
        approvedWrite: Bool
    ) {
        guard appServerStatus != .checking else { return }
        guard let activeSession, let activeThreadID else {
            appServerStatus = .failed
            appServerDetail = "ターンを実行する前にエージェントセッションを開始してください。"
            return
        }
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty else { return }

        appServerStatus = .checking
        turnStatus = "ターンを実行中..."
        turnTranscript = ""
        let startedAt = Date()
        let turnTitle = job?.title ?? "カスタムプロンプト"
        let resolvedProjectName = projectName ?? selectedProject?.name ?? "リポジトリ"
        let beforeSnapshot: ProjectArtifactSnapshot? = (!readOnly && approvedWrite)
            ? projectURL.flatMap { try? ProjectArtifactSnapshot.capture(projectURL: $0) }
            : nil

        Task {
            do {
                let summary = try await Task.detached(priority: .userInitiated) {
                    try activeSession.runTurnAndWait(
                        threadID: activeThreadID,
                        text: trimmedPrompt,
                        readOnly: readOnly,
                        timeout: readOnly ? 180 : 300
                    )
                }.value
                let engineStatus = try await runApprovedNativeEngineIfNeeded(
                    job: job,
                    approvedWrite: approvedWrite,
                    summary: summary,
                    projectURL: projectURL
                )
                let artifactDiffs = beforeSnapshot.flatMap { before in
                    projectURL
                        .flatMap { try? ProjectArtifactSnapshot.capture(projectURL: $0) }
                        .map { before.diff(to: $0) }
                } ?? []
                let writeViolations = job
                    .map { $0.writeContract(projectID: projectID ?? projectURL?.lastPathComponent ?? "<id>").violations(for: artifactDiffs) } ?? []

                appServerStatus = summary.status == "completed" ? .ready : .failed
                turnStatus = engineStatus.map { "ターン \(summary.turnId): \(localizedRunStatus(summary.status)) / \($0)" }
                    ?? "ターン \(summary.turnId): \(localizedRunStatus(summary.status))"
                turnTranscript = summary.assistantText.isEmpty
                    ? "アシスタント本文はストリーミングされませんでした。イベント: \(summary.eventMethods.joined(separator: ", "))"
                    : summary.assistantText
                let record = AgentTurnRecord(
                    turnID: summary.turnId,
                    title: turnTitle,
                    projectName: resolvedProjectName,
                    status: summary.status,
                    readOnly: readOnly,
                    approvedWrite: approvedWrite,
                    plannedWriteScopes: job?.plannedWriteScopes ?? [],
                    engineStatus: engineStatus,
                    assistantText: summary.assistantText,
                    events: summary.events,
                    eventMethods: summary.eventMethods,
                    artifactDiffs: artifactDiffs,
                    writeViolations: writeViolations,
                    startedAt: startedAt,
                    durationMs: summary.durationMs
                )
                turnHistory.insert(record, at: 0)
                selectedTurnID = record.id
                loadTimelineForSelection()
                if let projectURL {
                    renderPackageStatus = ProjectRenderPackageStatusReader.status(projectURL: projectURL)
                    editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: repositoryRoot, projectURL: projectURL, assets: evidenceStore?.assets)
                    editorPacketStatus = editorPacketPlan?.readinessLabel ?? "編集者パケットは未確認です。"
                    editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                }
            } catch {
                appServerStatus = .failed
                turnStatus = "ターンに失敗しました"
                turnTranscript = "\(error)"
            }
        }
    }

    private func runApprovedNativeEngineIfNeeded(
        job: VideoOSAgentJob?,
        approvedWrite: Bool,
        summary: CodexTurnRunSummary,
        projectURL: URL?
    ) async throws -> String? {
        guard approvedWrite, job == .compile, summary.status == "completed", let projectURL else {
            return nil
        }
        guard let decision = VideoOSAgentEngineDecision.extract(from: summary.assistantText) else {
            return "compile engine not run: missing Codex engine decision"
        }
        guard decision.engineAction == .runCompile else {
            return "コンパイルエンジンを実行しませんでした: \(decision.reason)"
        }

        let plan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: repositoryRoot, projectURL: projectURL)
        guard plan.canRun else {
            return "コンパイルエンジンを実行できません: \(plan.readinessLabel)"
        }

        let result = try await Task.detached(priority: .userInitiated) {
            try ProjectRoughCutCompileRunner.run(plan: plan)
        }.value

        if result.succeeded {
            let docs = result.indexSummary?.searchDocumentCount ?? 0
            return "コンパイルエンジン完了: 検索可能ドキュメント \(docs)件"
        }
        return "コンパイルエンジン失敗: exit \(result.exitCode)"
    }

    func rebuildSelectedProjectIndex() {
        guard let selectedProject else {
            indexOperationStatus = "インデックスを再構築する前にプロジェクトを選択してください。"
            return
        }
        indexOperationStatus = "SQLiteインデックスを再構築しています..."
        let project = selectedProject

        Task {
            do {
                let summary = try await Task.detached(priority: .userInitiated) {
                    try ProjectSQLiteIndex.rebuild(projectURL: project.path)
                }.value
                indexStatus = ProjectSQLiteIndex.status(projectURL: project.path)
                refreshLibraryReadiness(projectURL: project.path)
                indexOperationStatus = "インデックス完了: ドキュメント \(summary.searchDocumentCount)件、素材 \(summary.assetCount)件、セグメント \(summary.segmentCount)件、音声イベント \(summary.audioEventCount)件、音声ノード \(summary.audioStoryNodeCount)件、BGMビート \(summary.bgmBeatCount)件、継続性エンティティ \(summary.continuityEntityCount)件、編集方針 \(summary.editorialPreferenceCount)件。"
                if !indexSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    searchSelectedProjectIndex()
                }
            } catch {
                indexOperationStatus = "インデックス再構築に失敗しました: \(error)"
            }
        }
    }

    func runSelectedProjectAnalysis() {
        guard let selectedProject else {
            analysisRunStatus = "素材解析を実行する前にプロジェクトを選択してください。"
            return
        }

        guard analysisRunPlan.projectURL == selectedProject.path else {
            analysisRunStatus = "素材解析の準備状況を読み込み、準備でき次第実行します..."
            refreshAnalysisRunPlan(projectID: selectedProject.id, projectURL: selectedProject.path, runAfterRefresh: true)
            return
        }

        let plan = analysisRunPlan
        startProjectAnalysis(plan: plan, projectID: selectedProject.id, projectURL: selectedProject.path)
    }

    private func startProjectAnalysis(
        plan: ProjectAnalysisRunPlan,
        projectID: ProjectSummary.ID,
        projectURL: URL
    ) {
        guard plan.canRun else {
            analysisRunStatus = "素材解析を実行できません: \(localizedStudioLabel(plan.readinessLabel))。"
            return
        }

        isRunningAnalysis = true
        analysisRunStatus = "\(plan.sourceCount)件の素材をローカル解析しています..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectAnalysisRunner.run(plan: plan)
                let refreshedPlan = ProjectAnalysisRunPlanner.plan(
                    repositoryRoot: plan.repositoryRoot,
                    projectURL: projectURL,
                    options: plan.options
                )
                await MainActor.run {
                    self.isRunningAnalysis = false
                    guard self.selectedProjectID == projectID else { return }
                    self.evidenceStore = ProjectEvidenceStore.load(projectURL: projectURL)
                    self.analysisRunPlan = refreshedPlan
                    self.planningStatus = ProjectPlanningStatusReader.status(projectURL: projectURL)
                    self.indexStatus = ProjectSQLiteIndex.status(projectURL: projectURL)
                    self.mediaPreviewSummary = ProjectMediaResolver.previewSummary(projectURL: projectURL, assets: self.evidenceStore?.assets)
                    self.mediaSourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: projectURL, assets: self.evidenceStore?.assets)
                    self.mediaProxyPlan = ProjectMediaProxyPlanner.plan(projectURL: projectURL, assets: self.evidenceStore?.assets)
                    self.marlinEvaluationStatus = ProjectMarlinEvaluationStatusReader.status(projectURL: projectURL, repositoryRoot: self.repositoryRoot)
                    self.marlinEvaluationRunPlan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: self.repositoryRoot, projectURL: projectURL, assets: self.evidenceStore?.assets)
                    self.refreshLibraryReadiness(projectURL: projectURL)
                    self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: self.repositoryRoot, projectURL: projectURL, assets: self.evidenceStore?.assets)
                    self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: self.repositoryRoot, projectURL: projectURL, assets: self.evidenceStore?.assets)
                    self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                    self.promoFinishStatus = ProjectPromoFinishStatusReader.status(projectURL: projectURL)
                    self.promoFinishRunPlan = ProjectPromoFinishRunPlanner.plan(repositoryRoot: self.repositoryRoot, projectURL: projectURL)
                    self.promoFinishRunStatus = self.promoFinishRunPlan.canRun
                        ? "宣材用のテロップ仕上げを実行できます。"
                        : "テロップ仕上げはまだ実行できません: \(localizedStudioLabel(self.promoFinishRunPlan.readinessLabel))。"
                    self.mediaPlaybackSyncGeneration += 1
                    self.audioPlaybackSyncGeneration += 1
                    if result.succeeded {
                        let docs = result.indexSummary?.searchDocumentCount ?? self.indexStatus.documentCount
                        self.indexOperationStatus = "解析後にインデックスを更新しました: 検索可能ドキュメント \(docs)件。"
                        self.analysisRunStatus = "ローカル解析が完了しました: 素材 \(result.plan.sourceCount)件。"
                    } else {
                        self.analysisRunStatus = "素材解析に失敗しました: exit \(result.exitCode)。"
                    }
                }
            } catch {
                await MainActor.run {
                    self.isRunningAnalysis = false
                    guard self.selectedProjectID == projectID else { return }
                    self.analysisRunStatus = "素材解析に失敗しました: \(error)"
                }
            }
        }
    }

    func compileSelectedProjectRoughCut() {
        compileSelectedProjectRoughCut(
            options: ProjectRoughCutCompileOptions(),
            statusPrefix: "timeline.jsonを生成しています...",
            activity: .roughCut
        )
    }

    func compileSelectedProjectWithReviewPatch() {
        guard let selectedProject else {
            roughCutCompileStatus = "レビュー修正を反映する前にプロジェクトを選択してください。"
            return
        }
        let patchURL = selectedProject.path.appendingPathComponent("06_review/review_patch.json")
        guard FileManager.default.fileExists(atPath: patchURL.path) else {
            roughCutCompileStatus = "review_patch.json が見つかりません。"
            return
        }
        compileSelectedProjectRoughCut(
            options: ProjectRoughCutCompileOptions(patchURL: patchURL),
            statusPrefix: "review_patch.jsonを反映し、timeline.jsonを再生成しています...",
            activity: .reviewPatch
        )
    }

    func applyStudioPatch() {
        guard let selectedProject else {
            roughCutCompileStatus = "Studio編集を保存する前にプロジェクトを選択してください。"
            return
        }
        guard let timeline else {
            roughCutCompileStatus = "Studio編集を保存する前に粗編集を生成してください。"
            return
        }
        guard feedbackSession.isDirty else {
            roughCutCompileStatus = "保存するStudio編集はありません。"
            return
        }

        let conflicts = feedbackSession.detectConflicts()
        guard conflicts.isEmpty else {
            presentStudioPatchConflictAlert(conflicts)
            roughCutCompileStatus = "Studio修正に競合が \(conflicts.count)件あります。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }

        let envelope = feedbackSession.serialize(projectID: selectedProject.id)
        let projectURL = selectedProject.path
        let timelineURL = TimelineDocument.timelineURL(for: projectURL)
        let preflightPlan = ProjectRoughCutCompilePlanner.plan(
            repositoryRoot: repositoryRoot,
            projectURL: projectURL,
            options: ProjectRoughCutCompileOptions()
        )
        roughCutCompilePlan = preflightPlan
        guard preflightPlan.canRun else {
            roughCutCompileStatus = "Studio編集の保存はまだ実行できません: \(localizedStudioLabel(preflightPlan.readinessLabel))。"
            return
        }
        guard !envelope.patch.operations.isEmpty else {
            roughCutCompileStatus = "コンパイラへ渡すStudio編集はありません。"
            return
        }

        do {
            let currentTimelineHash = try Self.fileHash16(at: timelineURL)
            if !envelope.base_timeline_hash.isEmpty, envelope.base_timeline_hash != currentTimelineHash {
                presentStudioPatchStaleAlert()
                roughCutCompileStatus = "Studio編集が古くなっています。保存前にタイムラインを再読み込みしてください。"
                return
            }

            let reviewDir = projectURL.appendingPathComponent("06_review")
            let historyDir = PatchHistoryIndex.historyDirectory(projectURL: projectURL)
            try FileManager.default.createDirectory(at: reviewDir, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: historyDir, withIntermediateDirectories: true)

            let timestamp = Self.fileTimestamp()
            let patchURL = reviewDir.appendingPathComponent("studio_patch_\(timestamp).json")
            let encoder = Self.studioJSONEncoder()
            try encoder.encode(envelope.patch).write(to: patchURL, options: .atomic)

            let plan = ProjectRoughCutCompilePlanner.plan(
                repositoryRoot: repositoryRoot,
                projectURL: projectURL,
                options: ProjectRoughCutCompileOptions(patchURL: patchURL)
            )
        roughCutCompilePlan = plan
        guard plan.canRun else {
            roughCutCompileStatus = "Studio編集の保存はまだ実行できません: \(localizedStudioLabel(plan.readinessLabel))。"
            Self.cleanupStudioPatchArtifacts(patchURL: patchURL, backupURL: nil)
            return
            }

            var historyIndex = PatchHistoryIndex.load(projectURL: projectURL)
            let backupURL = Self.nextTimelineBackupURL(projectURL: projectURL, historyIndex: historyIndex)
            try FileManager.default.copyItem(at: timelineURL, to: backupURL)

            let patchRelativePath = Self.relativeProjectPath(projectURL: projectURL, url: patchURL)
            let backupRelativePath = Self.relativeProjectPath(projectURL: projectURL, url: backupURL)
            let changedClipIDs = envelope.patch.operations.compactMap(\.changedClipID)
            let uniqueChangedClipIDs = Array(Set(changedClipIDs)).sorted()
            let firstChangedFrame = Self.firstChangedClipFrame(in: timeline, changedClipIDs: uniqueChangedClipIDs)
            let opCount = envelope.patch.operations.count
            let baseHash = envelope.base_timeline_hash
            let createdAt = envelope.created_at
            let source = envelope.source

            isCompilingRoughCut = true
            roughCutCompileActivity = .studioPatch
            roughCutCompileStatus = "表示済みのStudio編集を保存し、プレビューを更新しています..."

            Task {
                do {
                    let (result, resultHash) = try await Task.detached(priority: .userInitiated) {
                        let result = try ProjectRoughCutCompileRunner.run(plan: plan, rebuildIndex: false)
                        let resultHash = try? Self.fileHash16(at: timelineURL)
                        return (result, resultHash)
                    }.value
                    self.isCompilingRoughCut = false
                    self.roughCutCompileActivity = .idle
                    guard result.succeeded else {
                        self.rollbackFailedStudioPatch(
                            patchURL: patchURL,
                            backupURL: backupURL,
                            timelineURL: timelineURL,
                            reason: "Studio編集の保存に失敗しました: exit \(result.exitCode)。"
                        )
                        return
                    }
                    guard let resultHash else {
                        self.rollbackFailedStudioPatch(
                            patchURL: patchURL,
                            backupURL: backupURL,
                            timelineURL: timelineURL,
                            reason: "Studio修正後のタイムラインhashを読み取れませんでした。"
                        )
                        return
                    }
                    historyIndex.append(record: PatchHistoryRecord(
                        patch_path: patchRelativePath,
                        base_timeline_hash: baseHash,
                        result_timeline_hash: resultHash,
                        timeline_backup_path: backupRelativePath,
                        created_at: createdAt,
                        source: source,
                        changed_clip_ids: uniqueChangedClipIDs,
                        op_count: opCount
                    ))
                    do {
                        try historyIndex.save(projectURL: projectURL)
                    } catch {
                        self.rollbackFailedStudioPatch(
                            patchURL: patchURL,
                            backupURL: backupURL,
                            timelineURL: timelineURL,
                            reason: "Studio修正履歴の保存に失敗しました: \(error)。"
                        )
                        return
                    }
                    self.feedbackSession.clearAll()
                    self.setTimelineTransitionSelection(nil)
                    self.feedbackSession.pruneHistory(projectURL: projectURL)
                    self.refresh()
                    self.showChangedClipHighlight(uniqueChangedClipIDs)
                    self.jumpToFirstChangedClip(changedClipIDs: uniqueChangedClipIDs, fallbackFrame: firstChangedFrame)
                    self.roughCutCompileStatus = "タイムラインを更新しました。\(uniqueChangedClipIDs.count)件のクリップが変わりました。"
                    self.indexOperationStatus = "Studioプレビューではインデックス再構築を省略しました。検索文脈が古い場合は再構築してください。"
                } catch {
                    self.isCompilingRoughCut = false
                    self.roughCutCompileActivity = .idle
                    self.rollbackFailedStudioPatch(
                        patchURL: patchURL,
                        backupURL: backupURL,
                        timelineURL: timelineURL,
                        reason: "Studio編集の保存に失敗しました: \(error)。"
                    )
                }
            }
        } catch {
            roughCutCompileStatus = "粗編集生成前にStudio編集の保存が失敗しました: \(error)"
        }
    }

    func undoLastPatch() {
        guard let selectedProject else {
            roughCutCompileStatus = "Studio修正を戻す前にプロジェクトを選択してください。"
            return
        }

        let projectURL = selectedProject.path
        var historyIndex = PatchHistoryIndex.load(projectURL: projectURL)
        guard let record = historyIndex.records.last else {
            roughCutCompileStatus = "戻せるStudio修正履歴はありません。"
            return
        }
        guard record.purged != true else {
            roughCutCompileStatus = "直前のStudio修正バックアップは削除済みのため復元できません。"
            return
        }

        let backupURL = projectURL.appendingPathComponent(record.timeline_backup_path)
        let timelineURL = TimelineDocument.timelineURL(for: projectURL)
        guard FileManager.default.fileExists(atPath: backupURL.path) else {
            roughCutCompileStatus = "直前のStudio修正バックアップが見つかりません。"
            return
        }
        guard !record.result_timeline_hash.isEmpty else {
            roughCutCompileStatus = "安全に戻せません: 反映後タイムラインhashがありません。"
            return
        }

        do {
            let currentTimelineHash = try Self.fileHash16(at: timelineURL)
            guard currentTimelineHash == record.result_timeline_hash else {
                roughCutCompileStatus = "安全に戻せません: timeline.json がStudio外で変更されています。"
                return
            }
            _ = try FileManager.default.replaceItemAt(
                timelineURL,
                withItemAt: backupURL,
                backupItemName: nil,
                options: []
            )
            _ = historyIndex.removeLast()
            try historyIndex.save(projectURL: projectURL)
            feedbackSession.clearAll()
            setTimelineTransitionSelection(nil)
            feedbackSession.loadHistory(projectURL: projectURL)
            refresh()
            clearChangedClipHighlight()
            roughCutCompileStatus = "前のタイムラインへ戻しました。"
        } catch {
            roughCutCompileStatus = "Studio修正の取り消しに失敗しました: \(error)"
        }
    }

    func discardPendingStudioFeedback() {
        feedbackSession.clearAll()
        setTimelineTransitionSelection(nil)
        if reloadSelectedProjectTimelineFromDisk() {
            roughCutCompileStatus = "未保存のStudio編集を破棄し、タイムライン表示を戻しました。"
        }
    }

    @discardableResult
    private func reloadSelectedProjectTimelineFromDisk() -> Bool {
        guard let selectedProject, selectedProject.hasTimeline else {
            timeline = nil
            return true
        }
        do {
            let reloadedTimeline = try TimelineDocument.load(projectURL: selectedProject.path)
            timeline = reloadedTimeline
            reconcileTimelineClipSelection(with: reloadedTimeline)
            loadEditorAnnotations(project: selectedProject, timeline: reloadedTimeline)
            setPlayheadFrame(min(playheadFrame, reloadedTimeline.totalFrames), forceSeek: true)
            loadAudioWaveforms(project: selectedProject, timeline: reloadedTimeline)
            return true
        } catch {
            roughCutCompileStatus = "タイムラインの再読み込みに失敗しました: \(error)"
            return false
        }
    }

    private func rollbackFailedStudioPatch(
        patchURL: URL,
        backupURL: URL,
        timelineURL: URL,
        reason: String
    ) {
        do {
            try Self.restoreTimelineBackup(from: backupURL, to: timelineURL)
            Self.cleanupStudioPatchArtifacts(patchURL: patchURL, backupURL: backupURL)
            refresh()
            roughCutCompileStatus = "\(reason) timeline.jsonはバックアップから復元しました。"
        } catch {
            Self.cleanupStudioPatchArtifacts(patchURL: patchURL, backupURL: nil)
            refresh()
            roughCutCompileStatus = "\(reason) ロールバックにも失敗しました: \(error)。バックアップは \(backupURL.path) に残しています。"
        }
    }

    private func showChangedClipHighlight(_ clipIDs: [String]) {
        changedClipHighlightTimer?.invalidate()
        let uniqueClipIDs = Array(Set(clipIDs)).sorted()
        changedClipIDs = uniqueClipIDs
        guard !uniqueClipIDs.isEmpty else {
            recentlyChangedClipIDs = []
            changedClipHighlightTimer = nil
            return
        }

        recentlyChangedClipIDs = Set(uniqueClipIDs)
        changedClipHighlightTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: false) { [weak self] timer in
            timer.invalidate()
            guard let self else { return }
            Task { @MainActor in
                withAnimation(.easeOut(duration: 5.0)) {
                    self.recentlyChangedClipIDs = []
                }
                self.changedClipHighlightTimer = nil
            }
        }
    }

    private func clearChangedClipHighlight() {
        changedClipHighlightTimer?.invalidate()
        changedClipHighlightTimer = nil
        changedClipIDs = []
        recentlyChangedClipIDs = []
    }

    private func jumpToFirstChangedClip(changedClipIDs: [String], fallbackFrame: Int?) {
        let changedSet = Set(changedClipIDs)
        guard !changedSet.isEmpty else { return }

        let firstChangedClip = timeline?.displayTracks
            .flatMap(\.clips)
            .filter { changedSet.contains($0.id) }
            .sorted { $0.timelineInFrame < $1.timelineInFrame }
            .first

        if let firstChangedClip {
            selectTimelineClip(firstChangedClip.id)
        } else if let fallbackFrame {
            clearTimelineClipSelection()
            setPlayheadFrame(fallbackFrame, forceSeek: true)
        }
    }

    private static func firstChangedClipFrame(in timeline: TimelineDocument, changedClipIDs: [String]) -> Int? {
        let changedSet = Set(changedClipIDs)
        guard !changedSet.isEmpty else { return nil }
        return timeline.displayTracks
            .flatMap(\.clips)
            .filter { changedSet.contains($0.id) }
            .map(\.timelineInFrame)
            .min()
    }

    var canPromoteLatestStudioPatch: Bool {
        guard let selectedProject else { return false }
        let historyIndex = PatchHistoryIndex.load(projectURL: selectedProject.path)
        guard let latestRecord = historyIndex.records.last else { return false }
        let patchURL = selectedProject.path.appendingPathComponent(latestRecord.patch_path)
        guard FileManager.default.fileExists(atPath: patchURL.path) else { return false }
        let plan = ProjectStudioPatchPromotionPlanner.plan(
            repositoryRoot: repositoryRoot,
            projectURL: selectedProject.path,
            patchURL: patchURL
        )
        return plan.canRun && !latestAppliedPromotableOps(projectURL: selectedProject.path, historyIndex: historyIndex).isEmpty
    }

    private func latestAppliedPromotableOps(projectURL: URL, historyIndex: PatchHistoryIndex) -> [ReviewPatchOperation] {
        guard let latestRecord = historyIndex.records.last else { return [] }
        let patchURL = projectURL.appendingPathComponent(latestRecord.patch_path)
        guard
            let data = try? Data(contentsOf: patchURL),
            let patch = try? JSONDecoder().decode(ReviewPatchDocument.self, from: data)
        else {
            return []
        }
        return patch.operations.filter { ["replace_segment", "remove_segment"].contains($0.opName) }
    }

    func promoteStudioPatch() {
        guard let selectedProject else {
            roughCutCompileStatus = "Studio修正を計画へ反映する前にプロジェクトを選択してください。"
            return
        }
        let historyIndex = PatchHistoryIndex.load(projectURL: selectedProject.path)
        guard let latestRecord = historyIndex.records.last else {
            roughCutCompileStatus = "計画へ反映できる適用済みStudio修正はありません。"
            return
        }
        let promotableOps = latestAppliedPromotableOps(projectURL: selectedProject.path, historyIndex: historyIndex)
        guard !promotableOps.isEmpty else {
            roughCutCompileStatus = "直近のStudio修正には計画へ反映できる差し替え/削除操作がありません。"
            return
        }
        let patchURL = selectedProject.path.appendingPathComponent(latestRecord.patch_path)
        let plan = ProjectStudioPatchPromotionPlanner.plan(
            repositoryRoot: repositoryRoot,
            projectURL: selectedProject.path,
            patchURL: patchURL
        )
        guard plan.canRun else {
            roughCutCompileStatus = "Studio修正の計画反映はまだ実行できません: \(localizedStudioLabel(plan.readinessLabel))。"
            return
        }

        roughCutCompileStatus = "Studio修正を計画成果物へ反映しています..."
        Task {
            do {
                let result = try await Task.detached(priority: .userInitiated) {
                    try ProjectStudioPatchPromotionRunner.run(plan: plan)
                }.value
                if result.succeeded, let output = result.output {
                    self.refresh()
                    self.roughCutCompileStatus = "Studio修正を計画へ反映しました。\(output.modified_beat_ids.count)件のビートを更新しました。"
                } else {
                    let detail = result.output?.warnings.joined(separator: " ") ?? result.stderr
                    self.roughCutCompileStatus = "Studio修正の計画反映に失敗しました: \(detail)"
                }
            } catch {
                self.roughCutCompileStatus = "Studio修正の計画反映に失敗しました: \(error)"
            }
        }
    }

    func openSwapBrowser(for clip: TimelineClip) {
        setTimelineClipSelection(primary: clip.id, ids: [clip.id])
        swapBrowserClip = clip
        isSwapBrowserPresented = true
        roughCutCompileStatus = "\(clip.id) の差替え候補を開きました。"
        if candidateDataSource == nil, let selectedProject {
            loadCandidateDataSource(project: selectedProject)
        }
    }

    func openFootageSearch() {
        guard selectedProject != nil else {
            roughCutCompileStatus = "素材検索の前にプロジェクトを選択してください。"
            return
        }
        isFootageSearchPresented = true
        roughCutCompileStatus = "素材検索を開きました。"
    }

    func openFootageSearch(for clip: TimelineClip) {
        setTimelineClipSelection(primary: clip.id, ids: [clip.id])
        swapBrowserClip = clip
        isFootageSearchPresented = true
        roughCutCompileStatus = "\(clip.id) の差替え素材検索を開きました。"
    }

    func previewSourceMonitorAsset(_ assetID: String) {
        guard selectedProject != nil else {
            roughCutCompileStatus = "ソース確認の前にプロジェクトを選択してください。"
            return
        }
        guard let status = mediaPreviewSummary.items.first(where: { $0.assetID == assetID }) else {
            roughCutCompileStatus = "\(assetID) は素材ライブラリにありません。"
            return
        }
        guard status.playbackStatus.isReady else {
            roughCutCompileStatus = "\(assetID) はViewerで再生できません。\(localizedStudioText(status.recommendation))"
            return
        }
        pausePlayback()
        clearTimelineSkimPreview()
        clearSourceBinSkimPreview()
        sourceMonitorAssetID = assetID
        sourceMonitorPlaybackSourceUS = sourceMonitorMediaReference.map {
            max(0, Int(($0.viewerStartSeconds * 1_000_000).rounded()))
        }
        if candidateDataSource == nil, let selectedProject {
            loadCandidateDataSource(project: selectedProject)
        }
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
        roughCutCompileStatus = "\(assetID) をソースモニターで確認しています。\(localizedMediaPlaybackStatus(status.playbackStatus))"
    }

    func revealSelectedTimelineClipInSourceMonitor() {
        guard let clip = selectedTimelineClip?.clip else {
            roughCutCompileStatus = "ソース確認するタイムラインクリップを選択してください。"
            return
        }
        revealTimelineClipInSourceMonitor(clip.id)
    }

    func revealTimelineClipInSourceMonitor(_ clipID: TimelineClip.ID) {
        guard let timeline, let selection = timeline.clipSelection(for: clipID) else {
            roughCutCompileStatus = "\(clipID) は現在のタイムラインに見つかりません。"
            return
        }
        guard canRevealTimelineClipInSourceMonitor(selection.clip) else {
            roughCutCompileStatus = "\(selection.clip.assetID) はソースモニターで再生できません。素材リンクまたはプロキシを確認してください。"
            return
        }

        setTimelineClipSelection(primary: selection.clip.id, ids: [selection.clip.id])
        revealSourceBinAsset(selection.clip.assetID)
        previewSourceMonitorAsset(selection.clip.assetID)
        restoreSourceMonitorContext(for: selection.clip)

        let sourceLabel = selection.clip.sourceInUS.map(formatMicrosecondClock) ?? "先頭"
        roughCutCompileStatus = "\(selection.clip.id) の元素材 \(selection.clip.assetID) をソースモニターで開きました。source \(sourceLabel) から確認できます。"
    }

    func insertSourceMonitorAtPlayhead() {
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        guard let timeline else {
            roughCutCompileStatus = "ソース素材を追加する前にタイムラインを生成してください。"
            return
        }
        guard let assetID = sourceMonitorAssetID else {
            roughCutCompileStatus = "再生位置へ追加する素材をソース確認してください。"
            return
        }
        guard let dataSource = candidateDataSource else {
            if let selectedProject {
                loadCandidateDataSource(project: selectedProject)
            }
            roughCutCompileStatus = "select候補を読み込んでいます。読み込み後にもう一度追加してください。"
            return
        }
        guard let plan = TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: assetID,
            playheadFrame: playheadFrame,
            reason: "Studio source monitor insert at playhead",
            candidateID: sourceMonitorCandidateID,
            sourceRangeOverride: sourceMonitorMarkedRangeOverride(for: sourceMonitorCandidateID)
        ) else {
            roughCutCompileStatus = "\(assetID) には再生位置へ追加できるselect候補がありません。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        feedbackSession.addOp(plan.operation)
        self.timeline = plan.timeline
        setTimelineTransitionSelection(nil)
        setTimelineClipSelection(primary: plan.insertedClipID, ids: [plan.insertedClipID])
        showChangedClipHighlight(plan.changedClipIDs)
        clearSourceMonitorAsset(updateStatus: false)
        setPlayheadFrame(plan.timelineInFrame, forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let timecode = plan.timeline.sequence.framesToTimecode(plan.timelineInFrame)
        let targetLabel = sourceInsertTargetLabel(for: plan)
        roughCutCompileStatus = "\(plan.candidate.segment_id) を \(targetLabel) の \(timecode) に追加し、タイムラインとプレビューに反映しました。未保存のStudio修正です。"
    }

    func appendSourceMonitorToTimelineEnd() {
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        guard let timeline else {
            roughCutCompileStatus = "ソース素材を末尾へ追加する前にタイムラインを生成してください。"
            return
        }
        guard let assetID = sourceMonitorAssetID else {
            roughCutCompileStatus = "末尾へ追加する素材をソース確認してください。"
            return
        }
        guard let dataSource = candidateDataSource else {
            if let selectedProject {
                loadCandidateDataSource(project: selectedProject)
            }
            roughCutCompileStatus = "select候補を読み込んでいます。読み込み後にもう一度末尾へ追加してください。"
            return
        }
        guard let plan = TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: assetID,
            playheadFrame: timeline.totalFrames,
            reason: "Studio source monitor append to timeline end",
            candidateID: sourceMonitorCandidateID,
            sourceRangeOverride: sourceMonitorMarkedRangeOverride(for: sourceMonitorCandidateID)
        ) else {
            roughCutCompileStatus = "\(assetID) には末尾へ追加できるselect候補がありません。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        feedbackSession.addOp(plan.operation)
        self.timeline = plan.timeline
        setTimelineTransitionSelection(nil)
        setTimelineClipSelection(primary: plan.insertedClipID, ids: [plan.insertedClipID])
        showChangedClipHighlight(plan.changedClipIDs)
        clearSourceMonitorAsset(updateStatus: false)
        setPlayheadFrame(plan.timelineInFrame, forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let timecode = plan.timeline.sequence.framesToTimecode(plan.timelineInFrame)
        let targetLabel = sourceInsertTargetLabel(for: plan)
        roughCutCompileStatus = "\(plan.candidate.segment_id) を \(targetLabel) の末尾 \(timecode) に追加し、タイムラインとプレビューに反映しました。未保存のStudio修正です。"
    }

    func insertSourceBinQuickCandidateAtPlayhead(_ assetID: String) {
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        guard let timeline else {
            roughCutCompileStatus = "ソース素材を追加する前にタイムラインを生成してください。"
            return
        }
        guard mediaPreviewSummary.items.contains(where: { $0.assetID == assetID && $0.playbackStatus.isReady }) else {
            roughCutCompileStatus = "\(assetID) はViewerで再生できません。再リンクまたは仮素材作成後に追加してください。"
            return
        }
        guard let dataSource = candidateDataSource else {
            if let selectedProject {
                loadCandidateDataSource(project: selectedProject)
            }
            roughCutCompileStatus = "select候補を読み込んでいます。読み込み後にもう一度追加してください。"
            return
        }
        guard let candidate = sourceBinQuickDragCandidate(for: assetID) else {
            roughCutCompileStatus = "\(assetID) には再生位置へ追加できる未使用select候補がありません。"
            return
        }
        guard let plan = TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: assetID,
            playheadFrame: playheadFrame,
            reason: "Studio source bin quick insert at playhead",
            candidateID: candidate.id
        ) else {
            roughCutCompileStatus = "\(candidate.segment_id) は現在の再生位置へ追加できません。target laneまたはclip境界を確認してください。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        feedbackSession.addOp(plan.operation)
        self.timeline = plan.timeline
        setTimelineTransitionSelection(nil)
        setTimelineClipSelection(primary: plan.insertedClipID, ids: [plan.insertedClipID])
        showChangedClipHighlight(plan.changedClipIDs)
        clearSourceMonitorAsset(updateStatus: false)
        setPlayheadFrame(plan.timelineInFrame, forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let timecode = plan.timeline.sequence.framesToTimecode(plan.timelineInFrame)
        let targetLabel = sourceInsertTargetLabel(for: plan)
        roughCutCompileStatus = "\(plan.candidate.segment_id) をソースビンから \(targetLabel) の \(timecode) に追加し、タイムラインとプレビューに反映しました。未保存のStudio修正です。"
    }

    func dropSourceMonitorCandidateOnTimeline(
        sourceAssetID: String,
        candidateID: BrowserCandidate.ID,
        timelineFrame: Int,
        targetTrackID: TimelineTrack.ID,
        snapThresholdFrames: Int
    ) {
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        guard let timeline else {
            roughCutCompileStatus = "ソース候補をドロップする前にタイムラインを生成してください。"
            return
        }
        guard let dataSource = candidateDataSource else {
            if let selectedProject {
                loadCandidateDataSource(project: selectedProject)
            }
            roughCutCompileStatus = "select候補を読み込んでいます。読み込み後にもう一度ドロップしてください。"
            return
        }
        guard let plan = TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: sourceAssetID,
            playheadFrame: timelineFrame,
            reason: "Studio source monitor candidate drag drop",
            candidateID: candidateID,
            preferredTargetTrackID: targetTrackID,
            sourceRangeOverride: sourceMonitorMarkedRangeOverride(for: candidateID),
            snapThresholdFrames: snapThresholdFrames,
            snapPlayheadFrame: playheadFrame
        ) else {
            roughCutCompileStatus = "\(candidateID) は \(targetTrackID) へドロップ追加できません。候補の映像/音声種別とレーンを確認してください。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        feedbackSession.addOp(plan.operation)
        self.timeline = plan.timeline
        setTimelineTransitionSelection(nil)
        setTimelineClipSelection(primary: plan.insertedClipID, ids: [plan.insertedClipID])
        showChangedClipHighlight(plan.changedClipIDs)
        clearSourceMonitorAsset(updateStatus: false)
        setPlayheadFrame(plan.timelineInFrame, forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let timecode = plan.timeline.sequence.framesToTimecode(plan.timelineInFrame)
        let targetLabel = sourceInsertTargetLabel(for: plan)
        let snapLabel = plan.snap.map { "（吸着: \($0.label)）" } ?? ""
        roughCutCompileStatus = "\(plan.candidate.segment_id) をドラッグで \(targetLabel) の \(timecode) に追加し\(snapLabel)、タイムラインとプレビューに反映しました。未保存のStudio修正です。"
    }

    func overwriteSourceMonitorAtPlayhead() {
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        guard let timeline else {
            roughCutCompileStatus = "ソース素材を上書きする前にタイムラインを生成してください。"
            return
        }
        guard let assetID = sourceMonitorAssetID else {
            roughCutCompileStatus = "上書きに使う素材をソース確認してください。"
            return
        }
        guard candidateDataSource != nil else {
            if let selectedProject {
                loadCandidateDataSource(project: selectedProject)
            }
            roughCutCompileStatus = "select候補を読み込んでいます。読み込み後にもう一度上書きしてください。"
            return
        }
        guard sourceMonitorInsertCandidateSummary != nil else {
            roughCutCompileStatus = "\(assetID) に対応するselect候補がありません。別の素材をソース確認してください。"
            return
        }
        guard let plan = makeSourceMonitorOverwritePlan(reason: "Studio source monitor overwrite at playhead") else {
            roughCutCompileStatus = "\(assetID) は現在の再生位置へ安全に上書きできません。source range、target lane、またはclip境界を確認してください。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        for operation in plan.operations {
            feedbackSession.addOp(operation)
        }
        self.timeline = plan.timeline
        setTimelineTransitionSelection(nil)
        setTimelineClipSelection(primary: plan.insertedClipID, ids: [plan.insertedClipID])
        showChangedClipHighlight(plan.changedClipIDs)
        clearSourceMonitorAsset(updateStatus: false)
        setPlayheadFrame(plan.timelineInFrame, forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let timecode = plan.timeline.sequence.framesToTimecode(plan.timelineInFrame)
        let removePart = plan.removedClipIDs.isEmpty ? "削除なし" : "\(plan.removedClipIDs.count)件削除"
        let trimPart = plan.trimmedClipIDs.isEmpty ? "trimなし" : "\(plan.trimmedClipIDs.count)件trim"
        let splitPart = plan.splitClipIDs.isEmpty ? "splitなし" : "\(plan.splitClipIDs.count)件split"
        roughCutCompileStatus = "\(plan.candidate.segment_id) を \(plan.targetTrackID) の \(timecode) から上書きし、\(removePart) / \(trimPart) / \(splitPart) を反映しました。未保存のStudio修正です。"
    }

    func replaceSelectedClipWithSourceMonitorCandidate() {
        timelineTransitionDurationPreview = nil
        timelineClipMoveViewerPreview = nil
        guard let timeline else {
            roughCutCompileStatus = "ソース候補で置換する前にタイムラインを生成してください。"
            return
        }
        guard let targetClipID = selectedTimelineClipID else {
            roughCutCompileStatus = "置換するタイムラインクリップを選択してください。"
            return
        }
        guard let assetID = sourceMonitorAssetID else {
            roughCutCompileStatus = "置換に使う素材をソース確認してください。"
            return
        }
        guard candidateDataSource != nil else {
            if let selectedProject {
                loadCandidateDataSource(project: selectedProject)
            }
            roughCutCompileStatus = "select候補を読み込んでいます。読み込み後にもう一度置換してください。"
            return
        }
        guard let plan = makeSourceMonitorReplacePlan(reason: "Studio source monitor replace selected clip") else {
            roughCutCompileStatus = "\(assetID) の選択候補では、選択クリップを置換できません。"
            return
        }

        if feedbackSession.baseTimelineHash == nil || feedbackSession.baseTimelineVersion == nil {
            feedbackSession.captureBaseline(from: timeline)
        }
        feedbackSession.addOp(plan.operation)
        self.timeline = plan.timeline
        setTimelineTransitionSelection(nil)
        setTimelineClipSelection(primary: targetClipID, ids: [targetClipID])
        showChangedClipHighlight(plan.changedClipIDs)
        clearSourceMonitorAsset(updateStatus: false)
        setPlayheadFrame(plan.targetSelection.clip.timelineInFrame, forceSeek: true)
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1

        let timecode = plan.timeline.sequence.framesToTimecode(plan.targetSelection.clip.timelineInFrame)
        roughCutCompileStatus = "\(targetClipID) を \(plan.candidate.segment_id) で置換し、\(timecode) からプレビューへ反映しました。未保存のStudio修正です。"
    }

    func selectPreviousSourceMonitorCandidate() {
        selectSourceMonitorCandidate(offset: -1)
    }

    func selectNextSourceMonitorCandidate() {
        selectSourceMonitorCandidate(offset: 1)
    }

    var canStepSourceMonitorBackward: Bool {
        sourceMonitorStepTarget(byFrames: -1) != nil
    }

    var canStepSourceMonitorForward: Bool {
        sourceMonitorStepTarget(byFrames: 1) != nil
    }

    func updateSourceMonitorPlaybackTime(seconds: Double) {
        guard sourceMonitorAssetID != nil else {
            guard SourceMonitorPlaybackPublishing.shouldPublishPlaybackTime(
                previousUS: sourceMonitorPlaybackSourceUS,
                nextUS: nil
            ) else { return }
            sourceMonitorPlaybackSourceUS = nil
            return
        }
        guard let nextSourceUS = SourceMonitorPlaybackPublishing.playbackTimeUS(seconds: seconds),
              SourceMonitorPlaybackPublishing.shouldPublishPlaybackTime(
                previousUS: sourceMonitorPlaybackSourceUS,
                nextUS: nextSourceUS
              )
        else { return }
        sourceMonitorPlaybackSourceUS = nextSourceUS
    }

    private func stepSourceMonitor(byFrames frames: Int) {
        pausePlayback()
        guard let target = sourceMonitorStepTarget(byFrames: frames) else {
            guard sourceMonitorAssetID != nil else {
                roughCutCompileStatus = "コマ送りする素材をソース確認してください。"
                return
            }
            roughCutCompileStatus = frames < 0
                ? "ソース候補の先頭にいるため1フレーム戻れません。"
                : "ソース候補の末尾にいるため1フレーム進めません。"
            return
        }
        sourceMonitorPlaybackSourceUS = target.sourceUS
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
        let direction = frames < 0 ? "戻しました" : "進めました"
        roughCutCompileStatus = "\(target.candidate.segment_id) を \(formatMicrosecondClock(target.sourceUS)) へ1フレーム\(direction)。I/Oマークはこの位置を使えます。"
    }

    func markSourceMonitorInAtPlaybackTime() {
        markSourceMonitorPlaybackTime(.inPoint)
    }

    func markSourceMonitorOutAtPlaybackTime() {
        markSourceMonitorPlaybackTime(.outPoint)
    }

    func nudgeSourceMonitorMarkIn(by microseconds: Int) {
        guard let candidate = selectedSourceMonitorCandidate(in: sourceMonitorInsertCandidates()) else {
            roughCutCompileStatus = "範囲を調整できるソース候補がありません。"
            return
        }
        let range = effectiveSourceMonitorMarkedRange(for: candidate)
        let nextIn = max(candidate.src_in_us, min(range.sourceInUS + microseconds, range.sourceOutUS - 1))
        guard nextIn != range.sourceInUS else { return }
        guard let nextRange = TimelineSourceRangeOverride(sourceInUS: nextIn, sourceOutUS: range.sourceOutUS),
              publishSourceMonitorMarkedRange(nextRange) else { return }
        roughCutCompileStatus = "\(candidate.segment_id) のINを \(formatMicrosecondClock(nextIn)) にしました。追加/ドラッグ時はマーク範囲を使います。"
    }

    func nudgeSourceMonitorMarkOut(by microseconds: Int) {
        guard let candidate = selectedSourceMonitorCandidate(in: sourceMonitorInsertCandidates()) else {
            roughCutCompileStatus = "範囲を調整できるソース候補がありません。"
            return
        }
        let range = effectiveSourceMonitorMarkedRange(for: candidate)
        let nextOut = min(candidate.src_out_us, max(range.sourceOutUS + microseconds, range.sourceInUS + 1))
        guard nextOut != range.sourceOutUS else { return }
        guard let nextRange = TimelineSourceRangeOverride(sourceInUS: range.sourceInUS, sourceOutUS: nextOut),
              publishSourceMonitorMarkedRange(nextRange) else { return }
        roughCutCompileStatus = "\(candidate.segment_id) のOUTを \(formatMicrosecondClock(nextOut)) にしました。追加/ドラッグ時はマーク範囲を使います。"
    }

    func dragSourceMonitorMark(
        _ handle: TimelineSourceRangeMarkHandle,
        normalizedPosition: Double
    ) {
        guard let candidate = selectedSourceMonitorCandidate(in: sourceMonitorInsertCandidates()) else {
            roughCutCompileStatus = "範囲を調整できるソース候補がありません。"
            return
        }
        guard let range = TimelineSourceRangeMarkPlan.range(
            candidateSourceInUS: candidate.src_in_us,
            candidateSourceOutUS: candidate.src_out_us,
            currentSourceInUS: sourceMonitorMarkedSourceInUS,
            currentSourceOutUS: sourceMonitorMarkedSourceOutUS,
            handle: handle,
            normalizedPosition: normalizedPosition
        ) else {
            return
        }
        guard publishSourceMonitorMarkedRange(range) else { return }
        let label = handle == .inPoint ? "IN" : "OUT"
        let value = handle == .inPoint ? range.sourceInUS : range.sourceOutUS
        roughCutCompileStatus = "\(candidate.segment_id) の\(label)を \(formatMicrosecondClock(value)) へドラッグしました。追加/ドラッグ時はマーク範囲を使います。"
    }

    private func markSourceMonitorPlaybackTime(_ handle: TimelineSourceRangeMarkHandle) {
        guard let mark = sourceMonitorPlaybackMarkRange(handle: handle) else {
            guard sourceMonitorAssetID != nil else {
                roughCutCompileStatus = "IN/OUTを打つ素材をソース確認してください。"
                return
            }
            guard sourceMonitorInsertCandidateSummary != nil else {
                roughCutCompileStatus = "現在の素材にはIN/OUTを打てるselect候補がありません。"
                return
            }
            roughCutCompileStatus = "ソースを再生またはシークしてからIN/OUTを打ってください。"
            return
        }
        publishSourceMonitorMarkedRange(mark.range)
        let label = handle == .inPoint ? "IN" : "OUT"
        let value = handle == .inPoint ? mark.range.sourceInUS : mark.range.sourceOutUS
        roughCutCompileStatus = "\(mark.candidate.segment_id) の\(label)を現在位置 \(formatMicrosecondClock(value)) にマークしました。追加/ドラッグ時はマーク範囲を使います。"
    }

    func resetSourceMonitorMarkedRange() {
        guard let candidate = selectedSourceMonitorCandidate(in: sourceMonitorInsertCandidates()) else {
            resetSourceMonitorMarkedRangeState()
            return
        }
        resetSourceMonitorMarkedRangeState()
        roughCutCompileStatus = "\(candidate.segment_id) のマーク範囲を候補全体に戻しました。"
    }

    private func selectSourceMonitorCandidate(offset: Int) {
        let candidates = sourceMonitorInsertCandidates()
        guard !candidates.isEmpty,
              let current = selectedSourceMonitorCandidate(in: candidates),
              let currentIndex = candidates.firstIndex(where: { $0.id == current.id })
        else {
            roughCutCompileStatus = "この素材に切り替えられるselect候補がありません。"
            return
        }
        let nextIndex = max(0, min(candidates.count - 1, currentIndex + offset))
        guard nextIndex != currentIndex else { return }
        let candidate = candidates[nextIndex]
        sourceMonitorCandidateID = candidate.id
        let range = "\(formatMicrosecondClock(candidate.src_in_us))-\(formatMicrosecondClock(candidate.src_out_us))"
        roughCutCompileStatus = "\(candidate.segment_id) を追加候補にしました（\(nextIndex + 1)/\(candidates.count)、\(range)）。"
    }

    private func makeSourceMonitorInsertPlan(reason: String) -> TimelineSourceInsertPlan? {
        guard let timeline,
              let dataSource = candidateDataSource,
              let sourceMonitorAssetID
        else {
            return nil
        }
        return TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: sourceMonitorAssetID,
            playheadFrame: playheadFrame,
            reason: reason,
            candidateID: sourceMonitorCandidateID,
            sourceRangeOverride: sourceMonitorMarkedRangeOverride(for: sourceMonitorCandidateID)
        )
    }

    private func makeSourceMonitorAppendPlan(reason: String) -> TimelineSourceInsertPlan? {
        guard let timeline,
              let dataSource = candidateDataSource,
              let sourceMonitorAssetID
        else {
            return nil
        }
        return TimelineSourceInsertPlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: sourceMonitorAssetID,
            playheadFrame: timeline.totalFrames,
            reason: reason,
            candidateID: sourceMonitorCandidateID,
            sourceRangeOverride: sourceMonitorMarkedRangeOverride(for: sourceMonitorCandidateID)
        )
    }

    private func sourceInsertTargetLabel(for plan: TimelineSourceInsertPlan) -> String {
        guard let laneLift = plan.laneLift else {
            return plan.targetTrackID
        }
        let target = laneLift.createsTrack ? "新規\(laneLift.targetTrackID)" : laneLift.targetTrackID
        return "\(laneLift.requestedTrackID) の重なりを避けて \(target)"
    }

    private func makeSourceMonitorOverwritePlan(reason: String) -> TimelineSourceOverwritePlan? {
        guard let timeline,
              let dataSource = candidateDataSource,
              let sourceMonitorAssetID
        else {
            return nil
        }
        return TimelineSourceOverwritePlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: sourceMonitorAssetID,
            playheadFrame: playheadFrame,
            reason: reason,
            candidateID: sourceMonitorCandidateID,
            preferredTargetTrackID: selectedTimelineClip?.trackID,
            sourceRangeOverride: sourceMonitorMarkedRangeOverride(for: sourceMonitorCandidateID)
        )
    }

    private func makeSourceMonitorReplacePlan(reason: String) -> TimelineSourceReplacePlan? {
        guard let timeline,
              let dataSource = candidateDataSource,
              let sourceMonitorAssetID,
              let targetClipID = selectedTimelineClipID
        else {
            return nil
        }
        return TimelineSourceReplacePlan.make(
            timeline: timeline,
            dataSource: dataSource,
            sourceAssetID: sourceMonitorAssetID,
            targetClipID: targetClipID,
            reason: reason,
            candidateID: sourceMonitorCandidateID,
            sourceRangeOverride: sourceMonitorMarkedRangeOverride(for: sourceMonitorCandidateID)
        )
    }

    private func normalizeSourceMonitorCandidateSelection() {
        guard sourceMonitorAssetID != nil else {
            sourceMonitorCandidateID = nil
            return
        }
        let candidates = sourceMonitorInsertCandidates()
        guard !candidates.isEmpty else {
            sourceMonitorCandidateID = nil
            return
        }
        if let sourceMonitorCandidateID,
           candidates.contains(where: { $0.id == sourceMonitorCandidateID }) {
            return
        }
        sourceMonitorCandidateID = candidates.first?.id
    }

    private func sourceMonitorInsertCandidates() -> [BrowserCandidate] {
        guard let dataSource = candidateDataSource,
              let sourceMonitorAssetID
        else {
            return []
        }
        let usedSegmentIDs = Set(timeline?.displayTracks.flatMap(\.clips).map(\.segmentID) ?? [])
        return TimelineSourceInsertPlan.insertCandidates(
            in: dataSource,
            sourceAssetID: sourceMonitorAssetID,
            usedSegmentIDs: usedSegmentIDs
        )
    }

    private func selectedSourceMonitorCandidate(in candidates: [BrowserCandidate]) -> BrowserCandidate? {
        if let sourceMonitorCandidateID,
           let candidate = candidates.first(where: { $0.id == sourceMonitorCandidateID }) {
            return candidate
        }
        return candidates.first
    }

    private func canRevealTimelineClipInSourceMonitor(_ clip: TimelineClip) -> Bool {
        selectedProject != nil
            && mediaPreviewSummary.items.contains { $0.assetID == clip.assetID && $0.playbackStatus.isReady }
    }

    private func revealSourceBinAsset(_ assetID: String) {
        guard mediaPreviewSummary.items.contains(where: { $0.assetID == assetID }) else { return }
        if filteredMediaPreviewItems.contains(where: { $0.assetID == assetID }) {
            return
        }
        mediaSourceBinFilter = .all
        mediaSourceBinQuery = ""
    }

    private func restoreSourceMonitorContext(for clip: TimelineClip) {
        let candidates = sourceMonitorInsertCandidates()
        let selectedCandidate = bestSourceMonitorCandidate(for: clip, in: candidates)
        sourceMonitorCandidateID = selectedCandidate?.id

        if let candidate = selectedCandidate,
           let sourceInUS = clip.sourceInUS,
           let sourceOutUS = clip.sourceOutUS,
           let range = TimelineSourceRangeOverride(
                sourceInUS: max(candidate.src_in_us, sourceInUS),
                sourceOutUS: min(candidate.src_out_us, sourceOutUS)
           ) {
            publishSourceMonitorMarkedRange(range)
        }

        let playbackSourceUS = sourceMonitorPlaybackUS(for: clip, candidate: selectedCandidate)
        sourceMonitorPlaybackSourceUS = playbackSourceUS
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
    }

    private func bestSourceMonitorCandidate(
        for clip: TimelineClip,
        in candidates: [BrowserCandidate]
    ) -> BrowserCandidate? {
        if let candidateRef = clip.candidateRef,
           let candidate = candidates.first(where: { $0.id == candidateRef || $0.candidate_id == candidateRef }) {
            return candidate
        }
        if let candidate = candidates.first(where: { $0.segment_id == clip.segmentID }) {
            return candidate
        }
        guard let sourceInUS = clip.sourceInUS else {
            return candidates.first
        }
        return candidates.min { lhs, rhs in
            let lhsDistance = abs(lhs.src_in_us - sourceInUS)
            let rhsDistance = abs(rhs.src_in_us - sourceInUS)
            if lhsDistance != rhsDistance { return lhsDistance < rhsDistance }
            if lhs.confidence != rhs.confidence { return lhs.confidence > rhs.confidence }
            return lhs.segment_id.localizedStandardCompare(rhs.segment_id) == .orderedAscending
        }
    }

    private func sourceMonitorPlaybackUS(
        for clip: TimelineClip,
        candidate: BrowserCandidate?
    ) -> Int? {
        let fallbackIn = candidate?.src_in_us ?? 0
        let fallbackOut = candidate?.src_out_us ?? Int.max
        let sourceInUS = clip.sourceInUS ?? fallbackIn
        let sourceOutUS = clip.sourceOutUS ?? fallbackOut
        let timelineOffsetFrames = timeline.map { _ in
            max(0, min(clip.timelineDurationFrames, playheadFrame - clip.timelineInFrame))
        } ?? 0
        let offsetUS = timeline.map {
            Int(($0.sequence.framesToSeconds(timelineOffsetFrames) * 1_000_000).rounded())
        } ?? 0
        return max(fallbackIn, min(sourceInUS + offsetUS, sourceOutUS, fallbackOut))
    }

    private func sourceMonitorPlaybackMarkRange(
        handle: TimelineSourceRangeMarkHandle
    ) -> (candidate: BrowserCandidate, range: TimelineSourceRangeOverride)? {
        guard let candidate = selectedSourceMonitorCandidate(in: sourceMonitorInsertCandidates()),
              let playbackSourceUS = currentSourceMonitorPlaybackUS(for: candidate)
        else {
            return nil
        }
        let fraction = TimelineSourceRangeMarkPlan.fraction(
            sourceUS: playbackSourceUS,
            candidateSourceInUS: candidate.src_in_us,
            candidateSourceOutUS: candidate.src_out_us
        )
        guard let range = TimelineSourceRangeMarkPlan.range(
            candidateSourceInUS: candidate.src_in_us,
            candidateSourceOutUS: candidate.src_out_us,
            currentSourceInUS: sourceMonitorMarkedSourceInUS,
            currentSourceOutUS: sourceMonitorMarkedSourceOutUS,
            handle: handle,
            normalizedPosition: fraction
        ) else {
            return nil
        }
        return (candidate, range)
    }

    private func currentSourceMonitorPlaybackUS(for candidate: BrowserCandidate) -> Int? {
        guard let sourceMonitorPlaybackSourceUS else { return nil }
        return max(candidate.src_in_us, min(sourceMonitorPlaybackSourceUS, candidate.src_out_us))
    }

    private var sourceMonitorPreviewTimeUS: Int? {
        let candidates = sourceMonitorInsertCandidates()
        if let candidate = selectedSourceMonitorCandidate(in: candidates) {
            return currentSourceMonitorPlaybackUS(for: candidate) ?? candidate.src_in_us
        }
        return sourceMonitorPlaybackSourceUS
    }

    private func sourceMonitorStepTarget(byFrames frames: Int) -> (candidate: BrowserCandidate, sourceUS: Int)? {
        guard frames != 0,
              sourceMonitorAssetID != nil,
              let candidate = selectedSourceMonitorCandidate(in: sourceMonitorInsertCandidates())
        else {
            return nil
        }
        let current = currentSourceMonitorPlaybackUS(for: candidate) ?? candidate.src_in_us
        let proposed = current + (sourceMonitorFrameStepUS * frames)
        let clamped = max(candidate.src_in_us, min(proposed, candidate.src_out_us))
        guard clamped != current else { return nil }
        return (candidate, clamped)
    }

    private var sourceMonitorFrameStepUS: Int {
        guard let fps = timeline?.sequence.fps, fps.isFinite, fps > 0 else {
            return 33_333
        }
        return max(1, Int((1_000_000 / fps).rounded()))
    }

    private func effectiveSourceMonitorMarkedRange(for candidate: BrowserCandidate) -> TimelineSourceRangeOverride {
        TimelineSourceRangeMarkPlan.effectiveRange(
            candidateSourceInUS: candidate.src_in_us,
            candidateSourceOutUS: candidate.src_out_us,
            currentSourceInUS: sourceMonitorMarkedSourceInUS,
            currentSourceOutUS: sourceMonitorMarkedSourceOutUS
        )
            ?? TimelineSourceRangeOverride(sourceInUS: candidate.src_in_us, sourceOutUS: candidate.src_out_us)!
    }

    private func sourceMonitorMarkedRangeOverride(for candidateID: BrowserCandidate.ID?) -> TimelineSourceRangeOverride? {
        let candidates = sourceMonitorInsertCandidates()
        guard let candidate = candidateID.flatMap({ id in
            candidates.first { $0.id == id }
        }) ?? selectedSourceMonitorCandidate(in: candidates) else {
            return nil
        }
        if let candidateID, sourceMonitorCandidateID != candidateID {
            return nil
        }
        let range = effectiveSourceMonitorMarkedRange(for: candidate)
        guard range.sourceInUS != candidate.src_in_us || range.sourceOutUS != candidate.src_out_us else {
            return nil
        }
        return range
    }

    private func resetSourceMonitorMarkedRangeState() {
        publishSourceMonitorMarkedRange(nil)
    }

    @discardableResult
    private func publishSourceMonitorMarkedRange(_ range: TimelineSourceRangeOverride?) -> Bool {
        guard TimelineSourceRangeMarkPlan.shouldPublishRange(
            currentSourceInUS: sourceMonitorMarkedSourceInUS,
            currentSourceOutUS: sourceMonitorMarkedSourceOutUS,
            nextRange: range
        ) else { return false }
        sourceMonitorMarkedSourceInUS = range?.sourceInUS
        sourceMonitorMarkedSourceOutUS = range?.sourceOutUS
        return true
    }

    func clearSourceMonitorAsset() {
        clearSourceMonitorAsset(updateStatus: true)
    }

    private func clearSourceMonitorAsset(updateStatus: Bool) {
        guard sourceMonitorAssetID != nil else { return }
        pausePlayback()
        sourceMonitorAssetID = nil
        sourceMonitorPlaybackSourceUS = nil
        mediaPlaybackSyncGeneration += 1
        audioPlaybackSyncGeneration += 1
        if updateStatus {
            roughCutCompileStatus = "タイムラインプレビューに戻りました。"
        }
    }

    func previewFootageSearchResult(_ result: FootageSearchRunner.SearchResult) {
        guard let timeline else {
            roughCutCompileStatus = "検索結果のプレビュー前にプロジェクトを生成してください。"
            return
        }
        let clips = timeline.displayTracks.flatMap(\.clips)
        guard let clip = clips.first(where: { $0.segmentID == result.segment_id }) else {
            roughCutCompileStatus = "\(result.segment_id) は現在のタイムラインにありません。"
            return
        }
        selectTimelineClip(clip.id)
            roughCutCompileStatus = "現在のタイムラインで \(result.segment_id) をプレビューしています。"
    }

    private func loadCandidateDataSource(project: ProjectSummary) {
        candidateDataSource = nil
        let projectID = project.id
        let projectURL = project.path
        let root = repositoryRoot
        Task {
            let dataSource = await CandidateBrowserDataSource.load(projectURL: projectURL, repositoryRoot: root)
            guard self.selectedProject?.id == projectID else { return }
            self.candidateDataSource = dataSource
        }
    }

    private func presentStudioPatchConflictAlert(_ conflicts: [PatchConflict]) {
        let alert = NSAlert()
        alert.messageText = "Studio修正の競合"
        alert.informativeText = conflicts
            .prefix(4)
            .map(\.message)
            .joined(separator: "\n")
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func presentStudioPatchStaleAlert() {
        let alert = NSAlert()
        alert.messageText = "タイムラインが変更されています"
        alert.informativeText = "このStudio修正の基準を記録した後にタイムラインが変更されました。プロジェクトを再読み込みし、保留中のフィードバックを作り直してください。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    nonisolated private static func studioJSONEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }

    nonisolated private static func fileTimestamp(date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd'T'HH-mm-ss'Z'"
        return formatter.string(from: date)
    }

    nonisolated private static func fileHash16(at url: URL) throws -> String {
        try ProjectPlaybackContractStatusReader.fileHash16(Data(contentsOf: url))
    }

    nonisolated private static func restoreTimelineBackup(from backupURL: URL, to timelineURL: URL) throws {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: timelineURL.path) {
            try fileManager.removeItem(at: timelineURL)
        }
        try fileManager.copyItem(at: backupURL, to: timelineURL)
    }

    nonisolated private static func cleanupStudioPatchArtifacts(patchURL: URL?, backupURL: URL?) {
        let fileManager = FileManager.default
        for url in [patchURL, backupURL].compactMap({ $0 }) where fileManager.fileExists(atPath: url.path) {
            try? fileManager.removeItem(at: url)
        }
    }

    nonisolated private static func relativeProjectPath(projectURL: URL, url: URL) -> String {
        let root = projectURL.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        if path.hasPrefix(root + "/") {
            return String(path.dropFirst(root.count + 1))
        }
        return url.lastPathComponent
    }

    nonisolated private static func nextTimelineBackupURL(
        projectURL: URL,
        historyIndex: PatchHistoryIndex
    ) -> URL {
        let directory = PatchHistoryIndex.historyDirectory(projectURL: projectURL)
        var index = historyIndex.records.count + 1
        var candidate = directory.appendingPathComponent("timeline_backup_\(index).json")
        while FileManager.default.fileExists(atPath: candidate.path) {
            index += 1
            candidate = directory.appendingPathComponent("timeline_backup_\(index).json")
        }
        return candidate
    }

    private func compileSelectedProjectRoughCut(
        options: ProjectRoughCutCompileOptions,
        statusPrefix: String,
        activity: RoughCutCompileActivity
    ) {
        guard let selectedProject else {
            roughCutCompileStatus = "粗編集を生成する前にプロジェクトを選択してください。"
            return
        }

        let plan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path, options: options)
        roughCutCompilePlan = plan
        guard plan.canRun else {
            roughCutCompileStatus = "粗編集生成はまだ実行できません: \(localizedStudioLabel(plan.readinessLabel))。"
            return
        }

        isCompilingRoughCut = true
        roughCutCompileActivity = activity
        roughCutCompileStatus = statusPrefix

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectRoughCutCompileRunner.run(plan: plan)
                await MainActor.run {
                    self.isCompilingRoughCut = false
                    self.roughCutCompileActivity = .idle
                    self.refresh()
                    self.selectProject(selectedProject.id, userInitiated: false)
                    self.roughCutCompilePlan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: self.repositoryRoot, projectURL: selectedProject.path)
                    self.indexStatus = ProjectSQLiteIndex.status(projectURL: selectedProject.path)
                    if result.succeeded {
                        let docs = result.indexSummary?.searchDocumentCount ?? self.indexStatus.documentCount
                        self.indexOperationStatus = "粗編集生成後にインデックスを更新しました: 検索可能ドキュメント \(docs)件。"
                        self.roughCutCompileStatus = result.plan.options.patchURL == nil
                            ? "粗編集を生成し、timeline.jsonを更新しました。"
                            : "レビュー修正を反映し、timeline.jsonを再生成しました。"
                    } else {
                        self.roughCutCompileStatus = "粗編集生成に失敗しました: exit \(result.exitCode)。"
                    }
                }
            } catch {
                await MainActor.run {
                    self.isCompilingRoughCut = false
                    self.roughCutCompileActivity = .idle
                    self.roughCutCompileStatus = "粗編集生成に失敗しました: \(error)"
                }
            }
        }
    }

    func buildSelectedProjectMediaProxies() {
        guard let selectedProject else {
            mediaProxyOperationStatus = "プロキシを作成する前にプロジェクトを選択してください。"
            return
        }
        guard mediaProxyPlan.pendingCount > 0 else {
            mediaProxyOperationStatus = "作成待ちのプレビュープロキシはありません。"
            return
        }

        let projectURL = selectedProject.path
        let assets = evidenceStore?.assets
        isBuildingMediaProxies = true
        mediaProxyOperationStatus = "\(mediaProxyPlan.pendingCount)件のプレビュープロキシを作成しています..."

        Task.detached(priority: .userInitiated) {
            let result = ProjectMediaProxyBuilder.build(projectURL: projectURL, assets: assets)
            await MainActor.run {
                self.isBuildingMediaProxies = false
                self.evidenceStore = ProjectEvidenceStore.load(projectURL: projectURL)
                self.mediaPreviewSummary = ProjectMediaResolver.previewSummary(projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.mediaSourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.mediaProxyPlan = ProjectMediaProxyPlanner.plan(projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.refreshLibraryReadiness(projectURL: projectURL)

                if result.failureCount > 0 {
                    self.mediaProxyOperationStatus = "プロキシ作成が完了しました: 成功 \(result.builtCount)件 / 失敗 \(result.failureCount)件。"
                } else if result.builtCount > 0 {
                    self.mediaProxyOperationStatus = "\(result.builtCount)件のプレビュープロキシを作成しました。"
                } else {
                    self.mediaProxyOperationStatus = "作成されたプレビュープロキシはありません。"
                }
            }
        }
    }

    func performViewerDiagnosticAction(_ action: ProjectViewerReadinessDiagnostic.Action) {
        selectSurface(.ingest)
        switch action {
        case .relinkSourceMedia:
            chooseAndRelinkSelectedProjectMedia()
        case .buildPreviewProxies:
            buildSelectedProjectMediaProxies()
        case .buildPreviewMedia:
            if mediaProxyPlan.pendingCount > 0 {
                buildSelectedProjectMediaProxies()
            } else {
                buildSelectedProjectSyntheticMedia()
            }
        case .reviewPreviewSource:
            mediaRelinkStatus = "現在のプレビュー素材は素材パネルで確認できます。"
        }
    }

    func chooseAndRelinkSelectedProjectMedia(includeSynthetic: Bool = false) {
        guard selectedProject != nil else {
            mediaRelinkStatus = "素材を再リンクする前にプロジェクトを選択してください。"
            return
        }

        let panel = NSOpenPanel()
        panel.title = includeSynthetic ? "仮素材を実素材に置換" : "未リンク素材を再接続"
        panel.prompt = "再リンク"
        panel.message = includeSynthetic
            ? "生成された仮プレビューを置き換える実素材を探すため、フォルダまたはファイルを1つ以上選択してください。"
            : "選択中プロジェクトの未リンク素材を探すため、フォルダまたはファイルを1つ以上選択してください。"
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false

        guard panel.runModal() == .OK, !panel.urls.isEmpty else {
            mediaRelinkStatus = "再リンクをキャンセルしました。"
            return
        }
        relinkSelectedProjectMedia(searchRoots: panel.urls, includeSynthetic: includeSynthetic)
    }

    func relinkSelectedProjectMediaFromSourceMap(includeSynthetic: Bool = false) {
        guard let selectedProject else {
            mediaRelinkStatus = "素材を再リンクする前にプロジェクトを選択してください。"
            return
        }

        let suggestions = ProjectMediaRelinker.suggestedSearchRoots(projectURL: selectedProject.path)
        guard !suggestions.isEmpty else {
            mediaRelinkStatus = "素材対応表から候補フォルダを見つけられませんでした。"
            return
        }

        let roots = suggestions.filter(\.exists).map(\.url)
        guard !roots.isEmpty else {
            mediaRelinkStatus = "素材対応表の候補フォルダはありますが、現在マウントされていません。"
            return
        }

        mediaRelinkStatus = includeSynthetic
            ? "\(roots.count)件の候補フォルダから、仮素材も含めて検索しています..."
            : "\(roots.count)件の候補フォルダから検索しています..."
        relinkSelectedProjectMedia(searchRoots: roots, includeSynthetic: includeSynthetic)
    }

    func relinkSelectedProjectMedia(searchRoots: [URL], includeSynthetic: Bool = false) {
        guard let selectedProject else {
            mediaRelinkStatus = "素材を再リンクする前にプロジェクトを選択してください。"
            return
        }

        let projectURL = selectedProject.path
        let assets = evidenceStore?.assets
        let plan = ProjectMediaRelinker.plan(
            projectURL: projectURL,
            searchRoots: searchRoots,
            assets: assets,
            includeSynthetic: includeSynthetic
        )
        mediaRelinkPlan = plan
        guard plan.canApply else {
            mediaRelinkStatus = "再リンク候補に一致するファイルは見つかりませんでした。"
            return
        }

        isRelinkingMedia = true
        mediaRelinkStatus = "\(plan.matchedCount)件の素材を再リンクしています..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectMediaRelinker.apply(plan: plan)
                await MainActor.run {
                    self.isRelinkingMedia = false
                    self.evidenceStore = ProjectEvidenceStore.load(projectURL: projectURL)
                    self.mediaPreviewSummary = ProjectMediaResolver.previewSummary(projectURL: projectURL, assets: self.evidenceStore?.assets)
                    self.mediaSourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: projectURL, assets: self.evidenceStore?.assets)
                    self.mediaProxyPlan = ProjectMediaProxyPlanner.plan(projectURL: projectURL, assets: self.evidenceStore?.assets)
                    self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: self.repositoryRoot, projectURL: projectURL, assets: self.evidenceStore?.assets)
                    self.handoffExportStatus = self.handoffExportPlan.map { localizedStudioLabel($0.readinessLabel) } ?? "Premiere XMLはまだ確認されていません。"
                    self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: self.repositoryRoot, projectURL: projectURL, assets: self.evidenceStore?.assets)
                    self.editorPacketStatus = self.editorPacketPlan.map { localizedStudioLabel($0.readinessLabel) } ?? "編集者パケットはまだ確認されていません。"
                    self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                    self.refreshLibraryReadiness(projectURL: projectURL)
                    self.mediaPlaybackSyncGeneration += 1
                    self.audioPlaybackSyncGeneration += 1
                    if let timeline = self.timeline {
                        self.loadAudioWaveforms(project: selectedProject, timeline: timeline)
                    }
                    self.mediaRelinkStatus = "\(result.linkedCount)件の素材を再リンクしました。未リンク \(self.mediaPreviewSummary.missingCount)件、仮素材 \(self.mediaPreviewSummary.syntheticPreviewCount)件が残っています。"
                }
            } catch {
                await MainActor.run {
                    self.isRelinkingMedia = false
                    self.mediaRelinkStatus = "再リンクに失敗しました: \(error)"
                }
            }
        }
    }

    func buildSelectedProjectSyntheticMedia() {
        guard let selectedProject else {
            syntheticMediaStatus = "仮素材を作成する前にプロジェクトを選択してください。"
            return
        }

        let projectURL = selectedProject.path
        let assets = evidenceStore?.assets
        isBuildingSyntheticMedia = true
        syntheticMediaStatus = "ローカル検証用の仮素材を作成しています..."

        Task.detached(priority: .userInitiated) {
            let result = ProjectSyntheticMediaBuilder.build(projectURL: projectURL, assets: assets, durationSeconds: 5)
            await MainActor.run {
                self.isBuildingSyntheticMedia = false
                self.evidenceStore = ProjectEvidenceStore.load(projectURL: projectURL)
                self.mediaPreviewSummary = ProjectMediaResolver.previewSummary(projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.mediaSourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.mediaProxyPlan = ProjectMediaProxyPlanner.plan(projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: self.repositoryRoot, projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.handoffExportStatus = self.handoffExportPlan.map { localizedStudioLabel($0.readinessLabel) } ?? "Premiere XMLはまだ確認されていません。"
                self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: self.repositoryRoot, projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.editorPacketStatus = self.editorPacketPlan.map { localizedStudioLabel($0.readinessLabel) } ?? "編集者パケットはまだ確認されていません。"
                self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                self.refreshLibraryReadiness(projectURL: projectURL)
                self.mediaPlaybackSyncGeneration += 1
                self.audioPlaybackSyncGeneration += 1
                if let timeline = self.timeline {
                    self.loadAudioWaveforms(project: selectedProject, timeline: timeline)
                }
                if result.failureCount > 0 {
                    self.syntheticMediaStatus = "\(result.failureCount)件の仮素材作成に失敗しました。"
                } else {
                    self.syntheticMediaStatus = "仮素材を作成しました: 作成 \(result.builtCount)件 / スキップ \(result.skippedCount)件 / 対応表 \(result.mappedCount)件。"
                }
            }
        }
    }

    func runStudioSyntheticSmoke() {
        guard !isRunningStudioSyntheticSmoke else { return }
        let root = repositoryRoot
        isRunningStudioSyntheticSmoke = true
        studioSyntheticSmokeStatus = "一時プロジェクトでStudioスモークを実行しています..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectStudioSyntheticSmoke.run(repositoryRoot: root, durationSeconds: 1)
                let renderLabel = localizedStudioLabel(result.renderResult.status.readinessLabel)
                let status = result.succeeded
                    ? "Studioスモークは合格しました: 書き出し=\(renderLabel)、パケット素材=\(result.editorPacketMediaCount)、スコア=\(result.studioStatus.scoreLabel)。"
                    : "Studioスモークは失敗しました: 書き出し=\(renderLabel)、パケット素材=\(result.editorPacketMediaCount)、スコア=\(result.studioStatus.scoreLabel)。"
                ProjectStudioSyntheticSmoke.removeProject(result)
                await MainActor.run {
                    self.isRunningStudioSyntheticSmoke = false
                    self.studioSyntheticSmokeStatus = status
                }
            } catch {
                await MainActor.run {
                    self.isRunningStudioSyntheticSmoke = false
                    self.studioSyntheticSmokeStatus = "Studioスモークに失敗しました: \(error)"
                }
            }
        }
    }

    func runStudioAcceptanceSmoke() {
        guard !isRunningStudioAcceptanceSmoke else { return }
        let root = repositoryRoot
        isRunningStudioAcceptanceSmoke = true
        studioAcceptanceSmokeStatus = "Codex App ServerとStudio受け入れチェックを実行しています..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectStudioAcceptanceSmoke.run(repositoryRoot: root, durationSeconds: 1)
                let studio = result.studioSmokeResult
                let renderLabel = localizedStudioLabel(studio.renderResult.status.readinessLabel)
                let status = result.succeeded
                    ? "受け入れチェックは合格しました: App Server=\(result.appServerResponse.platformFamily)/\(result.appServerResponse.platformOs)、書き出し=\(renderLabel)、パケット素材=\(studio.editorPacketMediaCount)、スコア=\(studio.studioStatus.scoreLabel)。"
                    : "受け入れチェックは失敗しました: App Server=\(result.appServerResponse.platformFamily)/\(result.appServerResponse.platformOs)、書き出し=\(renderLabel)、パケット素材=\(studio.editorPacketMediaCount)、スコア=\(studio.studioStatus.scoreLabel)。"
                ProjectStudioAcceptanceSmoke.removeProject(result)
                await MainActor.run {
                    self.isRunningStudioAcceptanceSmoke = false
                    self.studioAcceptanceSmokeStatus = status
                }
            } catch {
                await MainActor.run {
                    self.isRunningStudioAcceptanceSmoke = false
                    self.studioAcceptanceSmokeStatus = "受け入れチェックに失敗しました: \(error)"
                }
            }
        }
    }

    func runSelectedProjectMarlinEvaluation() {
        guard let selectedProject else {
            marlinEvaluationRunStatus = "Marlin評価を実行する前にプロジェクトを選択してください。"
            return
        }
        let plan = ProjectMarlinEvaluationRunPlanner.plan(
            repositoryRoot: repositoryRoot,
            projectURL: selectedProject.path,
            assets: evidenceStore?.assets
        )
        guard plan.canRun else {
            marlinEvaluationRunPlan = plan
            marlinEvaluationRunStatus = "Marlin評価はまだ実行できません: \(localizedStudioLabel(plan.readinessLabel))。"
            return
        }
        marlinRuntimeStatus = ProjectMarlinRuntimeStatusReader.status(repositoryRoot: repositoryRoot)
        guard marlinRuntimeStatus.isReadyForLiveMarlin else {
            marlinEvaluationRunPlan = plan
            marlinEvaluationRunStatus = "Marlin実行環境はまだ準備できていません: \(localizedStudioLabel(marlinRuntimeStatus.readinessLabel))。\(marlinRuntimeStatus.setupCommand)"
            return
        }
        marlinModelAccessStatus = ProjectMarlinModelAccessStatusReader.status(
            repositoryRoot: repositoryRoot,
            pythonBinary: marlinRuntimeStatus.pythonBinary
        )
        guard marlinModelAccessStatus.isReadyForLiveMarlin else {
            marlinEvaluationRunPlan = plan
            marlinEvaluationRunStatus = "Marlinモデルへまだアクセスできません: \(localizedStudioLabel(marlinModelAccessStatus.readinessLabel))。\(localizedStudioText(marlinModelAccessStatus.recommendation))"
            studioReadinessActionStatus = marlinEvaluationRunStatus
            return
        }

        isRunningMarlinEvaluation = true
        marlinEvaluationRunPlan = plan
        marlinEvaluationRunStatus = "\(plan.sourceCount)件の素材でMarlin評価を実行しています..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectMarlinEvaluationRunner.runAndRefreshIndex(plan: plan)
                await MainActor.run {
                    self.isRunningMarlinEvaluation = false
                    self.evidenceStore = ProjectEvidenceStore.load(projectURL: selectedProject.path)
                    self.marlinEvaluationStatus = ProjectMarlinEvaluationStatusReader.status(
                        projectURL: selectedProject.path,
                        repositoryRoot: self.repositoryRoot
                    )
                    self.marlinPreferenceDecision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: self.repositoryRoot)
                    self.marlinEvaluationQueue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: self.repositoryRoot)
                    self.marlinRepresentativePlan = ProjectMarlinRepresentativePlanReader.plan(repositoryRoot: self.repositoryRoot)
                    self.marlinEvaluationRunPlan = ProjectMarlinEvaluationRunPlanner.plan(
                        repositoryRoot: self.repositoryRoot,
                        projectURL: selectedProject.path,
                        assets: self.evidenceStore?.assets
                    )
                    self.indexStatus = ProjectSQLiteIndex.status(projectURL: selectedProject.path)
                    self.refreshLibraryReadiness(projectURL: selectedProject.path)
                    if result.succeeded, let indexSummary = result.indexSummary {
                        self.indexOperationStatus = "Marlin評価後にインデックスを更新しました: イベント \(indexSummary.marlinEventCount)件 / 検索一致 \(indexSummary.marlinFindResultCount)件。"
                        self.marlinEvaluationRunStatus = "Marlin評価が完了し、\(indexSummary.searchDocumentCount)件の検索ドキュメントを更新しました。"
                    } else {
                        self.marlinEvaluationRunStatus = Self.marlinFailureStatus(
                            prefix: "Marlin evaluation failed",
                            exitCode: result.runResult.exitCode,
                            standardError: result.runResult.standardError
                        )
                    }
                    self.studioReadinessActionStatus = self.marlinEvaluationRunStatus
                }
            } catch {
                await MainActor.run {
                    self.isRunningMarlinEvaluation = false
                    self.marlinEvaluationRunStatus = Self.marlinFailureStatus(
                        prefix: "Marlin evaluation failed",
                        standardError: String(describing: error)
                    )
                    self.studioReadinessActionStatus = self.marlinEvaluationRunStatus
                }
            }
        }
    }

    func materializeSelectedProjectMarlinEvidence() {
        guard let selectedProject else {
            marlinEvaluationRunStatus = "Marlin根拠を反映する前にプロジェクトを選択してください。"
            studioReadinessActionStatus = marlinEvaluationRunStatus
            return
        }
        let plan = ProjectMarlinMaterializationPlanner.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path)
        guard plan.canRun else {
            marlinEvaluationRunStatus = "Marlin根拠の反映はまだ実行できません: \(localizedStudioLabel(plan.readinessLabel))。"
            studioReadinessActionStatus = marlinEvaluationRunStatus
            return
        }

        isRunningMarlinEvaluation = true
        marlinEvaluationRunStatus = "既存のMarlin根拠をセグメントへ反映しています..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectMarlinMaterializationRunner.runAndRefreshIndex(plan: plan)
                await MainActor.run {
                    self.isRunningMarlinEvaluation = false
                    self.evidenceStore = ProjectEvidenceStore.load(projectURL: selectedProject.path)
                    self.marlinEvaluationStatus = ProjectMarlinEvaluationStatusReader.status(
                        projectURL: selectedProject.path,
                        repositoryRoot: self.repositoryRoot
                    )
                    self.marlinPreferenceDecision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: self.repositoryRoot)
                    self.marlinEvaluationQueue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: self.repositoryRoot)
                    self.marlinRepresentativePlan = ProjectMarlinRepresentativePlanReader.plan(repositoryRoot: self.repositoryRoot)
                    self.marlinEvaluationRunPlan = ProjectMarlinEvaluationRunPlanner.plan(
                        repositoryRoot: self.repositoryRoot,
                        projectURL: selectedProject.path,
                        assets: self.evidenceStore?.assets
                    )
                    self.indexStatus = ProjectSQLiteIndex.status(projectURL: selectedProject.path)
                    self.refreshLibraryReadiness(projectURL: selectedProject.path)
                    self.studioReadinessStatus = ProjectStudioReadinessStatusReader.status(
                        repositoryRoot: self.repositoryRoot,
                        projectURL: selectedProject.path
                    )
                    self.studioGoalStatus = self.makeStudioGoalStatus(projectURL: selectedProject.path)
                    if result.succeeded, let indexSummary = result.indexSummary {
                        self.indexOperationStatus = "Marlin反映後にインデックスを更新しました: イベント \(indexSummary.marlinEventCount)件 / 検索一致 \(indexSummary.marlinFindResultCount)件。"
                        self.marlinEvaluationRunStatus = "Marlin根拠を反映し、\(indexSummary.searchDocumentCount)件の検索ドキュメントを更新しました。"
                    } else {
                        self.marlinEvaluationRunStatus = Self.marlinFailureStatus(
                            prefix: "Marlin materialization failed",
                            exitCode: result.runResult.exitCode,
                            standardError: result.runResult.standardError
                        )
                    }
                    self.studioReadinessActionStatus = self.marlinEvaluationRunStatus
                }
            } catch {
                await MainActor.run {
                    self.isRunningMarlinEvaluation = false
                    self.marlinEvaluationRunStatus = Self.marlinFailureStatus(
                        prefix: "Marlin materialization failed",
                        standardError: String(describing: error)
                    )
                    self.studioReadinessActionStatus = self.marlinEvaluationRunStatus
                }
            }
        }
    }

    func runNextMarlinEvaluation() {
        let next = ProjectMarlinEvaluationNextPlanner.plan(repositoryRoot: repositoryRoot)
        guard let item = next.item, let plan = next.runPlan, plan.canRun else {
            marlinEvaluationRunStatus = "実行できるMarlin評価キューはありません: \(localizedStudioText(next.recommendation))"
            studioReadinessActionStatus = marlinEvaluationRunStatus
            return
        }
        marlinRuntimeStatus = ProjectMarlinRuntimeStatusReader.status(repositoryRoot: repositoryRoot)
        guard marlinRuntimeStatus.isReadyForLiveMarlin else {
            marlinEvaluationRunStatus = "Marlin実行環境はまだ準備できていません: \(localizedStudioLabel(marlinRuntimeStatus.readinessLabel))。\(marlinRuntimeStatus.setupCommand)"
            studioReadinessActionStatus = marlinEvaluationRunStatus
            return
        }
        marlinModelAccessStatus = ProjectMarlinModelAccessStatusReader.status(
            repositoryRoot: repositoryRoot,
            pythonBinary: marlinRuntimeStatus.pythonBinary
        )
        guard marlinModelAccessStatus.isReadyForLiveMarlin else {
            marlinEvaluationRunStatus = "Marlinモデルへまだアクセスできません: \(localizedStudioLabel(marlinModelAccessStatus.readinessLabel))。\(localizedStudioText(marlinModelAccessStatus.recommendation))"
            studioReadinessActionStatus = marlinEvaluationRunStatus
            return
        }

        isRunningMarlinEvaluation = true
        marlinEvaluationRunPlan = plan
        marlinEvaluationRunStatus = "\(item.id) のMarlin評価を実行しています: 素材 \(plan.sourceCount)件。"

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectMarlinEvaluationRunner.runAndRefreshIndex(plan: plan)
                await MainActor.run {
                    self.isRunningMarlinEvaluation = false
                    self.marlinPreferenceDecision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: self.repositoryRoot)
                    self.marlinEvaluationQueue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: self.repositoryRoot)
                    self.marlinRepresentativePlan = ProjectMarlinRepresentativePlanReader.plan(repositoryRoot: self.repositoryRoot)
                    if let selectedProject = self.selectedProject {
                        self.evidenceStore = ProjectEvidenceStore.load(projectURL: selectedProject.path)
                        self.marlinEvaluationStatus = ProjectMarlinEvaluationStatusReader.status(
                            projectURL: selectedProject.path,
                            repositoryRoot: self.repositoryRoot
                        )
                        self.marlinEvaluationRunPlan = ProjectMarlinEvaluationRunPlanner.plan(
                            repositoryRoot: self.repositoryRoot,
                            projectURL: selectedProject.path,
                            assets: self.evidenceStore?.assets
                        )
                        self.studioReadinessStatus = ProjectStudioReadinessStatusReader.status(
                            repositoryRoot: self.repositoryRoot,
                            projectURL: selectedProject.path
                        )
                        self.studioGoalStatus = self.makeStudioGoalStatus(projectURL: selectedProject.path)
                    }
                    if result.succeeded, let indexSummary = result.indexSummary {
                        self.marlinEvaluationRunStatus = "\(item.id) のMarlin評価が完了し、\(indexSummary.searchDocumentCount)件の検索ドキュメントを更新しました。"
                    } else {
                        self.marlinEvaluationRunStatus = Self.marlinFailureStatus(
                            prefix: "Queued Marlin evaluation failed for \(item.id)",
                            exitCode: result.runResult.exitCode,
                            standardError: result.runResult.standardError
                        )
                    }
                    self.studioReadinessActionStatus = self.marlinEvaluationRunStatus
                }
            } catch {
                await MainActor.run {
                    self.isRunningMarlinEvaluation = false
                    self.marlinEvaluationRunStatus = Self.marlinFailureStatus(
                        prefix: "Queued Marlin evaluation failed",
                        standardError: String(describing: error)
                    )
                    self.studioReadinessActionStatus = self.marlinEvaluationRunStatus
                }
            }
        }
    }

    func buildSelectedProjectAudioStoryGraph() {
        guard let selectedProject else {
            audioStoryGraphRunStatus = "音声ストーリーを構築する前にプロジェクトを選択してください。"
            return
        }
        let plan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path)
        audioStoryGraphRunPlan = plan
        guard plan.canRun else {
            audioStoryGraphRunStatus = "音声ストーリーはまだ構築できません: \(localizedStudioLabel(plan.readinessLabel))。"
            return
        }

        isBuildingAudioStoryGraph = true
        audioStoryGraphRunStatus = "音声ストーリーを構築しています..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectAudioStoryGraphRunner.run(plan: plan)
                await MainActor.run {
                    self.isBuildingAudioStoryGraph = false
                    self.evidenceStore = ProjectEvidenceStore.load(projectURL: selectedProject.path)
                    self.indexStatus = ProjectSQLiteIndex.status(projectURL: selectedProject.path)
                    self.refreshLibraryReadiness(projectURL: selectedProject.path)
                    if let timeline = self.timeline {
                        self.loadAudioWaveforms(project: selectedProject, timeline: timeline)
                    }
                    if result.succeeded, let indexSummary = result.indexSummary {
                        self.indexOperationStatus = "音声ストーリー作成後にインデックスを更新しました: 音声ノード \(indexSummary.audioStoryNodeCount)件。"
                        self.audioStoryGraphRunStatus = "音声ストーリーを構築し、検索へ追加しました: ノード \(indexSummary.audioStoryNodeCount)件 / ドキュメント \(indexSummary.searchDocumentCount)件。"
                    } else {
                        self.audioStoryGraphRunStatus = "音声ストーリーの構築に失敗しました: exit \(result.exitCode)。\(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))"
                    }
                }
            } catch {
                await MainActor.run {
                    self.isBuildingAudioStoryGraph = false
                    self.audioStoryGraphRunStatus = "音声ストーリーの構築に失敗しました: \(error)"
                }
            }
        }
    }

    func exportSelectedProjectPremiereXML() {
        guard let selectedProject else {
            handoffExportStatus = "書き出す前にプロジェクトを選択してください。"
            return
        }
        guard let plan = handoffExportPlan, plan.canExportPremiereXML else {
            handoffExportStatus = handoffExportPlan.map { localizedStudioLabel($0.readinessLabel) } ?? "Premiere XMLはまだ準備できていません。"
            return
        }

        let root = repositoryRoot
        let projectURL = selectedProject.path
        let assets = evidenceStore?.assets
        isExportingPremiereXML = true
        handoffExportStatus = "Premiere XMLを書き出しています..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectHandoffExporter.exportPremiereXML(repositoryRoot: root, projectURL: projectURL, assets: assets)
                await MainActor.run {
                    self.isExportingPremiereXML = false
                    self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.handoffExportStatus = "\(result.outputURL.lastPathComponent) を書き出しました。"
                    self.editorPacketStatus = self.editorPacketPlan.map { localizedStudioLabel($0.readinessLabel) } ?? "編集者パケットはまだ確認されていません。"
                    self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                }
            } catch {
                await MainActor.run {
                    self.isExportingPremiereXML = false
                    self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.handoffExportStatus = "Premiere XMLの書き出しに失敗しました: \(error)"
                    self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                }
            }
        }
    }

    func exportSelectedProjectEditorPacket() {
        guard let selectedProject else {
            editorPacketStatus = "編集者パケットを書き出す前にプロジェクトを選択してください。"
            return
        }
        guard let plan = editorPacketPlan, plan.canExportPacket else {
            editorPacketStatus = editorPacketPlan.map { localizedStudioLabel($0.readinessLabel) } ?? "編集者パケットはまだ準備できていません。"
            return
        }

        let root = repositoryRoot
        let projectURL = selectedProject.path
        let assets = evidenceStore?.assets
        isExportingEditorPacket = true
        editorPacketStatus = "編集者パケットを書き出しています..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectEditorPacketExporter.export(repositoryRoot: root, projectURL: projectURL, assets: assets)
                await MainActor.run {
                    self.isExportingEditorPacket = false
                    self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.handoffExportStatus = "Premiere XMLはパケットに同梱できます。"
                    self.editorPacketStatus = "\(result.files.count)ファイルを含む編集者パケットを書き出しました。"
                    self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                }
            } catch {
                await MainActor.run {
                    self.isExportingEditorPacket = false
                    self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.editorPacketStatus = "編集者パケットの書き出しに失敗しました: \(error)"
                    self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                }
            }
        }
    }

    func runSelectedProjectRender() {
        guard let selectedProject else {
            renderRunStatus = "書き出す前にプロジェクトを選択してください。"
            return
        }

        let plan = ProjectRenderRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path)
        renderRunPlan = plan
        guard plan.canRun else {
            renderRunStatus = "書き出しはまだ実行できません: \(localizedStudioLabel(plan.readinessLabel))。"
            return
        }

        isRunningRender = true
        renderRunStatus = "最終動画を書き出し、パッケージを作成しています..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectRenderRunner.run(plan: plan)
                await MainActor.run {
                    self.isRunningRender = false
                    self.renderPackageStatus = ProjectRenderPackageStatusReader.status(projectURL: selectedProject.path)
                    self.renderRunPlan = ProjectRenderRunPlanner.plan(repositoryRoot: self.repositoryRoot, projectURL: selectedProject.path)
                    if result.succeeded {
                        self.renderRunStatus = "最終動画パッケージを作成しました。"
                    } else {
                        self.renderRunStatus = "書き出しに失敗しました: exit \(result.exitCode)。"
                    }
                }
            } catch {
                await MainActor.run {
                    self.isRunningRender = false
                    self.renderRunStatus = "書き出しに失敗しました: \(error)"
                }
            }
        }
    }

    func runSelectedProjectPromoFinish() {
        guard let selectedProject else {
            promoFinishRunStatus = "テロップ仕上げの前にプロジェクトを選択してください。"
            return
        }

        let projectID = selectedProject.id
        let projectURL = selectedProject.path
        let root = repositoryRoot
        let plan = ProjectPromoFinishRunPlanner.plan(repositoryRoot: root, projectURL: projectURL)
        promoFinishRunPlan = plan
        guard plan.canRun else {
            promoFinishRunStatus = "テロップ仕上げはまだ実行できません: \(localizedStudioLabel(plan.readinessLabel))。"
            return
        }

        isRunningPromoFinish = true
        promoFinishRunStatus = "宣材用のテロップ動画を生成しています..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectPromoFinishRunner.run(plan: plan)
                await MainActor.run {
                    guard self.selectedProjectID == projectID else { return }
                    self.isRunningPromoFinish = false
                    self.promoFinishStatus = ProjectPromoFinishStatusReader.status(projectURL: projectURL)
                    self.promoFinishRunPlan = ProjectPromoFinishRunPlanner.plan(repositoryRoot: root, projectURL: projectURL)
                    if result.succeeded {
                        self.promoFinishRunStatus = "宣材用テロップ動画を作成しました: \(result.status.captionCount)件のテロップ。"
                    } else {
                        self.promoFinishRunStatus = "テロップ仕上げに失敗しました: exit \(result.exitCode)。"
                    }
                }
            } catch {
                await MainActor.run {
                    guard self.selectedProjectID == projectID else { return }
                    self.isRunningPromoFinish = false
                    self.promoFinishRunStatus = "テロップ仕上げに失敗しました: \(error)"
                }
            }
        }
    }

    func revealPromoFinishInFinder() {
        var urls: [URL] = []
        if promoFinishStatus.finishedVideoExists {
            urls.append(promoFinishStatus.finishedVideoURL)
        }
        if promoFinishStatus.subtitleSidecarExists {
            urls.append(promoFinishStatus.subtitleSidecarURL)
        }
        guard !urls.isEmpty else {
            promoFinishRunStatus = "Finderで表示する前にテロップ仕上げを実行してください。"
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting(urls)
        promoFinishRunStatus = "宣材テロップ成果物をFinderで表示しました。"
    }

    func revealEditorPacketInFinder() {
        guard let packetURL = editorPacketPlan?.packetURL else {
            editorPacketStatus = "編集者パケットの場所はまだ確認できません。"
            return
        }
        if FileManager.default.fileExists(atPath: packetURL.path) {
            NSWorkspace.shared.activateFileViewerSelecting([packetURL])
            editorPacketStatus = "編集者パケットをFinderで表示しました。"
        } else {
            editorPacketStatus = "Finderで表示する前に編集者パケットを書き出してください。"
        }
    }

    func searchSelectedProjectIndex() {
        guard let selectedProject else {
            indexOperationStatus = "検索する前にプロジェクトを選択してください。"
            return
        }
        let query = indexSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            indexSearchResults = []
            indexContextPack = ProjectRAGContextPack(query: "", items: [])
            indexOperationStatus = "検索語句を入力してください。"
            return
        }

        do {
            indexSearchResults = try ProjectSQLiteIndex.search(projectURL: selectedProject.path, query: query, limit: 12)
            indexContextPack = ProjectRAGContextPack.build(query: query, results: indexSearchResults)
            indexOperationStatus = "\(indexSearchResults.count)件の検索結果が見つかりました。"
        } catch {
            indexSearchResults = []
            indexContextPack = ProjectRAGContextPack(query: "", items: [])
            indexOperationStatus = "インデックス検索に失敗しました。先にインデックスを再構築してください。"
        }
    }

    func appendIndexContextToAgentPrompt() {
        guard !indexContextPack.isEmpty else {
            indexOperationStatus = "Codexへ根拠を追加する前に、プロジェクト内検索を実行してください。"
            return
        }
        let separator = agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : "\n\n"
        agentPrompt += "\(separator)\(indexContextPack.promptText)"
        indexOperationStatus = "Added \(indexContextPack.items.count) cited RAG items to the Codex prompt."
    }

    @discardableResult
    func prepareTimelineSelectionAgentPrompt() -> Bool {
        guard let selectedProject, let timeline else {
            turnStatus = "AIに相談する前にプロジェクトを選択してください。"
            return false
        }

        var contextClipIDs = activeSelectedTimelineClipIDs()
        if let transition = selectedTimelineTransition {
            contextClipIDs.insert(transition.fromClipID)
            contextClipIDs.insert(transition.toClipID)
        }
        let selections = orderedTimelineClipIDs(in: contextClipIDs).compactMap { timeline.clipSelection(for: $0) }
        guard !selections.isEmpty || selectedTimelineTransition != nil else {
            turnStatus = "AIに相談する前にタイムラインのクリップまたはトランジションを選択してください。"
            return false
        }

        let evidenceByClipID = Dictionary(uniqueKeysWithValues: selections.compactMap { selection -> (TimelineClip.ID, ClipEvidence)? in
            guard let evidence = evidenceStore?.evidence(for: selection.clip) else { return nil }
            return (selection.clip.id, evidence)
        })
        let existingNotesByClipID = Dictionary(uniqueKeysWithValues: selections.compactMap { selection -> (TimelineClip.ID, ProjectEditorClipNote)? in
            guard let note = editorAnnotations?.note(for: selection.clip.id) else { return nil }
            return (selection.clip.id, note)
        })

        agentPrompt = TimelineAgentConsultationPrompt.make(
            project: selectedProject,
            repositoryRoot: repositoryRoot,
            timeline: timeline,
            intent: selectedTimelineAgentIntent,
            selectedClips: selections,
            selectedTransition: selectedTimelineTransition,
            evidenceByClipID: evidenceByClipID,
            qaIssuesByClipID: qaDashboard?.latestIssuesByClipID ?? [:],
            existingNotesByClipID: existingNotesByClipID
        )
        let targetLabel = timelineAgentSelectionLabel
        turnStatus = "\(targetLabel) の読み取り専用AI相談プロンプトを準備しました。"
        roughCutCompileStatus = "\(targetLabel) をAIに相談する準備をしました。読み取り専用で実行すると提案だけを返します。"
        return true
    }

    @discardableResult
    func prepareTimelineSelectionAgentPrompt(intent: TimelineAgentConsultationIntent) -> Bool {
        selectedTimelineAgentIntent = intent
        return prepareTimelineSelectionAgentPrompt()
    }

    func prepareAndRunTimelineSelectionAgentPrompt() {
        guard prepareTimelineSelectionAgentPrompt() else { return }

        let targetLabel = timelineAgentSelectionLabel
        guard activeSession != nil, activeThreadID != nil else {
            turnStatus = "\(targetLabel) のAI相談プロンプトを準備しました。Agentセッションを開始すると読み取り専用で実行できます。"
            roughCutCompileStatus = "\(targetLabel) のAI相談を準備しました。Agentセッション開始後に読み取り専用で実行してください。"
            return
        }

        runAgentTurn()
    }

    func prepareAndRunTimelineSelectionAgentPrompt(intent: TimelineAgentConsultationIntent) {
        selectedTimelineAgentIntent = intent
        prepareAndRunTimelineSelectionAgentPrompt()
    }
}

struct AgentTurnRecord: Identifiable, Equatable {
    var id: String { turnID }
    let turnID: String
    let title: String
    let projectName: String
    let status: String
    let readOnly: Bool
    let approvedWrite: Bool
    let plannedWriteScopes: [String]
    let engineStatus: String?
    let assistantText: String
    let events: [CodexTurnEventRecord]
    let eventMethods: [String]
    let artifactDiffs: [ProjectArtifactDiff]
    let writeViolations: [VideoOSAgentWriteViolation]
    let startedAt: Date
    let durationMs: Int?

    var sandboxLabel: String {
        readOnly ? "読み取り専用" : "ワークスペース書き込み"
    }

    var approvalLabel: String {
        if readOnly { return "不要" }
        return approvedWrite ? "承認済み" : "未承認"
    }
}

struct AgentJobApproval: Identifiable, Equatable {
    var id: String { "\(projectID)-\(job.id)" }
    let job: VideoOSAgentJob
    let projectID: String
    let projectName: String
    let projectURL: URL
    let prompt: String
    let ragContextQuery: String?
    let ragContextItemCount: Int

    init(job: VideoOSAgentJob, project: ProjectSummary, prompt: String, ragContext: ProjectRAGContextPack?) {
        self.job = job
        projectID = project.id
        projectName = project.name
        projectURL = project.path
        self.prompt = prompt
        ragContextQuery = ragContext?.query
        ragContextItemCount = ragContext?.items.count ?? 0
    }

    var ragContextSummary: String {
        guard let ragContextQuery, ragContextItemCount > 0 else {
            return "なし"
        }
        return "\(ragContextQuery) から \(ragContextItemCount)件の根拠"
    }
}

private extension TimelineTransition {
    var localizedViewerLabel: String {
        switch transitionType {
        case "crossfade":
            return "クロスフェード"
        case "dip_to_black":
            return "Dip"
        case "match_cut_soft":
            return "Match"
        default:
            return transitionType
        }
    }
}
