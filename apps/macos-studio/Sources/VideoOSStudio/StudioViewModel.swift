import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

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

    @Published var repositoryRoot: URL
    @Published var projects: [ProjectSummary] = []
    @Published var selectedProjectID: ProjectSummary.ID? {
        didSet { publishAgentMenuCommandAvailability() }
    }
    @Published var projectInitializationStatus = "Create or link a source project to begin."
    @Published var isInitializingProject = false
    @Published var selectedSurface: StudioAgentSurface = .ingest
    @Published var timeline: TimelineDocument?
    @Published var timelineStatus = "No project selected."
    @Published var analysisRunPlan = ProjectAnalysisRunPlanner.plan(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var analysisRunStatus = "No project selected."
    @Published var isRunningAnalysis = false
    @Published var roughCutCompilePlan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var roughCutCompileStatus = "No project selected."
    @Published var isCompilingRoughCut = false
    @Published var roughCutCompileActivity: RoughCutCompileActivity = .idle
    @Published var feedbackSession = StudioFeedbackSession()
    @Published var qaDashboard: QADashboardDocument?
    @Published var changedClipIDs: [String] = []
    @Published var recentlyChangedClipIDs: Set<String> = []
    @Published var changedClipHighlightTimer: Timer?
    @Published var selectedTimelineClipID: TimelineClip.ID? {
        didSet {
            loadSelectedClipNoteDraft()
            publishAgentMenuCommandAvailability()
        }
    }
    @Published var playheadFrame = 0
    @Published var mediaPlaybackSyncGeneration = 0
    @Published var audioPlaybackSyncGeneration = 0
    @Published var monitorAudioMuted = false
    @Published var monitorAudioVolume = 0.85
    @Published var timelineAudioWaveforms: [TimelineAudioWaveform] = []
    @Published var audioWaveformStatus = "No waveform loaded."
    @Published var isPlaying = false
    @Published var evidenceStore: ProjectEvidenceStore?
    @Published var candidateDataSource: CandidateBrowserDataSource?
    @Published var isSwapBrowserPresented = false
    @Published var isFootageSearchPresented = false
    @Published var swapBrowserClip: TimelineClip?
    @Published var mediaPreviewSummary = ProjectMediaPreviewSummary(items: [])
    @Published var mediaSourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var mediaProxyPlan = ProjectMediaProxyPlan(items: [])
    @Published var mediaProxyOperationStatus = "Proxy builder idle."
    @Published var isBuildingMediaProxies = false
    @Published var mediaRelinkPlan: ProjectMediaRelinkPlan?
    @Published var mediaRelinkStatus = "No relink folder selected."
    @Published var isRelinkingMedia = false
    @Published var syntheticMediaStatus = "Synthetic demo media idle."
    @Published var isBuildingSyntheticMedia = false
    @Published var studioSyntheticSmokeStatus = "Synthetic studio smoke not run."
    @Published var isRunningStudioSyntheticSmoke = false
    @Published var studioAcceptanceSmokeStatus = "Studio acceptance smoke not run."
    @Published var isRunningStudioAcceptanceSmoke = false
    @Published var handoffExportPlan: ProjectHandoffExportPlan?
    @Published var handoffExportStatus = "No project selected."
    @Published var isExportingPremiereXML = false
    @Published var editorPacketPlan: ProjectEditorPacketPlan?
    @Published var editorPacketStatus = "No project selected."
    @Published var editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var isExportingEditorPacket = false
    @Published var renderPackageStatus = ProjectRenderPackageStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var renderRunPlan = ProjectRenderRunPlanner.plan(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var renderRunStatus = "No project selected."
    @Published var isRunningRender = false
    @Published var playbackContractStatus = ProjectPlaybackContractStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var policyStatus = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: URL(fileURLWithPath: "/"))
    @Published var marlinEvaluationStatus = ProjectMarlinEvaluationStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
    @Published var marlinPreferenceDecision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: URL(fileURLWithPath: "/"))
    @Published var marlinEvaluationQueue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: URL(fileURLWithPath: "/"))
    @Published var marlinRepresentativePlan = ProjectMarlinRepresentativePlanReader.plan(repositoryRoot: URL(fileURLWithPath: "/"))
    @Published var marlinEvaluationRunPlan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var marlinRuntimeStatus = ProjectMarlinRuntimeStatusReader.uncheckedStatus(repositoryRoot: URL(fileURLWithPath: "/"))
    @Published var marlinModelAccessStatus = ProjectMarlinModelAccessStatusReader.uncheckedStatus(repositoryRoot: URL(fileURLWithPath: "/"))
    @Published var marlinEvaluationRunStatus = "No project selected."
    @Published var isRunningMarlinEvaluation = false
    @Published var audioStoryGraphRunPlan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: URL(fileURLWithPath: "/"), projectURL: URL(fileURLWithPath: "/"))
    @Published var audioStoryGraphRunStatus = "No project selected."
    @Published var isBuildingAudioStoryGraph = false
    @Published var editorAnnotations: ProjectEditorAnnotationsDocument?
    @Published var editorAnnotationSummary: ProjectEditorAnnotationSummary?
    @Published var editorAnnotationStatus = "No project selected."
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
    @Published var studioReadinessActionStatus = "Select an action from Studio Readiness to run the next operational step."
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
    @Published var appServerDetail = "Run a handshake check before starting agent work."
    @Published var activeThreadID: String? {
        didSet { publishAgentMenuCommandAvailability() }
    }
    @Published var activeModel: String?
    @Published var agentPrompt = "Reply with the current Video OS project status in one concise paragraph. Do not modify files."
    @Published var selectedJob: VideoOSAgentJob = .status {
        didSet { publishAgentMenuCommandAvailability() }
    }
    @Published var pendingApproval: AgentJobApproval? {
        didSet { publishAgentMenuCommandAvailability() }
    }
    @Published var turnStatus = "No turn has run."
    @Published var turnTranscript = ""
    @Published var turnHistory: [AgentTurnRecord] = []
    @Published var selectedTurnID: AgentTurnRecord.ID?
    private var activeSession: CodexAppServerSession?
    private var playbackTimer: Timer?
    private var playbackSyncState = TimelinePlaybackSyncState()
    private var audioPlaybackSyncState = TimelinePlaybackSyncState()
    private var commandObserverTokens: [NSObjectProtocol] = []
    private var userSelectedProject = false
    private var feedbackSessionProjectID: ProjectSummary.ID?

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

    var programTimelineClip: TimelineClipSelection? {
        timeline?.programSelection(atFrame: playheadFrame)
    }

    var programAudioTimelineClip: TimelineClipSelection? {
        timeline?.audioProgramSelection(atFrame: playheadFrame)
    }

    var nextProgramTimelineClip: TimelineClipSelection? {
        timeline?.programSelection(afterFrame: playheadFrame)
    }

    var selectedClipEvidence: ClipEvidence? {
        guard let clip = selectedTimelineClip?.clip else { return nil }
        return evidenceStore?.evidence(for: clip)
    }

    var selectedClipNote: ProjectEditorClipNote? {
        guard let clipID = selectedTimelineClipID else { return nil }
        return editorAnnotations?.note(for: clipID)
    }

    var selectedMediaReference: ProjectMediaReference? {
        guard let project = selectedProject, let selection = selectedTimelineClip else { return nil }
        return ProjectMediaResolver.resolveSelectedClip(
            projectURL: project.path,
            clip: selection.clip,
            assets: evidenceStore?.assets
        )
    }

    var programMediaReference: ProjectMediaReference? {
        guard let project = selectedProject else { return nil }
        let timelinePreview = timelinePreviewMediaReference(project: project)
        guard let selection = programTimelineClip else {
            return ProjectMediaResolver.preferredProgramMedia(
                timelinePreview: timelinePreview,
                source: selectedMediaReference
            )
        }
        let source = ProjectMediaResolver.resolveSelectedClip(
            projectURL: project.path,
            clip: selection.clip,
            assets: evidenceStore?.assets,
            previewTimeUS: selection.clip.sourceTimeUS(atTimelineFrame: playheadFrame)
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
            previewTimeUS: selection.clip.sourceTimeUS(atTimelineFrame: playheadFrame)
        )
    }

    var nextProgramMediaReference: ProjectMediaReference? {
        guard let project = selectedProject, let selection = nextProgramTimelineClip else { return nil }
        return ProjectMediaResolver.resolveSelectedClip(
            projectURL: project.path,
            clip: selection.clip,
            assets: evidenceStore?.assets,
            previewTimeUS: selection.clip.sourceTimeUS(atTimelineFrame: selection.clip.timelineInFrame)
        )
    }

    private func timelinePreviewMediaReference(project: ProjectSummary) -> ProjectMediaReference? {
        let seconds = timeline?.sequence.framesToSeconds(playheadFrame) ?? 0
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

    private func installCommandObservers() {
        commandObserverTokens = [
            observe(.initializeStudioProject) { $0.chooseAndInitializeProject() },
            observe(.refreshStudioProjects) { $0.refresh() },
            observe(.runStudioAnalysis) { $0.runSelectedProjectAnalysis() },
            observe(.compileStudioRoughCut) { $0.compileSelectedProjectRoughCut() },
            observe(.compileStudioReviewPatch) { $0.compileSelectedProjectWithReviewPatch() },
            observe(.runStudioReviewJob) { $0.runReviewAgentJob() },
            observe(.rebuildStudioSearchIndex) { $0.rebuildSelectedProjectIndex() },
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
            observe(.toggleStudioPlayback) { $0.togglePlayback() },
            observe(.stepStudioPlaybackBackward) { $0.stepBackward() },
            observe(.stepStudioPlaybackForward) { $0.stepForward() }
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

    var commandAvailabilityContext: StudioCommandAvailabilityContext {
        StudioCommandAvailabilityContext(
            hasSelectedProject: selectedProject != nil,
            isAppServerChecking: appServerStatus == .checking,
            hasActiveThread: activeThreadID != nil,
            selectedAgentJobCanRun: selectedJobCanRun,
            hasPendingApproval: pendingApproval != nil
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
        StudioMenuCommandAvailabilityStore.shared.context = commandAvailabilityContext
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
            marlinEvaluationRunStatus = "No project selected."
            return
        }
        guard marlinEvaluationRunPlan.canRun else {
            marlinEvaluationRunStatus = "Marlin evaluation is not runnable: \(marlinEvaluationRunPlan.readinessLabel)."
            return
        }
        marlinEvaluationRunStatus = marlinRuntimeStatus.isReadyForLiveMarlin
            ? (marlinModelAccessStatus.isReadyForLiveMarlin
                ? "Ready to evaluate \(marlinEvaluationRunPlan.sourceCount) source files."
                : "Marlin model access is not ready: \(marlinModelAccessStatus.readinessLabel).")
            : "Marlin live runtime is not ready: \(marlinRuntimeStatus.readinessLabel)."
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
            projectInitializationStatus = "Project creation cancelled."
            return
        }

        let panel = NSOpenPanel()
        panel.title = "Choose Source Media Folder"
        panel.prompt = "Link Source"
        panel.message = "Choose the folder that contains source footage and audio for \(projectID). It will be linked into 02_media/source."
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.directoryURL = repositoryRoot
        panel.identifier = NSUserInterfaceItemIdentifier("ProjectInitializer.SourceFolderPanel")

        guard panel.runModal() == .OK, let sourceURL = panel.urls.first else {
            projectInitializationStatus = "Source folder selection cancelled."
            return
        }

        initializeProject(projectID: projectID, sourceDirectory: sourceURL)
    }

    private func promptForProjectID() -> String? {
        let alert = NSAlert()
        alert.messageText = "New Video OS Project"
        alert.informativeText = "Enter a stable project id. Use letters, numbers, dots, underscores, or hyphens."
        let createButton = alert.addButton(withTitle: "Create")
        createButton.setAccessibilityIdentifier("ProjectInitializer.CreateButton")
        let cancelButton = alert.addButton(withTitle: "Cancel")
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
            projectInitializationStatus = "Creating \(plan.projectID)..."

            Task.detached(priority: .userInitiated) {
                do {
                    let result = try ProjectInitializer.run(plan: plan)
                    await MainActor.run {
                        self.isInitializingProject = false
                        self.refresh()
                        self.selectProject(result.plan.projectID, userInitiated: false)
                        self.projectInitializationStatus = result.sourceLinkURL == nil
                            ? "Created \(result.plan.projectID)."
                            : "Created \(result.plan.projectID) and linked source media."
                    }
                } catch {
                    await MainActor.run {
                        self.isInitializingProject = false
                        self.projectInitializationStatus = "Project creation failed: \(error)"
                    }
                }
            }
        } catch {
            projectInitializationStatus = "Project creation failed: \(error)"
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
            mediaPreviewSummary = ProjectMediaPreviewSummary(items: [])
            mediaSourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            mediaProxyPlan = ProjectMediaProxyPlan(items: [])
            mediaProxyOperationStatus = "No project selected."
            isBuildingMediaProxies = false
            mediaRelinkPlan = nil
            mediaRelinkStatus = "No project selected."
            isRelinkingMedia = false
            syntheticMediaStatus = "No project selected."
            isBuildingSyntheticMedia = false
            studioSyntheticSmokeStatus = "No project selected."
            isRunningStudioSyntheticSmoke = false
            studioAcceptanceSmokeStatus = "No project selected."
            isRunningStudioAcceptanceSmoke = false
            handoffExportPlan = nil
            handoffExportStatus = "No project selected."
            isExportingPremiereXML = false
            editorPacketPlan = nil
            editorPacketStatus = "No project selected."
            editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            isExportingEditorPacket = false
            renderPackageStatus = ProjectRenderPackageStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            renderRunPlan = ProjectRenderRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            renderRunStatus = "No project selected."
            isRunningRender = false
            playbackContractStatus = ProjectPlaybackContractStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            policyStatus = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: repositoryRoot)
            marlinEvaluationStatus = ProjectMarlinEvaluationStatusReader.status(projectURL: URL(fileURLWithPath: "/"), repositoryRoot: repositoryRoot)
            marlinEvaluationRunPlan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            marlinEvaluationRunStatus = "No project selected."
            isRunningMarlinEvaluation = false
            audioStoryGraphRunPlan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            audioStoryGraphRunStatus = "No project selected."
            isBuildingAudioStoryGraph = false
            editorAnnotations = nil
            editorAnnotationSummary = nil
            editorAnnotationStatus = "No project selected."
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
            studioReadinessActionStatus = "No project selected."
            planningStatus = ProjectPlanningStatusReader.status(projectURL: URL(fileURLWithPath: "/"))
            analysisRunPlan = ProjectAnalysisRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            analysisRunStatus = "No project selected."
            isRunningAnalysis = false
            roughCutCompilePlan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
            roughCutCompileStatus = "No project selected."
            isCompilingRoughCut = false
            roughCutCompileActivity = .idle
            clearChangedClipHighlight()
            selectedTimelineClipID = nil
            timelineAudioWaveforms = []
            audioWaveformStatus = "No project selected."
            playbackSyncState = TimelinePlaybackSyncState(generation: mediaPlaybackSyncGeneration)
            audioPlaybackSyncState = TimelinePlaybackSyncState(generation: audioPlaybackSyncGeneration)
            mediaPlaybackSyncGeneration += 1
            audioPlaybackSyncGeneration += 1
            indexSearchResults = []
            indexContextPack = ProjectRAGContextPack(query: "", items: [])
            indexOperationStatus = "No project selected."
            timelineStatus = "No project selected."
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
        analysisRunPlan = ProjectAnalysisRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: URL(fileURLWithPath: "/"))
        analysisRunStatus = "Checking source analysis readiness..."
        refreshAnalysisRunPlan(projectID: project.id, projectURL: project.path)
        roughCutCompilePlan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: repositoryRoot, projectURL: project.path)
        roughCutCompileStatus = roughCutCompilePlan.canRun
            ? "Ready to compile timeline.json."
            : "Compile is not runnable: \(roughCutCompilePlan.readinessLabel)."
        mediaSourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: project.path, assets: evidenceStore?.assets)
        mediaProxyPlan = ProjectMediaProxyPlanner.plan(projectURL: project.path, assets: evidenceStore?.assets)
        mediaProxyOperationStatus = mediaProxyPlan.pendingCount > 0
            ? "\(mediaProxyPlan.pendingCount) preview proxies are ready to build."
            : "No preview proxies needed."
        mediaRelinkPlan = nil
        mediaRelinkStatus = mediaPreviewSummary.missingCount > 0
            ? "\(mediaPreviewSummary.missingCount) missing media files need relink."
            : "No media relinks needed."
        syntheticMediaStatus = mediaPreviewSummary.missingCount > 0
            ? "Synthetic demo media can create previewable sources for QA."
            : "Synthetic demo media not needed."
        handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: repositoryRoot, projectURL: project.path, assets: evidenceStore?.assets)
        handoffExportStatus = handoffExportPlan?.readinessLabel ?? "Handoff not checked."
        editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: repositoryRoot, projectURL: project.path, assets: evidenceStore?.assets)
        editorPacketStatus = editorPacketPlan?.readinessLabel ?? "Editor packet not checked."
        editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: project.path)
        renderPackageStatus = ProjectRenderPackageStatusReader.status(projectURL: project.path)
        renderRunPlan = ProjectRenderRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: project.path)
        renderRunStatus = renderRunPlan.canRun
            ? "Ready to render/package final output."
            : "Render is not runnable: \(renderRunPlan.readinessLabel)."
        playbackContractStatus = ProjectPlaybackContractStatusReader.status(projectURL: project.path)
        policyStatus = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: repositoryRoot)
        intentSummary = ProjectIntentSummaryReader.summary(projectURL: project.path)
        intentAlignmentStatus = ProjectIntentAlignmentStatusReader.status(projectURL: project.path)
        reviewArtifactStatus = ProjectReviewArtifactStatusReader.status(projectURL: project.path)
        qaDashboard = QADashboardDocument.load(projectURL: project.path)
        pipelineGateStatus = ProjectPipelineGateStatusReader.status(repositoryRoot: repositoryRoot, projectURL: project.path)
        studioReadinessStatus = ProjectStudioReadinessStatusReader.status(repositoryRoot: repositoryRoot, projectURL: project.path)
        studioGoalStatus = makeStudioGoalStatus(projectURL: project.path)
        studioReadinessActionStatus = "Studio readiness loaded for \(project.name)."
        marlinEvaluationStatus = ProjectMarlinEvaluationStatusReader.status(projectURL: project.path, repositoryRoot: repositoryRoot)
        marlinEvaluationRunPlan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: project.path, assets: evidenceStore?.assets)
        updateMarlinEvaluationRunReadiness()
        audioStoryGraphRunPlan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: project.path)
        audioStoryGraphRunStatus = audioStoryGraphRunPlan.canRun
            ? "Ready to build the audio story graph from transcript, BGM, and audio-event evidence."
            : "Audio story graph is not runnable: \(audioStoryGraphRunPlan.readinessLabel)."
        loadEditorAnnotations(project: project, timeline: nil)
        indexStatus = ProjectSQLiteIndex.status(projectURL: project.path)
        planningStatus = ProjectPlanningStatusReader.status(projectURL: project.path)
        refreshLibraryReadiness(projectURL: project.path)
        indexOperationStatus = indexStatus.exists
            ? "Index ready: \(indexStatus.documentCount) searchable documents."
            : "Build the SQLite index for material search and RAG context."
        guard project.hasTimeline else {
            feedbackSession.clearBaseline()
            pausePlayback()
            timeline = nil
            selectedTimelineClipID = nil
            timelineAudioWaveforms = []
            audioWaveformStatus = "Compile the project before waveform extraction."
            setPlayheadFrame(0, forceSeek: true)
            timelineStatus = "Compile the project to create 05_timeline/timeline.json."
            return
        }

        do {
            timeline = try TimelineDocument.load(projectURL: project.path)
            if let timeline {
                if !feedbackSession.isDirty {
                    feedbackSession.captureBaseline(from: timeline)
                }
                timelineStatus = "\(timeline.sequence.name) / \(timeline.displayTracks.count) tracks / \(formatSeconds(timeline.totalSeconds))"
                if timeline.clipSelection(for: selectedTimelineClipID) == nil {
                    selectedTimelineClipID = nil
                }
                loadEditorAnnotations(project: project, timeline: timeline)
                setPlayheadFrame(min(playheadFrame, timeline.totalFrames), forceSeek: true)
                loadAudioWaveforms(project: project, timeline: timeline)
            }
        } catch {
            feedbackSession.clearBaseline()
            pausePlayback()
            timeline = nil
            selectedTimelineClipID = nil
            timelineAudioWaveforms = []
            audioWaveformStatus = "Waveform unavailable: timeline failed to load."
            setPlayheadFrame(0, forceSeek: true)
            timelineStatus = "Failed to read timeline.json: \(error.localizedDescription)"
        }
    }

    private func refreshAnalysisRunPlan(projectID: ProjectSummary.ID, projectURL: URL) {
        let root = repositoryRoot
        let options = ProjectAnalysisRunOptions.nativeLocalDefaults
        Task.detached(priority: .utility) {
            let plan = ProjectAnalysisRunPlanner.plan(repositoryRoot: root, projectURL: projectURL, options: options)
            await MainActor.run {
                guard self.selectedProjectID == projectID else { return }
                self.analysisRunPlan = plan
                self.analysisRunStatus = plan.canRun
                    ? "Ready to analyze \(plan.sourceCount) linked source files locally."
                    : "Analysis is not runnable: \(plan.readinessLabel)."
            }
        }
    }

    private func loadAudioWaveforms(project: ProjectSummary, timeline: TimelineDocument) {
        let projectURL = project.path
        let assets = evidenceStore?.assets
        timelineAudioWaveforms = []
        audioWaveformStatus = "Extracting audio waveforms..."

        Task.detached(priority: .userInitiated) {
            let map = ProjectAudioWaveformMap.build(projectURL: projectURL, timeline: timeline, assets: assets)
            await MainActor.run {
                self.timelineAudioWaveforms = map.waveforms
                self.audioWaveformStatus = map.waveforms.isEmpty
                    ? "No readable audio waveform sources."
                    : "Loaded \(map.waveforms.count) waveform lanes."
            }
        }
    }

    private func formatSeconds(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        let minutes = total / 60
        let remainder = total % 60
        return "\(minutes)m \(String(format: "%02d", remainder))s"
    }

    func selectTimelineClip(_ clipID: TimelineClip.ID) {
        selectedTimelineClipID = clipID
        if let clip = timeline?.clipSelection(for: clipID)?.clip {
            setPlayheadFrame(clip.timelineInFrame, forceSeek: true)
        }
    }

    func approveSelectedTimelineClip() {
        guard let clipID = selectedTimelineClipID else {
            roughCutCompileStatus = "Select a timeline clip before approving."
            return
        }
        feedbackSession.approvedClipIDs.insert(clipID)
        roughCutCompileStatus = "Approved \(clipID)."
    }

    func rejectSelectedTimelineClip() {
        guard let clipID = selectedTimelineClipID else {
            roughCutCompileStatus = "Select a timeline clip before rejecting."
            return
        }
        feedbackSession.addOp(.removeSegment(target_clip_id: clipID, reason: "Rejected by operator"))
        feedbackSession.rejectedClipIDs.insert(clipID)
        roughCutCompileStatus = "Rejected \(clipID)."
    }

    func openSwapBrowserForSelectedClip() {
        guard let clip = selectedTimelineClip?.clip else {
            roughCutCompileStatus = "Select a timeline clip before opening Swap."
            return
        }
        openSwapBrowser(for: clip)
    }

    func saveSelectedClipNote() {
        guard let selectedProject, let clipID = selectedTimelineClipID else {
            editorAnnotationStatus = "Select a timeline clip before saving a note."
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
            editorPacketStatus = editorPacketPlan?.readinessLabel ?? "Editor packet not checked."
            editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: selectedProject.path)
            refreshLibraryReadiness(projectURL: selectedProject.path)
            editorAnnotationStatus = "Saved note for \(clipID)."
            loadSelectedClipNoteDraft()
        } catch {
            editorAnnotationStatus = "Note save failed: \(error)"
        }
    }

    func clearSelectedClipNote() {
        guard let selectedProject, let clipID = selectedTimelineClipID else {
            editorAnnotationStatus = "Select a timeline clip before clearing a note."
            return
        }
        do {
            editorAnnotations = try ProjectEditorAnnotationStore.removeNote(projectURL: selectedProject.path, clipID: clipID)
            editorAnnotationSummary = ProjectEditorAnnotationStore.summary(projectURL: selectedProject.path, timeline: timeline)
            editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path, assets: evidenceStore?.assets)
            editorPacketStatus = editorPacketPlan?.readinessLabel ?? "Editor packet not checked."
            editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: selectedProject.path)
            refreshLibraryReadiness(projectURL: selectedProject.path)
            selectedClipNoteDraft = ""
            selectedClipHandoffInstructionDraft = ""
            editorAnnotationStatus = "Cleared note for \(clipID)."
        } catch {
            editorAnnotationStatus = "Note clear failed: \(error)"
        }
    }

    func proposeSelectedClipNoteWithCodex() {
        runSelectedClipAnnotationProposal(job: nil)
    }

    private func runSelectedClipAnnotationProposal(job: VideoOSAgentJob?) {
        guard appServerStatus != .checking else { return }
        guard let selectedProject, let timeline, let selection = selectedTimelineClip else {
            editorAnnotationStatus = "Select a timeline clip before asking Codex."
            appServerDetail = "Select a timeline clip before running the clip note job."
            return
        }
        guard let activeSession, let activeThreadID else {
            editorAnnotationStatus = "Start an agent session before asking Codex."
            appServerDetail = "Start an agent session before running the clip note job."
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
        editorAnnotationStatus = "Codex is proposing an editor note..."
        turnStatus = "Annotation proposal running..."
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
                turnStatus = "Turn \(summary.turnId): \(summary.status)"
                turnTranscript = summary.assistantText
                if let proposal = ProjectEditorAnnotationProposal.extract(from: summary.assistantText, expectedClipID: clipID) {
                    selectedClipNoteDraft = proposal.note
                    selectedClipHandoffInstructionDraft = proposal.handoffInstruction
                    editorAnnotationStatus = "Codex proposal applied to draft for \(clipID). Save to write it."
                } else {
                    editorAnnotationStatus = "Codex returned no parseable proposal for \(clipID)."
                }

                let record = AgentTurnRecord(
                    turnID: summary.turnId,
                    title: job?.title ?? "Annotation Proposal",
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
                turnStatus = "Annotation proposal failed"
                editorAnnotationStatus = "Codex proposal failed: \(error)"
            }
        }
    }

    private func loadEditorAnnotations(project: ProjectSummary, timeline: TimelineDocument?) {
        editorAnnotations = ProjectEditorAnnotationStore.load(projectURL: project.path)
        editorAnnotationSummary = ProjectEditorAnnotationStore.summary(projectURL: project.path, timeline: timeline)
        editorAnnotationStatus = editorAnnotationSummary?.statusLabel ?? "No editor annotations."
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
        pausePlayback()
        setPlayheadFrame(frame, forceSeek: true)
    }

    func jumpToQATimestamp(_ timestampSec: Double) {
        guard let timeline else { return }
        pausePlayback()
        let target = timeline.qaTimestampJumpTarget(for: timestampSec)
        setPlayheadFrame(target.frame, forceSeek: true)
        selectedTimelineClipID = target.clipID
    }

    func togglePlayback() {
        isPlaying ? pausePlayback() : startPlayback()
    }

    func toggleMonitorAudioMute() {
        monitorAudioMuted.toggle()
    }

    func setMonitorAudioVolume(_ volume: Double) {
        monitorAudioVolume = max(0, min(volume, 1))
        if monitorAudioVolume > 0 {
            monitorAudioMuted = false
        }
    }

    func startPlayback() {
        guard let timeline else { return }
        if playheadFrame >= timeline.totalFrames {
            setPlayheadFrame(0, forceSeek: true)
        }
        isPlaying = true
        playbackTimer?.invalidate()
        let interval = 1.0 / min(max(timeline.sequence.fps, 1), 60)
        playbackTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.advancePlaybackTick()
            }
        }
    }

    func pausePlayback() {
        isPlaying = false
        playbackTimer?.invalidate()
        playbackTimer = nil
    }

    func stepBackward() {
        pausePlayback()
        guard let timeline else { return }
        let step = max(1, Int(timeline.sequence.fps.rounded()))
        setPlayheadFrame(max(0, playheadFrame - step), forceSeek: true)
    }

    func stepForward() {
        pausePlayback()
        guard let timeline else { return }
        let step = max(1, Int(timeline.sequence.fps.rounded()))
        setPlayheadFrame(min(timeline.totalFrames, playheadFrame + step), forceSeek: true)
    }

    private func advancePlaybackTick() {
        guard let timeline else {
            pausePlayback()
            return
        }
        guard playheadFrame < timeline.totalFrames else {
            pausePlayback()
            return
        }
        setPlayheadFrame(min(timeline.totalFrames, playheadFrame + 1), forceSeek: false)
        if playheadFrame >= timeline.totalFrames {
            pausePlayback()
        }
    }

    private func setPlayheadFrame(_ frame: Int, forceSeek: Bool) {
        let maxFrame = timeline?.totalFrames ?? max(frame, 0)
        let nextFrame = max(0, min(frame, maxFrame))
        playheadFrame = nextFrame
        let nextGeneration = playbackSyncState.update(timeline: timeline, frame: nextFrame, forceSeek: forceSeek)
        if nextGeneration != mediaPlaybackSyncGeneration {
            mediaPlaybackSyncGeneration = nextGeneration
        }
        let audioClipID = timeline?.audioProgramSelection(atFrame: nextFrame)?.clip.id
        let nextAudioGeneration = audioPlaybackSyncState.update(currentClipID: audioClipID, forceSeek: forceSeek)
        if nextAudioGeneration != audioPlaybackSyncGeneration {
            audioPlaybackSyncGeneration = nextAudioGeneration
        }
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
        turnStatus = "No active session."
    }

    func runAgentTurn() {
        runPromptTurn(agentPrompt, readOnly: true, job: nil, project: selectedProject, approvedWrite: false)
    }

    func runSelectedJob() {
        guard let selectedProject else {
            appServerStatus = .failed
            appServerDetail = "Select a project before running a job."
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
            turnStatus = "Approval required for \(selectedJob.title). \(activeAgentRAGContextSummary)"
            return
        }
        runPromptTurn(prompt, readOnly: selectedJob.readOnly, job: selectedJob, project: selectedProject, approvedWrite: false)
    }

    func runReviewAgentJob() {
        selectedSurface = .review
        selectedJob = .review
        runSelectedJob()
    }

    func performStudioReadinessAction(_ action: ProjectStudioReadinessAction) {
        selectedSurface = surface(for: action)
        guard selectedProject != nil || action.id == "codex-runtime" || action.id == "marlin-default" else {
            studioReadinessActionStatus = "Select a project before running \(action.title)."
            return
        }

        guard let command = action.command else {
            studioReadinessActionStatus = "Open the \(action.title) panel and complete the missing project input."
            return
        }

        switch command {
        case let value where value.contains("app-server-smoke"):
            studioReadinessActionStatus = "Checking Codex App Server..."
            checkAppServer()
        case let value where value.contains("analysis-run"):
            studioReadinessActionStatus = "Running source analysis..."
            runSelectedProjectAnalysis()
        case let value where value.contains("index-rebuild"):
            studioReadinessActionStatus = "Rebuilding the material/RAG index..."
            rebuildSelectedProjectIndex()
        case let value where value.contains("media-relink-plan"):
            if value.contains("--from-source-map") {
                studioReadinessActionStatus = "Relinking from source-map suggested roots..."
                relinkSelectedProjectMediaFromSourceMap()
            } else {
                studioReadinessActionStatus = "Opening relink picker for missing media..."
                chooseAndRelinkSelectedProjectMedia()
            }
        case let value where value.contains("media-proxy-build"):
            studioReadinessActionStatus = "Building preview proxies..."
            buildSelectedProjectMediaProxies()
        case let value where value.contains("audio-story"):
            studioReadinessActionStatus = "Building audio story evidence..."
            buildSelectedProjectAudioStoryGraph()
        case let value where value.contains("marlin-eval-run"):
            studioReadinessActionStatus = "Running Marlin temporal VLM evaluation..."
            runSelectedProjectMarlinEvaluation()
        case let value where value.contains("marlin-eval-next"):
            studioReadinessActionStatus = "Running next queued Marlin temporal VLM evaluation..."
            runNextMarlinEvaluation()
        case let value where value.contains("marlin-preference-apply"):
            studioReadinessActionStatus = "Applying Marlin-first temporal VLM policy..."
            applyMarlinPreferencePolicy()
        case let value where value.contains("marlin-representative-plan"):
            refreshMarlinRepresentativePlan()
        case let value where value.contains("agent-prompt"):
            runAgentJob(fromReadinessCommand: value, action: action)
        case let value where value.contains("compile-run"):
            studioReadinessActionStatus = value.contains("--review-patch")
                ? "Applying review patch through the deterministic compiler..."
                : "Compiling rough-cut timeline..."
            if value.contains("--review-patch") {
                compileSelectedProjectWithReviewPatch()
            } else {
                compileSelectedProjectRoughCut()
            }
        case let value where value.contains("handoff-export-packet"):
            studioReadinessActionStatus = "Exporting editor handoff packet..."
            exportSelectedProjectEditorPacket()
        case let value where value.contains("handoff-packet-status"):
            refresh()
            studioReadinessActionStatus = "Refreshed editor handoff readiness."
        case let value where value.contains("render-run"):
            studioReadinessActionStatus = "Running final render/package..."
            runSelectedProjectRender()
        case let value where value.contains("render-status") || value.contains("gate-status") || value.contains("library-status"):
            refresh()
            studioReadinessActionStatus = "Refreshed Studio readiness status."
        default:
            studioReadinessActionStatus = "No GUI runner is wired for: \(command)"
        }
    }

    func copyStudioReadinessActionCommand(_ action: ProjectStudioReadinessAction) {
        guard let command = action.command else {
            studioReadinessActionStatus = "\(action.title) has no CLI command to copy."
            return
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        studioReadinessActionStatus = "Copied command for \(action.title)."
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
        if command.contains("marlin-eval-run") {
            return !isRunningMarlinEvaluation
                && marlinEvaluationRunPlan.canRun
                && marlinRuntimeStatus.isReadyForLiveMarlin
                && marlinModelAccessStatus.isReadyForLiveMarlin
        }
        if command.contains("marlin-eval-next") {
            return !isRunningMarlinEvaluation
                && marlinEvaluationQueue.runnableProjectCount > 0
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
            return "No project"
        }
        guard let command = action.command else {
            return "Manual input"
        }
        if command.contains("agent-prompt"), activeThreadID == nil { return nil }
        if command.contains("analysis-run"), !analysisRunPlan.canRun {
            return analysisRunPlan.readinessLabel
        }
        if command.contains("audio-story"), !audioStoryGraphRunPlan.canRun {
            return audioStoryGraphRunPlan.readinessLabel
        }
        if command.contains("marlin-eval-run"), !marlinEvaluationRunPlan.canRun {
            return marlinEvaluationRunPlan.readinessLabel
        }
        if (command.contains("marlin-eval-run") || command.contains("marlin-eval-next")), !marlinRuntimeStatus.isReadyForLiveMarlin {
            return marlinRuntimeStatus.readinessLabel
        }
        if (command.contains("marlin-eval-run") || command.contains("marlin-eval-next")), !marlinModelAccessStatus.isReadyForLiveMarlin {
            return marlinModelAccessStatus.readinessLabel
        }
        if command.contains("marlin-eval-next"), marlinEvaluationQueue.runnableProjectCount == 0 {
            return marlinEvaluationQueue.readinessLabel
        }
        if command.contains("marlin-preference-apply"), !marlinPreferenceDecision.canPreferMarlinAsDefault {
            return marlinPreferenceDecision.decisionLabel
        }
        if command.contains("media-relink-plan"), command.contains("--from-source-map"), let selectedProject {
            let suggestions = ProjectMediaRelinker.suggestedSearchRoots(projectURL: selectedProject.path)
            if suggestions.isEmpty {
                return "No suggested roots"
            }
            if suggestions.allSatisfy({ !$0.exists }) {
                return "Source volume not mounted"
            }
        }
        if command.contains("compile-run"), !roughCutCompilePlan.canRun {
            return roughCutCompilePlan.readinessLabel
        }
        if command.contains("handoff-export-packet"), editorPacketPlan?.canExportPacket != true {
            return editorPacketPlan?.readinessLabel ?? "Not ready"
        }
        if command.contains("render-run"), !renderRunPlan.canRun {
            return renderRunPlan.readinessLabel
        }
        if !canPerformStudioReadinessAction(action) {
            return "Running"
        }
        return nil
    }

    private func runAgentJob(fromReadinessCommand command: String, action: ProjectStudioReadinessAction) {
        guard let job = agentJob(fromReadinessCommand: command) else {
            studioReadinessActionStatus = "No Codex job is mapped for \(action.title)."
            return
        }
        selectedJob = job
        selectedSurface = surface(for: job)
        guard activeThreadID != nil else {
            studioReadinessActionStatus = "Starting Codex session for \(job.title)..."
            startAgentSession(afterStart: {
                self.studioReadinessActionStatus = "Opening Codex approval gate for \(job.title). \(self.activeAgentRAGContextSummary)"
                self.runSelectedJob()
            })
            return
        }
        studioReadinessActionStatus = "Opening Codex approval gate for \(job.title). \(activeAgentRAGContextSummary)"
        runSelectedJob()
    }

    func studioReadinessActionButtonTitle(_ action: ProjectStudioReadinessAction) -> String {
        guard let command = action.command else { return "Open" }
        if command.contains("agent-prompt"), activeThreadID == nil {
            return "Start & Run"
        }
        return action.isBlocking ? "Run" : "Open"
    }

    private func refreshMarlinRepresentativePlan() {
        marlinPreferenceDecision = ProjectMarlinPreferenceDecisionReader.status(repositoryRoot: repositoryRoot)
        marlinEvaluationQueue = ProjectMarlinEvaluationQueueReader.queue(repositoryRoot: repositoryRoot)
        marlinRepresentativePlan = ProjectMarlinRepresentativePlanReader.plan(repositoryRoot: repositoryRoot)
        if let selectedProject {
            studioGoalStatus = makeStudioGoalStatus(projectURL: selectedProject.path)
        }
        studioReadinessActionStatus = "Refreshed representative Marlin evaluation plan: \(marlinRepresentativePlan.coveredBucketCount)/\(marlinRepresentativePlan.targetBucketCount) buckets covered."
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
        turnStatus = "\(approval.job.title) was not run."
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
            appServerDetail = "Start an agent session before running a turn."
            return
        }
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty else { return }

        appServerStatus = .checking
        turnStatus = "Turn running..."
        turnTranscript = ""
        let startedAt = Date()
        let turnTitle = job?.title ?? "Custom Prompt"
        let resolvedProjectName = projectName ?? selectedProject?.name ?? "Repository"
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
                turnStatus = engineStatus.map { "Turn \(summary.turnId): \(summary.status) / \($0)" } ?? "Turn \(summary.turnId): \(summary.status)"
                turnTranscript = summary.assistantText.isEmpty
                    ? "No assistant text was streamed. Events: \(summary.eventMethods.joined(separator: ", "))"
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
                    editorPacketStatus = editorPacketPlan?.readinessLabel ?? "Editor packet not checked."
                    editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                }
            } catch {
                appServerStatus = .failed
                turnStatus = "Turn failed"
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
            return "compile engine blocked: \(decision.reason)"
        }

        let plan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: repositoryRoot, projectURL: projectURL)
        guard plan.canRun else {
            return "compile engine not run: \(plan.readinessLabel)"
        }

        let result = try await Task.detached(priority: .userInitiated) {
            try ProjectRoughCutCompileRunner.run(plan: plan)
        }.value

        if result.succeeded {
            let docs = result.indexSummary?.searchDocumentCount ?? 0
            return "compile engine completed: \(docs) searchable documents"
        }
        return "compile engine failed: exit \(result.exitCode)"
    }

    func rebuildSelectedProjectIndex() {
        guard let selectedProject else {
            indexOperationStatus = "Select a project before rebuilding the index."
            return
        }
        indexOperationStatus = "Rebuilding SQLite index..."
        let project = selectedProject

        Task {
            do {
                let summary = try await Task.detached(priority: .userInitiated) {
                    try ProjectSQLiteIndex.rebuild(projectURL: project.path)
                }.value
                indexStatus = ProjectSQLiteIndex.status(projectURL: project.path)
                refreshLibraryReadiness(projectURL: project.path)
                indexOperationStatus = "Indexed \(summary.searchDocumentCount) docs: \(summary.assetCount) assets, \(summary.segmentCount) segments, \(summary.audioEventCount) audio events, \(summary.audioStoryNodeCount) audio nodes, \(summary.bgmBeatCount) BGM beats, \(summary.continuityEntityCount) continuity entities, \(summary.editorialPreferenceCount) preferences."
                if !indexSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    searchSelectedProjectIndex()
                }
            } catch {
                indexOperationStatus = "Index rebuild failed: \(error)"
            }
        }
    }

    func runSelectedProjectAnalysis() {
        guard let selectedProject else {
            analysisRunStatus = "Select a project before running analysis."
            return
        }

        guard analysisRunPlan.projectURL == selectedProject.path else {
            analysisRunStatus = "Analysis readiness is still loading."
            refreshAnalysisRunPlan(projectID: selectedProject.id, projectURL: selectedProject.path)
            return
        }

        let plan = analysisRunPlan
        guard plan.canRun else {
            analysisRunStatus = "Analysis is not runnable: \(plan.readinessLabel)."
            return
        }

        isRunningAnalysis = true
        analysisRunStatus = "Analyzing \(plan.sourceCount) source files locally..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectAnalysisRunner.run(plan: plan)
                let refreshedPlan = ProjectAnalysisRunPlanner.plan(
                    repositoryRoot: plan.repositoryRoot,
                    projectURL: selectedProject.path,
                    options: plan.options
                )
                await MainActor.run {
                    self.isRunningAnalysis = false
                    self.evidenceStore = ProjectEvidenceStore.load(projectURL: selectedProject.path)
                    self.analysisRunPlan = refreshedPlan
                    self.planningStatus = ProjectPlanningStatusReader.status(projectURL: selectedProject.path)
                    self.indexStatus = ProjectSQLiteIndex.status(projectURL: selectedProject.path)
                    self.mediaPreviewSummary = ProjectMediaResolver.previewSummary(projectURL: selectedProject.path, assets: self.evidenceStore?.assets)
                    self.mediaSourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: selectedProject.path, assets: self.evidenceStore?.assets)
                    self.mediaProxyPlan = ProjectMediaProxyPlanner.plan(projectURL: selectedProject.path, assets: self.evidenceStore?.assets)
                    self.marlinEvaluationStatus = ProjectMarlinEvaluationStatusReader.status(projectURL: selectedProject.path, repositoryRoot: self.repositoryRoot)
                    self.marlinEvaluationRunPlan = ProjectMarlinEvaluationRunPlanner.plan(repositoryRoot: self.repositoryRoot, projectURL: selectedProject.path, assets: self.evidenceStore?.assets)
                    self.refreshLibraryReadiness(projectURL: selectedProject.path)
                    self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: self.repositoryRoot, projectURL: selectedProject.path, assets: self.evidenceStore?.assets)
                    self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: self.repositoryRoot, projectURL: selectedProject.path, assets: self.evidenceStore?.assets)
                    self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: selectedProject.path)
                    self.mediaPlaybackSyncGeneration += 1
                    self.audioPlaybackSyncGeneration += 1
                    if result.succeeded {
                        let docs = result.indexSummary?.searchDocumentCount ?? self.indexStatus.documentCount
                        self.indexOperationStatus = "Index refreshed after analysis: \(docs) searchable documents."
                        self.analysisRunStatus = "Local analysis completed for \(result.plan.sourceCount) sources."
                    } else {
                        self.analysisRunStatus = "Analysis failed with exit \(result.exitCode)."
                    }
                }
            } catch {
                await MainActor.run {
                    self.isRunningAnalysis = false
                    self.analysisRunStatus = "Analysis failed: \(error)"
                }
            }
        }
    }

    func compileSelectedProjectRoughCut() {
        compileSelectedProjectRoughCut(
            options: ProjectRoughCutCompileOptions(),
            statusPrefix: "Compiling timeline.json...",
            activity: .roughCut
        )
    }

    func compileSelectedProjectWithReviewPatch() {
        guard let selectedProject else {
            roughCutCompileStatus = "Select a project before applying a review patch."
            return
        }
        let patchURL = selectedProject.path.appendingPathComponent("06_review/review_patch.json")
        guard FileManager.default.fileExists(atPath: patchURL.path) else {
            roughCutCompileStatus = "Review patch is not available."
            return
        }
        compileSelectedProjectRoughCut(
            options: ProjectRoughCutCompileOptions(patchURL: patchURL),
            statusPrefix: "Applying review_patch.json and recompiling timeline...",
            activity: .reviewPatch
        )
    }

    func applyStudioPatch() {
        guard let selectedProject else {
            roughCutCompileStatus = "Select a project before applying Studio feedback."
            return
        }
        guard let timeline else {
            roughCutCompileStatus = "Compile the project before applying Studio feedback."
            return
        }
        guard feedbackSession.isDirty else {
            roughCutCompileStatus = "No pending Studio patch operations."
            return
        }

        let conflicts = feedbackSession.detectConflicts()
        guard conflicts.isEmpty else {
            presentStudioPatchConflictAlert(conflicts)
            roughCutCompileStatus = "Studio patch has \(conflicts.count) conflict(s)."
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
            roughCutCompileStatus = "Studio patch compile is not runnable: \(preflightPlan.readinessLabel)."
            return
        }
        guard !envelope.patch.operations.isEmpty else {
            roughCutCompileStatus = "No compiler-bound Studio patch operations to apply."
            return
        }

        do {
            let currentTimelineHash = try Self.fileHash16(at: timelineURL)
            if !envelope.base_timeline_hash.isEmpty, envelope.base_timeline_hash != currentTimelineHash {
                presentStudioPatchStaleAlert()
                roughCutCompileStatus = "Studio patch is stale; reload the timeline before applying."
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
                roughCutCompileStatus = "Studio patch compile is not runnable: \(plan.readinessLabel)."
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
            roughCutCompileStatus = "Applying Studio patch and refreshing preview..."

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
                            reason: "Studio patch compile failed with exit \(result.exitCode)."
                        )
                        return
                    }
                    guard let resultHash else {
                        self.rollbackFailedStudioPatch(
                            patchURL: patchURL,
                            backupURL: backupURL,
                            timelineURL: timelineURL,
                            reason: "Studio patch compile did not produce a readable timeline hash."
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
                            reason: "Studio patch history save failed: \(error)."
                        )
                        return
                    }
                    self.feedbackSession.clearAll()
                    self.feedbackSession.pruneHistory(projectURL: projectURL)
                    self.refresh()
                    self.showChangedClipHighlight(uniqueChangedClipIDs)
                    self.jumpToFirstChangedClip(changedClipIDs: uniqueChangedClipIDs, fallbackFrame: firstChangedFrame)
                    self.roughCutCompileStatus = "Timeline updated. \(uniqueChangedClipIDs.count) clips changed."
                    self.indexOperationStatus = "Index rebuild skipped for Studio preview; run rebuild if search context is stale."
                } catch {
                    self.isCompilingRoughCut = false
                    self.roughCutCompileActivity = .idle
                    self.rollbackFailedStudioPatch(
                        patchURL: patchURL,
                        backupURL: backupURL,
                        timelineURL: timelineURL,
                        reason: "Studio patch compile failed: \(error)."
                    )
                }
            }
        } catch {
            roughCutCompileStatus = "Studio patch failed before compile: \(error)"
        }
    }

    func undoLastPatch() {
        guard let selectedProject else {
            roughCutCompileStatus = "Select a project before undoing a Studio patch."
            return
        }

        let projectURL = selectedProject.path
        var historyIndex = PatchHistoryIndex.load(projectURL: projectURL)
        guard let record = historyIndex.records.last else {
            roughCutCompileStatus = "No Studio patch history to undo."
            return
        }
        guard record.purged != true else {
            roughCutCompileStatus = "Last Studio patch backup was purged and cannot be restored."
            return
        }

        let backupURL = projectURL.appendingPathComponent(record.timeline_backup_path)
        let timelineURL = TimelineDocument.timelineURL(for: projectURL)
        guard FileManager.default.fileExists(atPath: backupURL.path) else {
            roughCutCompileStatus = "Last Studio patch backup is missing."
            return
        }
        guard !record.result_timeline_hash.isEmpty else {
            roughCutCompileStatus = "Cannot safely undo Studio patch: result timeline hash is missing."
            return
        }

        do {
            let currentTimelineHash = try Self.fileHash16(at: timelineURL)
            guard currentTimelineHash == record.result_timeline_hash else {
                roughCutCompileStatus = "Cannot safely undo Studio patch: timeline.json changed outside Studio."
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
            feedbackSession.loadHistory(projectURL: projectURL)
            refresh()
            clearChangedClipHighlight()
            roughCutCompileStatus = "Reverted to previous timeline."
        } catch {
            roughCutCompileStatus = "Undo Studio patch failed: \(error)"
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
            roughCutCompileStatus = "\(reason) timeline.json restored from backup."
        } catch {
            Self.cleanupStudioPatchArtifacts(patchURL: patchURL, backupURL: nil)
            refresh()
            roughCutCompileStatus = "\(reason) Rollback failed: \(error). Backup retained at \(backupURL.path)."
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
            Task { @MainActor in
                timer.invalidate()
                withAnimation(.easeOut(duration: 5.0)) {
                    self?.recentlyChangedClipIDs = []
                }
                self?.changedClipHighlightTimer = nil
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
            selectedTimelineClipID = nil
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
            roughCutCompileStatus = "Select a project before promoting a Studio patch."
            return
        }
        let historyIndex = PatchHistoryIndex.load(projectURL: selectedProject.path)
        guard let latestRecord = historyIndex.records.last else {
            roughCutCompileStatus = "No applied Studio patch to promote."
            return
        }
        let promotableOps = latestAppliedPromotableOps(projectURL: selectedProject.path, historyIndex: historyIndex)
        guard !promotableOps.isEmpty else {
            roughCutCompileStatus = "Latest Studio patch has no promotable replace/remove operations."
            return
        }
        let patchURL = selectedProject.path.appendingPathComponent(latestRecord.patch_path)
        let plan = ProjectStudioPatchPromotionPlanner.plan(
            repositoryRoot: repositoryRoot,
            projectURL: selectedProject.path,
            patchURL: patchURL
        )
        guard plan.canRun else {
            roughCutCompileStatus = "Studio patch promotion is not runnable: \(plan.readinessLabel)."
            return
        }

        roughCutCompileStatus = "Promoting Studio patch to planning artifacts..."
        Task {
            do {
                let result = try await Task.detached(priority: .userInitiated) {
                    try ProjectStudioPatchPromotionRunner.run(plan: plan)
                }.value
                if result.succeeded, let output = result.output {
                    self.refresh()
                    self.roughCutCompileStatus = "Studio patch promoted to planning. \(output.modified_beat_ids.count) beat(s) updated."
                } else {
                    let detail = result.output?.warnings.joined(separator: " ") ?? result.stderr
                    self.roughCutCompileStatus = "Studio patch promotion failed: \(detail)"
                }
            } catch {
                self.roughCutCompileStatus = "Studio patch promotion failed: \(error)"
            }
        }
    }

    func openSwapBrowser(for clip: TimelineClip) {
        selectedTimelineClipID = clip.id
        swapBrowserClip = clip
        isSwapBrowserPresented = true
        roughCutCompileStatus = "Swap browser opened for \(clip.id)."
        if candidateDataSource == nil, let selectedProject {
            loadCandidateDataSource(project: selectedProject)
        }
    }

    func openFootageSearch() {
        guard selectedProject != nil else {
            roughCutCompileStatus = "Select a project before searching footage."
            return
        }
        isFootageSearchPresented = true
        roughCutCompileStatus = "Footage search opened."
    }

    func openFootageSearch(for clip: TimelineClip) {
        selectedTimelineClipID = clip.id
        swapBrowserClip = clip
        isFootageSearchPresented = true
        roughCutCompileStatus = "Footage search opened for \(clip.id)."
    }

    func previewFootageSearchResult(_ result: FootageSearchRunner.SearchResult) {
        guard let timeline else {
            roughCutCompileStatus = "Compile the project before previewing search results."
            return
        }
        let clips = timeline.displayTracks.flatMap(\.clips)
        guard let clip = clips.first(where: { $0.segmentID == result.segment_id }) else {
            roughCutCompileStatus = "\(result.segment_id) is not in the current timeline."
            return
        }
        selectTimelineClip(clip.id)
        roughCutCompileStatus = "Previewing \(result.segment_id) in the current timeline."
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
        alert.messageText = "Studio Patch Conflict"
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
        alert.messageText = "Timeline Changed"
        alert.informativeText = "The timeline changed after this Studio patch baseline was captured. Reload the project and rebuild the pending feedback."
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
        for url in [patchURL, backupURL].compactMap(\.self) where fileManager.fileExists(atPath: url.path) {
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
            roughCutCompileStatus = "Select a project before compiling a rough cut."
            return
        }

        let plan = ProjectRoughCutCompilePlanner.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path, options: options)
        roughCutCompilePlan = plan
        guard plan.canRun else {
            roughCutCompileStatus = "Compile is not runnable: \(plan.readinessLabel)."
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
                        self.indexOperationStatus = "Index refreshed after compile: \(docs) searchable documents."
                        self.roughCutCompileStatus = result.plan.options.patchURL == nil
                            ? "Rough cut compiled and timeline.json is ready."
                            : "Review patch applied and timeline.json was recompiled."
                    } else {
                        self.roughCutCompileStatus = "Compile failed with exit \(result.exitCode)."
                    }
                }
            } catch {
                await MainActor.run {
                    self.isCompilingRoughCut = false
                    self.roughCutCompileActivity = .idle
                    self.roughCutCompileStatus = "Compile failed: \(error)"
                }
            }
        }
    }

    func buildSelectedProjectMediaProxies() {
        guard let selectedProject else {
            mediaProxyOperationStatus = "Select a project before building proxies."
            return
        }
        guard mediaProxyPlan.pendingCount > 0 else {
            mediaProxyOperationStatus = "No pending preview proxies."
            return
        }

        let projectURL = selectedProject.path
        let assets = evidenceStore?.assets
        isBuildingMediaProxies = true
        mediaProxyOperationStatus = "Building \(mediaProxyPlan.pendingCount) preview proxies..."

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
                    self.mediaProxyOperationStatus = "Proxy build finished with \(result.failureCount) failures after \(result.builtCount) builds."
                } else if result.builtCount > 0 {
                    self.mediaProxyOperationStatus = "Built \(result.builtCount) preview proxies."
                } else {
                    self.mediaProxyOperationStatus = "No preview proxies were built."
                }
            }
        }
    }

    func performViewerDiagnosticAction(_ action: ProjectViewerReadinessDiagnostic.Action) {
        selectedSurface = .ingest
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
            mediaRelinkStatus = "Review the current preview source in the Media panel."
        }
    }

    func chooseAndRelinkSelectedProjectMedia(includeSynthetic: Bool = false) {
        guard selectedProject != nil else {
            mediaRelinkStatus = "Select a project before relinking media."
            return
        }

        let panel = NSOpenPanel()
        panel.title = includeSynthetic ? "Replace Synthetic Media" : "Relink Missing Media"
        panel.prompt = "Relink"
        panel.message = includeSynthetic
            ? "Choose one or more folders or files to search for real source media that should replace generated synthetic previews."
            : "Choose one or more folders or files to search for the selected project's missing source media."
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false

        guard panel.runModal() == .OK, !panel.urls.isEmpty else {
            mediaRelinkStatus = "Relink cancelled."
            return
        }
        relinkSelectedProjectMedia(searchRoots: panel.urls, includeSynthetic: includeSynthetic)
    }

    func relinkSelectedProjectMediaFromSourceMap(includeSynthetic: Bool = false) {
        guard let selectedProject else {
            mediaRelinkStatus = "Select a project before relinking media."
            return
        }

        let suggestions = ProjectMediaRelinker.suggestedSearchRoots(projectURL: selectedProject.path)
        guard !suggestions.isEmpty else {
            mediaRelinkStatus = "No source-map search roots were found."
            return
        }

        let roots = suggestions.filter(\.exists).map(\.url)
        guard !roots.isEmpty else {
            mediaRelinkStatus = "Source-map roots found, but none are currently mounted."
            return
        }

        mediaRelinkStatus = includeSynthetic
            ? "Scanning \(roots.count) mounted source-map roots including synthetic previews."
            : "Scanning \(roots.count) mounted source-map roots."
        relinkSelectedProjectMedia(searchRoots: roots, includeSynthetic: includeSynthetic)
    }

    func relinkSelectedProjectMedia(searchRoots: [URL], includeSynthetic: Bool = false) {
        guard let selectedProject else {
            mediaRelinkStatus = "Select a project before relinking media."
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
            mediaRelinkStatus = "Relink scan found no matching files."
            return
        }

        isRelinkingMedia = true
        mediaRelinkStatus = "Relinking \(plan.matchedCount) media files..."

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
                    self.handoffExportStatus = self.handoffExportPlan?.readinessLabel ?? "Handoff not checked."
                    self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: self.repositoryRoot, projectURL: projectURL, assets: self.evidenceStore?.assets)
                    self.editorPacketStatus = self.editorPacketPlan?.readinessLabel ?? "Editor packet not checked."
                    self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                    self.refreshLibraryReadiness(projectURL: projectURL)
                    self.mediaPlaybackSyncGeneration += 1
                    self.audioPlaybackSyncGeneration += 1
                    if let timeline = self.timeline {
                        self.loadAudioWaveforms(project: selectedProject, timeline: timeline)
                    }
                    self.mediaRelinkStatus = "Relinked \(result.linkedCount) files. \(self.mediaPreviewSummary.missingCount) missing; \(self.mediaPreviewSummary.syntheticPreviewCount) synthetic previews remain."
                }
            } catch {
                await MainActor.run {
                    self.isRelinkingMedia = false
                    self.mediaRelinkStatus = "Relink failed: \(error)"
                }
            }
        }
    }

    func buildSelectedProjectSyntheticMedia() {
        guard let selectedProject else {
            syntheticMediaStatus = "Select a project before building synthetic media."
            return
        }

        let projectURL = selectedProject.path
        let assets = evidenceStore?.assets
        isBuildingSyntheticMedia = true
        syntheticMediaStatus = "Building synthetic demo media..."

        Task.detached(priority: .userInitiated) {
            let result = ProjectSyntheticMediaBuilder.build(projectURL: projectURL, assets: assets, durationSeconds: 5)
            await MainActor.run {
                self.isBuildingSyntheticMedia = false
                self.evidenceStore = ProjectEvidenceStore.load(projectURL: projectURL)
                self.mediaPreviewSummary = ProjectMediaResolver.previewSummary(projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.mediaSourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.mediaProxyPlan = ProjectMediaProxyPlanner.plan(projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: self.repositoryRoot, projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.handoffExportStatus = self.handoffExportPlan?.readinessLabel ?? "Handoff not checked."
                self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: self.repositoryRoot, projectURL: projectURL, assets: self.evidenceStore?.assets)
                self.editorPacketStatus = self.editorPacketPlan?.readinessLabel ?? "Editor packet not checked."
                self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                self.refreshLibraryReadiness(projectURL: projectURL)
                self.mediaPlaybackSyncGeneration += 1
                self.audioPlaybackSyncGeneration += 1
                if let timeline = self.timeline {
                    self.loadAudioWaveforms(project: selectedProject, timeline: timeline)
                }
                if result.failureCount > 0 {
                    self.syntheticMediaStatus = "Synthetic media build failed for \(result.failureCount) assets."
                } else {
                    self.syntheticMediaStatus = "Built \(result.builtCount), skipped \(result.skippedCount), mapped \(result.mappedCount)."
                }
            }
        }
    }

    func runStudioSyntheticSmoke() {
        guard !isRunningStudioSyntheticSmoke else { return }
        let root = repositoryRoot
        isRunningStudioSyntheticSmoke = true
        studioSyntheticSmokeStatus = "Running full synthetic studio smoke..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectStudioSyntheticSmoke.run(repositoryRoot: root, durationSeconds: 1)
                let status = result.succeeded
                    ? "Synthetic studio smoke passed: render=\(result.renderResult.status.readinessLabel), packet media=\(result.editorPacketMediaCount), score=\(result.studioStatus.scoreLabel)."
                    : "Synthetic studio smoke failed: render=\(result.renderResult.status.readinessLabel), packet media=\(result.editorPacketMediaCount), score=\(result.studioStatus.scoreLabel)."
                ProjectStudioSyntheticSmoke.removeProject(result)
                await MainActor.run {
                    self.isRunningStudioSyntheticSmoke = false
                    self.studioSyntheticSmokeStatus = status
                }
            } catch {
                await MainActor.run {
                    self.isRunningStudioSyntheticSmoke = false
                    self.studioSyntheticSmokeStatus = "Synthetic studio smoke failed: \(error)"
                }
            }
        }
    }

    func runStudioAcceptanceSmoke() {
        guard !isRunningStudioAcceptanceSmoke else { return }
        let root = repositoryRoot
        isRunningStudioAcceptanceSmoke = true
        studioAcceptanceSmokeStatus = "Running Codex App Server and studio acceptance smoke..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectStudioAcceptanceSmoke.run(repositoryRoot: root, durationSeconds: 1)
                let studio = result.studioSmokeResult
                let status = result.succeeded
                    ? "Acceptance smoke passed: app-server=\(result.appServerResponse.platformFamily)/\(result.appServerResponse.platformOs), render=\(studio.renderResult.status.readinessLabel), packet media=\(studio.editorPacketMediaCount), score=\(studio.studioStatus.scoreLabel)."
                    : "Acceptance smoke failed: app-server=\(result.appServerResponse.platformFamily)/\(result.appServerResponse.platformOs), render=\(studio.renderResult.status.readinessLabel), packet media=\(studio.editorPacketMediaCount), score=\(studio.studioStatus.scoreLabel)."
                ProjectStudioAcceptanceSmoke.removeProject(result)
                await MainActor.run {
                    self.isRunningStudioAcceptanceSmoke = false
                    self.studioAcceptanceSmokeStatus = status
                }
            } catch {
                await MainActor.run {
                    self.isRunningStudioAcceptanceSmoke = false
                    self.studioAcceptanceSmokeStatus = "Acceptance smoke failed: \(error)"
                }
            }
        }
    }

    func runSelectedProjectMarlinEvaluation() {
        guard let selectedProject else {
            marlinEvaluationRunStatus = "Select a project before running Marlin evaluation."
            return
        }
        let plan = ProjectMarlinEvaluationRunPlanner.plan(
            repositoryRoot: repositoryRoot,
            projectURL: selectedProject.path,
            assets: evidenceStore?.assets
        )
        guard plan.canRun else {
            marlinEvaluationRunPlan = plan
            marlinEvaluationRunStatus = "Marlin evaluation is not runnable: \(plan.readinessLabel)."
            return
        }
        marlinRuntimeStatus = ProjectMarlinRuntimeStatusReader.status(repositoryRoot: repositoryRoot)
        guard marlinRuntimeStatus.isReadyForLiveMarlin else {
            marlinEvaluationRunPlan = plan
            marlinEvaluationRunStatus = "Marlin live runtime is not ready: \(marlinRuntimeStatus.readinessLabel). \(marlinRuntimeStatus.setupCommand)"
            return
        }
        marlinModelAccessStatus = ProjectMarlinModelAccessStatusReader.status(
            repositoryRoot: repositoryRoot,
            pythonBinary: marlinRuntimeStatus.pythonBinary
        )
        guard marlinModelAccessStatus.isReadyForLiveMarlin else {
            marlinEvaluationRunPlan = plan
            marlinEvaluationRunStatus = "Marlin model access is not ready: \(marlinModelAccessStatus.readinessLabel). \(marlinModelAccessStatus.recommendation)"
            studioReadinessActionStatus = marlinEvaluationRunStatus
            return
        }

        isRunningMarlinEvaluation = true
        marlinEvaluationRunPlan = plan
        marlinEvaluationRunStatus = "Running Marlin evaluation for \(plan.sourceCount) source files..."

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
                        self.indexOperationStatus = "Index refreshed after Marlin: \(indexSummary.marlinEventCount) events, \(indexSummary.marlinFindResultCount) finds."
                        self.marlinEvaluationRunStatus = "Marlin evaluation completed and refreshed \(indexSummary.searchDocumentCount) search documents."
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

    func runNextMarlinEvaluation() {
        let next = ProjectMarlinEvaluationNextPlanner.plan(repositoryRoot: repositoryRoot)
        guard let item = next.item, let plan = next.runPlan, plan.canRun else {
            marlinEvaluationRunStatus = "No runnable queued Marlin evaluation: \(next.recommendation)"
            studioReadinessActionStatus = marlinEvaluationRunStatus
            return
        }
        marlinRuntimeStatus = ProjectMarlinRuntimeStatusReader.status(repositoryRoot: repositoryRoot)
        guard marlinRuntimeStatus.isReadyForLiveMarlin else {
            marlinEvaluationRunStatus = "Marlin live runtime is not ready: \(marlinRuntimeStatus.readinessLabel). \(marlinRuntimeStatus.setupCommand)"
            studioReadinessActionStatus = marlinEvaluationRunStatus
            return
        }
        marlinModelAccessStatus = ProjectMarlinModelAccessStatusReader.status(
            repositoryRoot: repositoryRoot,
            pythonBinary: marlinRuntimeStatus.pythonBinary
        )
        guard marlinModelAccessStatus.isReadyForLiveMarlin else {
            marlinEvaluationRunStatus = "Marlin model access is not ready: \(marlinModelAccessStatus.readinessLabel). \(marlinModelAccessStatus.recommendation)"
            studioReadinessActionStatus = marlinEvaluationRunStatus
            return
        }

        isRunningMarlinEvaluation = true
        marlinEvaluationRunPlan = plan
        marlinEvaluationRunStatus = "Running queued Marlin evaluation for \(item.id) with \(plan.sourceCount) source files..."

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
                        self.marlinEvaluationRunStatus = "Queued Marlin evaluation completed for \(item.id); refreshed \(indexSummary.searchDocumentCount) search documents."
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
            audioStoryGraphRunStatus = "Select a project before building the audio story graph."
            return
        }
        let plan = ProjectAudioStoryGraphRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path)
        audioStoryGraphRunPlan = plan
        guard plan.canRun else {
            audioStoryGraphRunStatus = "Audio story graph is not runnable: \(plan.readinessLabel)."
            return
        }

        isBuildingAudioStoryGraph = true
        audioStoryGraphRunStatus = "Building audio story graph..."

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
                        self.indexOperationStatus = "Index refreshed after audio story graph: \(indexSummary.audioStoryNodeCount) audio nodes."
                        self.audioStoryGraphRunStatus = "Audio story graph built and indexed: \(indexSummary.audioStoryNodeCount) nodes / \(indexSummary.searchDocumentCount) docs."
                    } else {
                        self.audioStoryGraphRunStatus = "Audio story graph failed with exit \(result.exitCode): \(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))"
                    }
                }
            } catch {
                await MainActor.run {
                    self.isBuildingAudioStoryGraph = false
                    self.audioStoryGraphRunStatus = "Audio story graph failed: \(error)"
                }
            }
        }
    }

    func exportSelectedProjectPremiereXML() {
        guard let selectedProject else {
            handoffExportStatus = "Select a project before exporting."
            return
        }
        guard let plan = handoffExportPlan, plan.canExportPremiereXML else {
            handoffExportStatus = handoffExportPlan?.readinessLabel ?? "Handoff not ready."
            return
        }

        let root = repositoryRoot
        let projectURL = selectedProject.path
        let assets = evidenceStore?.assets
        isExportingPremiereXML = true
        handoffExportStatus = "Exporting Premiere XML..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectHandoffExporter.exportPremiereXML(repositoryRoot: root, projectURL: projectURL, assets: assets)
                await MainActor.run {
                    self.isExportingPremiereXML = false
                    self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.handoffExportStatus = "Exported \(result.outputURL.lastPathComponent)"
                    self.editorPacketStatus = self.editorPacketPlan?.readinessLabel ?? "Editor packet not checked."
                    self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                }
            } catch {
                await MainActor.run {
                    self.isExportingPremiereXML = false
                    self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.handoffExportStatus = "Export failed: \(error)"
                    self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                }
            }
        }
    }

    func exportSelectedProjectEditorPacket() {
        guard let selectedProject else {
            editorPacketStatus = "Select a project before exporting an editor packet."
            return
        }
        guard let plan = editorPacketPlan, plan.canExportPacket else {
            editorPacketStatus = editorPacketPlan?.readinessLabel ?? "Editor packet not ready."
            return
        }

        let root = repositoryRoot
        let projectURL = selectedProject.path
        let assets = evidenceStore?.assets
        isExportingEditorPacket = true
        editorPacketStatus = "Exporting editor packet..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectEditorPacketExporter.export(repositoryRoot: root, projectURL: projectURL, assets: assets)
                await MainActor.run {
                    self.isExportingEditorPacket = false
                    self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.handoffExportStatus = "Premiere XML ready for packet."
                    self.editorPacketStatus = "Exported packet with \(result.files.count) files."
                    self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                }
            } catch {
                await MainActor.run {
                    self.isExportingEditorPacket = false
                    self.handoffExportPlan = ProjectHandoffExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.editorPacketPlan = ProjectEditorPacketExporter.plan(repositoryRoot: root, projectURL: projectURL, assets: assets)
                    self.editorPacketStatus = "Packet export failed: \(error)"
                    self.editorPacketVerificationStatus = ProjectEditorPacketVerificationStatusReader.status(projectURL: projectURL)
                }
            }
        }
    }

    func runSelectedProjectRender() {
        guard let selectedProject else {
            renderRunStatus = "Select a project before rendering."
            return
        }

        let plan = ProjectRenderRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path)
        renderRunPlan = plan
        guard plan.canRun else {
            renderRunStatus = "Render is not runnable: \(plan.readinessLabel)."
            return
        }

        isRunningRender = true
        renderRunStatus = "Rendering and packaging final output..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectRenderRunner.run(plan: plan)
                await MainActor.run {
                    self.isRunningRender = false
                    self.renderPackageStatus = ProjectRenderPackageStatusReader.status(projectURL: selectedProject.path)
                    self.renderRunPlan = ProjectRenderRunPlanner.plan(repositoryRoot: self.repositoryRoot, projectURL: selectedProject.path)
                    if result.succeeded {
                        self.renderRunStatus = "Render packaged final output."
                    } else {
                        self.renderRunStatus = "Render failed with exit \(result.exitCode)."
                    }
                }
            } catch {
                await MainActor.run {
                    self.isRunningRender = false
                    self.renderRunStatus = "Render failed: \(error)"
                }
            }
        }
    }

    func revealEditorPacketInFinder() {
        guard let packetURL = editorPacketPlan?.packetURL else {
            editorPacketStatus = "Editor packet path is not available."
            return
        }
        if FileManager.default.fileExists(atPath: packetURL.path) {
            NSWorkspace.shared.activateFileViewerSelecting([packetURL])
            editorPacketStatus = "Revealed editor packet in Finder."
        } else {
            editorPacketStatus = "Export the editor packet before revealing it."
        }
    }

    func searchSelectedProjectIndex() {
        guard let selectedProject else {
            indexOperationStatus = "Select a project before searching."
            return
        }
        let query = indexSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            indexSearchResults = []
            indexContextPack = ProjectRAGContextPack(query: "", items: [])
            indexOperationStatus = "Enter a query to search indexed project evidence."
            return
        }

        do {
            indexSearchResults = try ProjectSQLiteIndex.search(projectURL: selectedProject.path, query: query, limit: 12)
            indexContextPack = ProjectRAGContextPack.build(query: query, results: indexSearchResults)
            indexOperationStatus = "Found \(indexSearchResults.count) index results."
        } catch {
            indexSearchResults = []
            indexContextPack = ProjectRAGContextPack(query: "", items: [])
            indexOperationStatus = "Index search failed. Rebuild the index first."
        }
    }

    func appendIndexContextToAgentPrompt() {
        guard !indexContextPack.isEmpty else {
            indexOperationStatus = "Search indexed project evidence before adding RAG context to Codex."
            return
        }
        let separator = agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : "\n\n"
        agentPrompt += "\(separator)\(indexContextPack.promptText)"
        indexOperationStatus = "Added \(indexContextPack.items.count) cited RAG items to the Codex prompt."
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
        readOnly ? "read-only" : "workspace-write"
    }

    var approvalLabel: String {
        if readOnly { return "not required" }
        return approvedWrite ? "approved" : "missing"
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
            return "none"
        }
        return "\(ragContextItemCount) cited items from \(ragContextQuery)"
    }
}
