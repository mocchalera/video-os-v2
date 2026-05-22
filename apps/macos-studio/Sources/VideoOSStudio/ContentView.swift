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

    @Published var repositoryRoot: URL
    @Published var projects: [ProjectSummary] = []
    @Published var selectedProjectID: ProjectSummary.ID?
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
    @Published var selectedTimelineClipID: TimelineClip.ID? {
        didSet { loadSelectedClipNoteDraft() }
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
    @Published var appServerStatus: AppServerStatus = .unchecked
    @Published var appServerDetail = "Run a handshake check before starting agent work."
    @Published var activeThreadID: String?
    @Published var activeModel: String?
    @Published var agentPrompt = "Reply with the current Video OS project status in one concise paragraph. Do not modify files."
    @Published var selectedJob: VideoOSAgentJob = .status
    @Published var pendingApproval: AgentJobApproval?
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

    init() {
        let root = ProjectScanner.locateRepositoryRoot()
        repositoryRoot = root
        appServerPlan = CodexAppServerLaunchPlan(workspace: root)
        marlinModelAccessStatus = ProjectMarlinModelAccessStatusReader.uncheckedStatus(repositoryRoot: root)
        installCommandObservers()
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
        guard let project = selectedProject, let selection = programTimelineClip else { return selectedMediaReference }
        return ProjectMediaResolver.resolveSelectedClip(
            projectURL: project.path,
            clip: selection.clip,
            assets: evidenceStore?.assets,
            previewTimeUS: selection.clip.sourceTimeUS(atTimelineFrame: playheadFrame)
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

    func refresh() {
        projects = ProjectScanner.scanProjects(in: repositoryRoot)
        if selectedProjectID == nil || !projects.contains(where: { $0.id == selectedProjectID }) {
            selectedProjectID = defaultProjectID()
        }
        loadTimelineForSelection()
        refreshRepositoryWideStatus()
    }

    private func defaultProjectID() -> ProjectSummary.ID? {
        projects.first { $0.hasTimeline && $0.stateLabel == "packaged" }?.id
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
            let sourceMapStatus = ProjectMediaSourceMapStatusReader.status(projectURL: project.path)
            return sourceMapStatus.exists
                && sourceMapStatus.assetCount > 0
                && sourceMapStatus.coveredAssetCount == sourceMapStatus.assetCount
                && sourceMapStatus.brokenEntries.isEmpty
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
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = "client-cut-001"
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
            pausePlayback()
            timeline = nil
            evidenceStore = nil
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
        evidenceStore = ProjectEvidenceStore.load(projectURL: project.path)
        mediaPreviewSummary = ProjectMediaResolver.previewSummary(projectURL: project.path, assets: evidenceStore?.assets)
        analysisRunPlan = ProjectAnalysisRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: project.path)
        analysisRunStatus = analysisRunPlan.canRun
            ? "Ready to analyze \(analysisRunPlan.sourceCount) linked source files."
            : "Analysis is not runnable: \(analysisRunPlan.readinessLabel)."
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
        policyStatus = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: repositoryRoot)
        intentSummary = ProjectIntentSummaryReader.summary(projectURL: project.path)
        intentAlignmentStatus = ProjectIntentAlignmentStatusReader.status(projectURL: project.path)
        reviewArtifactStatus = ProjectReviewArtifactStatusReader.status(projectURL: project.path)
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
                timelineStatus = "\(timeline.sequence.name) / \(timeline.displayTracks.count) tracks / \(formatSeconds(timeline.totalSeconds))"
                if timeline.clipSelection(for: selectedTimelineClipID) == nil {
                    selectedTimelineClipID = nil
                }
                loadEditorAnnotations(project: project, timeline: timeline)
                setPlayheadFrame(min(playheadFrame, timeline.totalFrames), forceSeek: true)
                loadAudioWaveforms(project: project, timeline: timeline)
            }
        } catch {
            pausePlayback()
            timeline = nil
            selectedTimelineClipID = nil
            timelineAudioWaveforms = []
            audioWaveformStatus = "Waveform unavailable: timeline failed to load."
            setPlayheadFrame(0, forceSeek: true)
            timelineStatus = "Failed to read timeline.json: \(error.localizedDescription)"
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
        pipelineGateStatus = ProjectPipelineGateStatusReader.status(repositoryRoot: repositoryRoot, projectURL: projectURL)
        studioReadinessStatus = ProjectStudioReadinessStatusReader.status(repositoryRoot: repositoryRoot, projectURL: projectURL)
        studioGoalStatus = makeStudioGoalStatus(projectURL: projectURL)
    }

    func scrubPlayhead(to frame: Int) {
        pausePlayback()
        setPlayheadFrame(frame, forceSeek: true)
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
        appServerStatus = .checking
        appServerDetail = "Starting Codex App Server over stdio..."

        let root = repositoryRoot
        Task {
            do {
                let response = try await Task.detached(priority: .userInitiated) {
                    let session = CodexAppServerSession(workspace: root)
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
        appServerStatus = .checking
        appServerDetail = "Starting a Codex thread for this repository..."

        let root = repositoryRoot
        Task {
            do {
                let result = try await Task.detached(priority: .userInitiated) {
                    let session = CodexAppServerSession(workspace: root)
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

        let plan = ProjectAnalysisRunPlanner.plan(repositoryRoot: repositoryRoot, projectURL: selectedProject.path)
        analysisRunPlan = plan
        guard plan.canRun else {
            analysisRunStatus = "Analysis is not runnable: \(plan.readinessLabel)."
            return
        }

        isRunningAnalysis = true
        analysisRunStatus = "Analyzing \(plan.sourceCount) source files..."

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectAnalysisRunner.run(plan: plan)
                await MainActor.run {
                    self.isRunningAnalysis = false
                    self.evidenceStore = ProjectEvidenceStore.load(projectURL: selectedProject.path)
                    self.analysisRunPlan = ProjectAnalysisRunPlanner.plan(repositoryRoot: self.repositoryRoot, projectURL: selectedProject.path)
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
                        self.analysisRunStatus = "Analysis completed for \(result.plan.sourceCount) sources."
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
        compileSelectedProjectRoughCut(options: ProjectRoughCutCompileOptions(), statusPrefix: "Compiling timeline.json...")
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
            statusPrefix: "Applying review_patch.json and recompiling timeline..."
        )
    }

    private func compileSelectedProjectRoughCut(
        options: ProjectRoughCutCompileOptions,
        statusPrefix: String
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
        roughCutCompileStatus = statusPrefix

        Task.detached(priority: .userInitiated) {
            do {
                let result = try ProjectRoughCutCompileRunner.run(plan: plan)
                await MainActor.run {
                    self.isCompilingRoughCut = false
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

    func chooseAndRelinkSelectedProjectMedia() {
        guard selectedProject != nil else {
            mediaRelinkStatus = "Select a project before relinking media."
            return
        }

        let panel = NSOpenPanel()
        panel.title = "Relink Missing Media"
        panel.prompt = "Relink"
        panel.message = "Choose one or more folders or files to search for the selected project's missing source media."
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false

        guard panel.runModal() == .OK, !panel.urls.isEmpty else {
            mediaRelinkStatus = "Relink cancelled."
            return
        }
        relinkSelectedProjectMedia(searchRoots: panel.urls)
    }

    func relinkSelectedProjectMediaFromSourceMap() {
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

        mediaRelinkStatus = "Scanning \(roots.count) mounted source-map roots."
        relinkSelectedProjectMedia(searchRoots: roots)
    }

    func relinkSelectedProjectMedia(searchRoots: [URL]) {
        guard let selectedProject else {
            mediaRelinkStatus = "Select a project before relinking media."
            return
        }

        let projectURL = selectedProject.path
        let assets = evidenceStore?.assets
        let plan = ProjectMediaRelinker.plan(projectURL: projectURL, searchRoots: searchRoots, assets: assets)
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
                    self.mediaRelinkStatus = "Relinked \(result.linkedCount) files. \(self.mediaPreviewSummary.missingCount) still missing."
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

struct ContentView: View {
    @StateObject private var model = StudioViewModel()
    @State private var isCommandPalettePresented = false
    @State private var commandPaletteQuery = ""

    var body: some View {
        VStack(spacing: 0) {
            StudioTopBar(
                selectedSurface: $model.selectedSurface,
                onOpenCommandPalette: {
                    commandPaletteQuery = ""
                    isCommandPalettePresented = true
                },
                onRefresh: { model.refresh() }
            )

            Divider()

            ProjectShelf(model: model)

            Divider()

            StudioWorkspaceView(model: model)
        }
        .frame(minWidth: 1180, minHeight: 760)
        .sheet(isPresented: $isCommandPalettePresented) {
            StudioCommandPaletteView(
                model: model,
                query: $commandPaletteQuery,
                isPresented: $isCommandPalettePresented
            )
            .frame(width: 580, height: 540)
        }
        .onReceive(NotificationCenter.default.publisher(for: .openStudioCommandPalette)) { _ in
            commandPaletteQuery = ""
            isCommandPalettePresented = true
        }
    }
}

private struct ProjectShelf: View {
    @ObservedObject var model: StudioViewModel

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Button {
                    model.chooseAndInitializeProject()
                } label: {
                    Label(model.isInitializingProject ? "Creating" : "New Project", systemImage: "folder.badge.plus")
                }
                .disabled(model.isInitializingProject)

                Divider()
                    .frame(height: 24)

                if model.projects.isEmpty {
                    Label("No project folders", systemImage: "folder")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.projects) { project in
                        Button {
                            model.selectProject(project.id)
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: project.hasTimeline ? "timeline.selection" : "folder")
                                Text(project.name)
                                    .lineLimit(1)
                                Text(project.stateLabel)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 2)
                        }
                        .buttonStyle(.bordered)
                        .tint(project.id == model.selectedProjectID ? .accentColor : .secondary)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }
}

private struct StudioTopBar: View {
    @Binding var selectedSurface: StudioAgentSurface
    var onOpenCommandPalette: () -> Void
    var onRefresh: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Picker("Agent Surface", selection: $selectedSurface) {
                ForEach(StudioAgentSurface.allCases) { surface in
                    Text(surface.rawValue).tag(surface)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 720)

            Spacer(minLength: 12)

            Button(action: onOpenCommandPalette) {
                Image(systemName: "command")
            }
            .help("Command Palette")

            Button(action: onRefresh) {
                Image(systemName: "arrow.clockwise")
            }
            .help("Refresh Projects")
        }
        .buttonStyle(.borderless)
        .controlSize(.large)
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(.regularMaterial)
    }
}

private struct StudioCommandPaletteView: View {
    @ObservedObject var model: StudioViewModel
    @Binding var query: String
    @Binding var isPresented: Bool
    @FocusState private var searchFocused: Bool

    private var filteredCommands: [StudioCommandPaletteItem] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let commands = commandItems
        guard !normalized.isEmpty else { return commands }
        return commands.filter { item in
            item.searchText.localizedCaseInsensitiveContains(normalized)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "command")
                    .foregroundStyle(.secondary)
                TextField("Search commands", text: $query)
                    .textFieldStyle(.plain)
                    .focused($searchFocused)
                Button {
                    isPresented = false
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
            .padding(10)
            .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(filteredCommands) { item in
                        Button {
                            guard item.isEnabled else { return }
                            isPresented = false
                            item.perform()
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: item.systemImage)
                                    .frame(width: 20)
                                    .foregroundStyle(item.isEnabled ? .primary : .secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.title)
                                        .font(.callout.weight(.semibold))
                                        .foregroundStyle(item.isEnabled ? .primary : .secondary)
                                    Text(item.subtitle)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                                Spacer()
                                if !item.isEnabled {
                                    Text(item.disabledReason ?? "Unavailable")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(10)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!item.isEnabled)
                        Divider()
                    }
                }
            }
            .overlay {
                if filteredCommands.isEmpty {
                    ContentUnavailableView("No Commands", systemImage: "magnifyingglass", description: Text("Try a different command name."))
                }
            }
        }
        .padding(18)
        .onAppear {
            searchFocused = true
        }
    }

    private var commandItems: [StudioCommandPaletteItem] {
        let hasProject = model.selectedProject != nil
        let hasThread = model.activeThreadID != nil
        let hasPendingApproval = model.pendingApproval != nil
        return [
            StudioCommandPaletteItem(
                title: "Refresh Projects",
                subtitle: "Reload project list, artifact status, and readiness panels.",
                systemImage: "arrow.clockwise",
                keywords: ["project", "reload", "status"],
                isEnabled: true,
                perform: { model.refresh() }
            ),
            StudioCommandPaletteItem(
                title: "New Project from Source",
                subtitle: "Create a project from the template and link a source media folder.",
                systemImage: "folder.badge.plus",
                keywords: ["import", "source", "ingest"],
                isEnabled: !model.isInitializingProject,
                disabledReason: model.isInitializingProject ? "Creating" : nil,
                perform: { model.chooseAndInitializeProject() }
            ),
            StudioCommandPaletteItem(
                title: "Check Codex App Server",
                subtitle: "Run the initialize handshake for the Codex runtime.",
                systemImage: "network",
                keywords: ["agent", "runtime", "codex"],
                isEnabled: model.appServerStatus != .checking,
                disabledReason: model.appServerStatus == .checking ? "Checking" : nil,
                perform: { model.checkAppServer() }
            ),
            StudioCommandPaletteItem(
                title: "Start Agent Session",
                subtitle: "Start a project-scoped Codex App Server thread.",
                systemImage: "play.circle",
                keywords: ["codex", "thread", "agent"],
                isEnabled: hasProject && model.activeThreadID == nil && model.appServerStatus != .checking,
                disabledReason: hasProject ? "Already active" : "No project",
                perform: { model.startAgentSession() }
            ),
            StudioCommandPaletteItem(
                title: "Stop Agent Session",
                subtitle: "Stop the active Codex session.",
                systemImage: "stop.circle",
                keywords: ["codex", "thread", "agent"],
                isEnabled: hasThread,
                disabledReason: "No active thread",
                perform: { model.stopAgentSession() }
            ),
            StudioCommandPaletteItem(
                title: "Run Selected Agent Job",
                subtitle: "Run the selected Codex job or open the approval gate for write jobs.",
                systemImage: "sparkles",
                keywords: ["codex", "job", "approval"],
                isEnabled: hasProject && hasThread,
                disabledReason: hasProject ? "No active thread" : "No project",
                perform: { model.runSelectedJob() }
            ),
            StudioCommandPaletteItem(
                title: "Run Read-Only Agent Turn",
                subtitle: "Run the freeform prompt in read-only sandbox mode.",
                systemImage: "text.bubble",
                keywords: ["codex", "prompt", "read only"],
                isEnabled: hasThread,
                disabledReason: "No active thread",
                perform: { model.runAgentTurn() }
            ),
            StudioCommandPaletteItem(
                title: "Approve Pending Agent Job",
                subtitle: "Approve the currently pending workspace-write Codex job.",
                systemImage: "checkmark.shield",
                keywords: ["approval", "write", "codex"],
                isEnabled: hasPendingApproval,
                disabledReason: "No pending job",
                perform: { model.approvePendingJob() }
            ),
            StudioCommandPaletteItem(
                title: "Run Source Analysis",
                subtitle: model.analysisRunStatus,
                systemImage: "waveform.path.ecg",
                keywords: ["analysis", "ingest", "source"],
                isEnabled: hasProject && !model.isRunningAnalysis && model.analysisRunPlan.canRun,
                disabledReason: hasProject ? model.analysisRunPlan.readinessLabel : "No project",
                perform: { model.runSelectedProjectAnalysis() }
            ),
            StudioCommandPaletteItem(
                title: "Compile Rough Cut",
                subtitle: model.roughCutCompileStatus,
                systemImage: "timeline.selection",
                keywords: ["compile", "timeline", "rough cut"],
                isEnabled: hasProject && !model.isCompilingRoughCut && model.roughCutCompilePlan.canRun,
                disabledReason: hasProject ? model.roughCutCompilePlan.readinessLabel : "No project",
                perform: { model.compileSelectedProjectRoughCut() }
            ),
            StudioCommandPaletteItem(
                title: "Apply Review Patch",
                subtitle: "Apply review_patch.json through the deterministic compiler.",
                systemImage: "wrench.and.screwdriver",
                keywords: ["review", "patch", "compile"],
                isEnabled: hasProject && !model.isCompilingRoughCut,
                disabledReason: hasProject ? nil : "No project",
                perform: { model.compileSelectedProjectWithReviewPatch() }
            ),
            StudioCommandPaletteItem(
                title: "Rebuild Search Index",
                subtitle: "Rebuild the derived SQLite material/RAG index.",
                systemImage: "magnifyingglass.circle",
                keywords: ["rag", "sqlite", "search"],
                isEnabled: hasProject,
                disabledReason: "No project",
                perform: { model.rebuildSelectedProjectIndex() }
            ),
            StudioCommandPaletteItem(
                title: "Run Marlin Evaluation",
                subtitle: model.marlinEvaluationRunStatus,
                systemImage: "sparkles.tv",
                keywords: ["vlm", "marlin", "temporal"],
                isEnabled: hasProject && !model.isRunningMarlinEvaluation && model.marlinEvaluationRunPlan.canRun,
                disabledReason: hasProject ? model.marlinEvaluationRunPlan.readinessLabel : "No project",
                perform: { model.runSelectedProjectMarlinEvaluation() }
            ),
            StudioCommandPaletteItem(
                title: "Build Audio Story Graph",
                subtitle: model.audioStoryGraphRunStatus,
                systemImage: "waveform.badge.magnifyingglass",
                keywords: ["audio", "story", "bgm"],
                isEnabled: hasProject && !model.isBuildingAudioStoryGraph && model.audioStoryGraphRunPlan.canRun,
                disabledReason: hasProject ? model.audioStoryGraphRunPlan.readinessLabel : "No project",
                perform: { model.buildSelectedProjectAudioStoryGraph() }
            ),
            StudioCommandPaletteItem(
                title: "Build Preview Proxies",
                subtitle: model.mediaProxyOperationStatus,
                systemImage: "film.stack",
                keywords: ["media", "proxy", "preview"],
                isEnabled: hasProject && !model.isBuildingMediaProxies && model.mediaProxyPlan.pendingCount > 0,
                disabledReason: hasProject ? "No pending proxies" : "No project",
                perform: { model.buildSelectedProjectMediaProxies() }
            ),
            StudioCommandPaletteItem(
                title: "Relink Missing Media",
                subtitle: model.mediaRelinkStatus,
                systemImage: "link",
                keywords: ["media", "source map", "relink"],
                isEnabled: hasProject && !model.isRelinkingMedia,
                disabledReason: "No project",
                perform: { model.chooseAndRelinkSelectedProjectMedia() }
            ),
            StudioCommandPaletteItem(
                title: "Export Premiere XML",
                subtitle: model.handoffExportStatus,
                systemImage: "square.and.arrow.up",
                keywords: ["handoff", "premiere", "xml"],
                isEnabled: hasProject && !model.isExportingPremiereXML && (model.handoffExportPlan?.canExportPremiereXML ?? false),
                disabledReason: hasProject ? model.handoffExportPlan?.readinessLabel : "No project",
                perform: { model.exportSelectedProjectPremiereXML() }
            ),
            StudioCommandPaletteItem(
                title: "Export Editor Packet",
                subtitle: model.editorPacketStatus,
                systemImage: "shippingbox",
                keywords: ["handoff", "packet", "editor"],
                isEnabled: hasProject && !model.isExportingEditorPacket && (model.editorPacketPlan?.canExportPacket ?? false),
                disabledReason: hasProject ? model.editorPacketPlan?.readinessLabel : "No project",
                perform: { model.exportSelectedProjectEditorPacket() }
            ),
            StudioCommandPaletteItem(
                title: "Render Final Package",
                subtitle: model.renderRunStatus,
                systemImage: "film",
                keywords: ["render", "package", "final"],
                isEnabled: hasProject && !model.isRunningRender && model.renderRunPlan.canRun,
                disabledReason: hasProject ? model.renderRunPlan.readinessLabel : "No project",
                perform: { model.runSelectedProjectRender() }
            ),
            StudioCommandPaletteItem(
                title: "Run Studio Acceptance Smoke",
                subtitle: model.studioAcceptanceSmokeStatus,
                systemImage: "checkmark.shield",
                keywords: ["smoke", "acceptance", "codex"],
                isEnabled: !model.isRunningStudioAcceptanceSmoke,
                disabledReason: "Running",
                perform: { model.runStudioAcceptanceSmoke() }
            ),
            StudioCommandPaletteItem(
                title: model.isPlaying ? "Pause Playback" : "Play Timeline",
                subtitle: model.timelineStatus,
                systemImage: model.isPlaying ? "pause.fill" : "play.fill",
                keywords: ["transport", "viewer", "timeline"],
                isEnabled: model.timeline != nil,
                disabledReason: "No timeline",
                perform: { model.togglePlayback() }
            )
        ]
    }
}

private struct StudioCommandPaletteItem: Identifiable {
    let id = UUID()
    let title: String
    let subtitle: String
    let systemImage: String
    let keywords: [String]
    let isEnabled: Bool
    let disabledReason: String?
    let perform: () -> Void

    init(
        title: String,
        subtitle: String,
        systemImage: String,
        keywords: [String],
        isEnabled: Bool,
        disabledReason: String? = nil,
        perform: @escaping () -> Void
    ) {
        self.title = title
        self.subtitle = subtitle
        self.systemImage = systemImage
        self.keywords = keywords
        self.isEnabled = isEnabled
        self.disabledReason = disabledReason
        self.perform = perform
    }

    var searchText: String {
        ([title, subtitle] + keywords).joined(separator: " ")
    }
}

private struct StudioWorkspaceView: View {
    @ObservedObject var model: StudioViewModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ViewerPanel(
                    project: model.selectedProject,
                    selection: model.programTimelineClip ?? model.selectedTimelineClip,
                    media: model.programMediaReference,
                    audioMedia: model.programAudioMediaReference,
                    nextMedia: model.nextProgramMediaReference,
                    playheadLabel: model.timeline?.sequence.framesToTimecode(model.playheadFrame),
                    isPlaying: model.isPlaying,
                    syncGeneration: model.mediaPlaybackSyncGeneration,
                    audioSyncGeneration: model.audioPlaybackSyncGeneration,
                    audioMuted: model.monitorAudioMuted,
                    audioVolume: model.monitorAudioVolume,
                    onTogglePlayback: { model.togglePlayback() },
                    onStepBackward: { model.stepBackward() },
                    onStepForward: { model.stepForward() },
                    onToggleAudioMute: { model.toggleMonitorAudioMute() },
                    onAudioVolumeChange: { model.setMonitorAudioVolume($0) }
                )
                    .frame(minWidth: 620, maxWidth: .infinity, maxHeight: .infinity)
                Divider()
                InspectorPanel(model: model)
                    .frame(width: 360)
            }
            .frame(minHeight: 430, maxHeight: .infinity)

            Divider()

            TimelinePanel(
                project: model.selectedProject,
                timeline: model.timeline,
                status: model.timelineStatus,
                audioCues: model.timelineAudioCues,
                audioWaveforms: model.timelineAudioWaveforms,
                audioWaveformStatus: model.audioWaveformStatus,
                selectedClipID: $model.selectedTimelineClipID,
                playheadFrame: model.playheadFrame,
                onScrubPlayhead: { model.scrubPlayhead(to: $0) },
                onSelectClip: { model.selectTimelineClip($0) }
            )
                .frame(minHeight: 230, idealHeight: 280)
        }
    }
}

private struct ViewerPanel: View {
    var project: ProjectSummary?
    var selection: TimelineClipSelection?
    var media: ProjectMediaReference?
    var audioMedia: ProjectMediaReference?
    var nextMedia: ProjectMediaReference?
    var playheadLabel: String?
    var isPlaying: Bool
    var syncGeneration: Int
    var audioSyncGeneration: Int
    var audioMuted: Bool
    var audioVolume: Double
    var onTogglePlayback: () -> Void
    var onStepBackward: () -> Void
    var onStepForward: () -> Void
    var onToggleAudioMute: () -> Void
    var onAudioVolumeChange: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(selection?.clip.role.capitalized ?? project?.name ?? "Project")
                        .font(.title2.weight(.semibold))
                    Text(viewerSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Label(project?.hasReview == true ? "Reviewed" : "Draft", systemImage: project?.hasReview == true ? "checkmark.seal" : "circle.dotted")
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(project?.hasReview == true ? .green : .secondary)
            }

            ViewerSurface(
                media: media,
                audioMedia: audioMedia,
                nextMedia: nextMedia,
                isPlaying: isPlaying,
                syncGeneration: syncGeneration,
                audioSyncGeneration: audioSyncGeneration,
                audioMuted: audioMuted,
                audioVolume: audioVolume
            )
            .frame(minHeight: 280, maxHeight: .infinity)

            TransportBar(
                media: media,
                audioMedia: audioMedia,
                playheadLabel: playheadLabel,
                isPlaying: isPlaying,
                audioMuted: audioMuted,
                audioVolume: audioVolume,
                onTogglePlayback: onTogglePlayback,
                onStepBackward: onStepBackward,
                onStepForward: onStepForward,
                onToggleAudioMute: onToggleAudioMute,
                onAudioVolumeChange: onAudioVolumeChange
            )
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var viewerSubtitle: String {
        if let media {
            return "\(media.assetID) / \(media.filename) / \(media.sourceRangeLabel)"
        }
        return project?.path.path ?? "projects/ 配下にプロジェクトがありません"
    }
}

private struct TransportBar: View {
    var media: ProjectMediaReference?
    var audioMedia: ProjectMediaReference?
    var playheadLabel: String?
    var isPlaying: Bool
    var audioMuted: Bool
    var audioVolume: Double
    var onTogglePlayback: () -> Void
    var onStepBackward: () -> Void
    var onStepForward: () -> Void
    var onToggleAudioMute: () -> Void
    var onAudioVolumeChange: (Double) -> Void

    var body: some View {
        HStack(spacing: 14) {
            Button(action: onStepBackward) {
                Image(systemName: "backward.end.fill")
            }
            Button(action: onTogglePlayback) {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
            }
            Button(action: onStepForward) {
                Image(systemName: "forward.end.fill")
            }
            Text(playheadLabel ?? media?.sourceRangeLabel ?? "00:00:00:00")
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(.secondary)
            Spacer()
            if let media {
                Text(media.exists ? media.resolvedFrom : "missing media")
                    .font(.caption)
                    .foregroundStyle(media.exists ? Color.secondary : Color.orange)
            }
            if let audioMedia {
                Label(audioMedia.filename, systemImage: audioMedia.exists ? "waveform" : "waveform.slash")
                    .font(.caption)
                    .foregroundStyle(audioMedia.exists ? Color.secondary : Color.orange)
                    .lineLimit(1)
            } else {
                Label("No audio", systemImage: "waveform.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Button(action: onToggleAudioMute) {
                Image(systemName: audioMuted || audioVolume <= 0 ? "speaker.slash.fill" : "speaker.wave.2.fill")
            }
            Slider(
                value: Binding(
                    get: { audioVolume },
                    set: { onAudioVolumeChange($0) }
                ),
                in: 0...1
            )
            .frame(width: 90)
            Button { } label: { Image(systemName: "slider.horizontal.3") }
        }
        .buttonStyle(.borderless)
        .controlSize(.large)
    }
}

private struct ViewerSurface: View {
    var media: ProjectMediaReference?
    var audioMedia: ProjectMediaReference?
    var nextMedia: ProjectMediaReference?
    var isPlaying: Bool
    var syncGeneration: Int
    var audioSyncGeneration: Int
    var audioMuted: Bool
    var audioVolume: Double

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(.black)

            VStack(spacing: 10) {
                Image(systemName: placeholderIcon)
                    .font(.system(size: 44))
                    .foregroundStyle(.secondary)
                Text(placeholderTitle)
                    .font(.headline)
                    .foregroundStyle(.secondary)
                if let detail = placeholderDetail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
            }

            if let audioMedia, audioMedia.exists, audioMedia.canPlayAudio, let audioURL = audioMedia.url {
                MediaAudioPlayer(
                    url: audioURL,
                    startSeconds: audioMedia.sourceStartSeconds,
                    isPlaying: isPlaying,
                    syncGeneration: audioSyncGeneration,
                    isMuted: audioMuted,
                    volume: Float(audioVolume)
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var placeholderIcon: String {
        guard let media else { return "play.rectangle" }
        if media.exists, media.isPlayableVideo { return "film" }
        return media.exists ? "waveform" : "questionmark.video"
    }

    private var placeholderTitle: String {
        guard let media else { return "Select a timeline clip" }
        if media.exists, media.isPlayableVideo { return isPlaying ? "Video playback armed" : "Video preview ready" }
        return media.exists ? "Audio or unsupported preview" : "Source media missing"
    }

    private var placeholderDetail: String? {
        guard let media else { return "Choose a clip in the timeline to inspect source playback." }
        if media.exists {
            return media.url?.lastPathComponent
        }
        return media.url?.path ?? media.filename
    }
}

private struct MediaAudioPlayer: View {
    let url: URL
    let startSeconds: Double
    let isPlaying: Bool
    let syncGeneration: Int
    let isMuted: Bool
    let volume: Float
    @State private var player: AVPlayer

    init(url: URL, startSeconds: Double, isPlaying: Bool, syncGeneration: Int, isMuted: Bool, volume: Float) {
        self.url = url
        self.startSeconds = startSeconds
        self.isPlaying = isPlaying
        self.syncGeneration = syncGeneration
        self.isMuted = isMuted
        self.volume = volume
        _player = State(initialValue: AVPlayer(url: url))
    }

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onAppear {
                seekToStart()
                updatePlayback()
            }
            .onChange(of: url) { _, newURL in
                player = AVPlayer(url: newURL)
                seekToStart()
                updatePlayback()
            }
            .onChange(of: syncGeneration) { _, _ in
                seekToStart()
                updatePlayback()
            }
            .onChange(of: isMuted) { _, _ in
                updateAudioMix()
            }
            .onChange(of: volume) { _, _ in
                updateAudioMix()
            }
            .onChange(of: isPlaying) { _, _ in
                updatePlayback()
            }
    }

    private func seekToStart() {
        let time = CMTime(seconds: max(0, startSeconds), preferredTimescale: 600)
        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
    }

    private func updatePlayback() {
        updateAudioMix()
        isPlaying ? player.play() : player.pause()
    }

    private func updateAudioMix() {
        player.isMuted = isMuted
        player.volume = max(0, min(volume, 1))
    }
}

private struct InspectorPanel: View {
    @ObservedObject var model: StudioViewModel

    var body: some View {
        TabView {
            AgentPanel(model: model)
                .tabItem { Label("Agent", systemImage: "sparkles") }
            ProjectPanel(model: model)
                .tabItem { Label("Project", systemImage: "doc.text") }
            ClipInspectorPanel(model: model)
                .tabItem { Label("Clip", systemImage: "rectangle.on.rectangle") }
            MediaPanel(model: model)
                .tabItem { Label("Media", systemImage: "film.stack") }
        }
        .padding(.top, 8)
    }
}

private struct AgentPanel: View {
    @ObservedObject var model: StudioViewModel

    var body: some View {
        Form {
            Section("Codex App Server") {
                LabeledContent("Transport", value: model.appServerPlan.displayName)
                LabeledContent("Status", value: model.appServerStatus.rawValue)
                if let activeThreadID = model.activeThreadID {
                    LabeledContent("Thread", value: activeThreadID)
                }
                if let activeModel = model.activeModel {
                    LabeledContent("Model", value: activeModel)
                }
                LabeledContent("Workspace", value: model.repositoryRoot.path)
                LabeledContent("Command", value: model.appServerPlan.environmentDescription)
                Text(model.appServerDetail)
                    .font(.caption)
                    .foregroundStyle(model.appServerStatus == .failed ? .red : .secondary)
                Button {
                    model.checkAppServer()
                } label: {
                    Label("Check Connection", systemImage: "bolt.horizontal.circle")
                }
                .disabled(model.appServerStatus == .checking)
                Button {
                    model.startAgentSession()
                } label: {
                    Label("Start Agent Session", systemImage: "play.circle")
                }
                .disabled(model.appServerStatus == .checking || model.activeThreadID != nil)
                Button {
                    model.stopAgentSession()
                } label: {
                    Label("Stop Session", systemImage: "stop.circle")
                }
                .disabled(model.activeThreadID == nil)
            }

            Section("Current Surface") {
                LabeledContent("Role", value: model.selectedSurface.rawValue)
                LabeledContent("Command", value: model.selectedSurface.commandName)
                Text("Codex owns reasoning and artifact proposals. Engines keep deterministic writes for timeline, render, package, and validation.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Agent Turn") {
                Picker("Job", selection: $model.selectedJob) {
                    ForEach(VideoOSAgentJob.allCases) { job in
                        Label(job.title, systemImage: job.systemImage)
                            .tag(job)
                    }
                }
                .pickerStyle(.segmented)

                Button {
                    model.runSelectedJob()
                } label: {
                    Label(model.selectedJob.requiresOperatorApproval ? "Review Write Plan" : "Run Job Turn", systemImage: model.selectedJob.systemImage)
                }
                .disabled(!model.selectedJobCanRun)

                LabeledContent("Sandbox", value: model.selectedJob.sandboxLabel)
                LabeledContent("RAG context", value: model.activeAgentRAGContextSummary)
                Text(model.selectedJobReadinessLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                AgentWriteContractSummary(
                    contract: model.selectedJob.writeContract(projectID: model.selectedProject?.id ?? "<id>"),
                    showForbidden: model.selectedJob.requiresOperatorApproval
                )

                if let approval = model.pendingApproval {
                    PendingApprovalCard(approval: approval, model: model)
                }

                TextEditor(text: $model.agentPrompt)
                    .font(.body)
                    .frame(minHeight: 72)
                Button {
                    model.runAgentTurn()
                } label: {
                    Label("Run Read-Only Turn", systemImage: "paperplane")
                }
                .disabled(model.appServerStatus == .checking || model.activeThreadID == nil)
                LabeledContent("Status", value: model.turnStatus)
            }

            Section("Turn Results") {
                if model.turnHistory.isEmpty {
                    Text(model.turnTranscript.isEmpty ? "No completed turns yet." : model.turnTranscript)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } else {
                    ForEach(model.turnHistory.prefix(6)) { record in
                        Button {
                            model.selectedTurnID = record.id
                        } label: {
                            HStack {
                                Image(systemName: record.status == "completed" ? "checkmark.circle" : "exclamationmark.circle")
                                    .foregroundStyle(record.status == "completed" ? .green : .orange)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(record.title)
                                        .lineLimit(1)
                                    Text("\(record.projectName) / \(record.sandboxLabel) / \(record.events.count) events / \(record.artifactDiffs.count) diffs / \(record.writeViolations.count) contract warnings\(record.engineStatus == nil ? "" : " / engine")")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(record.status)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if let record = model.selectedTurnRecord {
                TurnResultDetail(record: record)
            }
        }
        .formStyle(.grouped)
    }
}

private struct TurnResultDetail: View {
    let record: AgentTurnRecord

    var body: some View {
        Section("Selected Turn") {
            LabeledContent("Turn", value: record.turnID)
            LabeledContent("Job", value: record.title)
            LabeledContent("Project", value: record.projectName)
            LabeledContent("Status", value: record.status)
            LabeledContent("Sandbox", value: record.sandboxLabel)
            LabeledContent("Approval", value: record.approvalLabel)
            LabeledContent("Duration", value: record.durationMs.map { "\($0) ms" } ?? "-")
            if let engineStatus = record.engineStatus {
                LabeledContent("Native engine", value: engineStatus)
            }

            if !record.plannedWriteScopes.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Approved write scope")
                        .font(.caption.weight(.semibold))
                    ForEach(record.plannedWriteScopes, id: \.self) { scope in
                        Label(scope, systemImage: "doc.badge.gearshape")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !record.writeViolations.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Label("Write contract warnings", systemImage: "exclamationmark.triangle")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                    ForEach(record.writeViolations) { violation in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(violation.relativePath)
                                .font(.caption)
                                .lineLimit(1)
                            Text("\(violation.kind.rawValue): \(violation.reason)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
            }

            if !record.artifactDiffs.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Artifact diff preview")
                        .font(.caption.weight(.semibold))
                    ForEach(record.artifactDiffs.prefix(12)) { diff in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(diff.kind.badge)
                                .font(.caption2.monospaced())
                                .foregroundStyle(diff.kind.tint)
                                .frame(width: 18, alignment: .leading)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(diff.relativePath)
                                    .font(.caption)
                                    .lineLimit(1)
                                Text("delta \(formatBytes(diff.byteDelta))")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                ForEach(Array(diff.detailLines.prefix(4).enumerated()), id: \.offset) { _, line in
                                    Text(line)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                    if record.artifactDiffs.count > 12 {
                        Text("+\(record.artifactDiffs.count - 12) more artifact changes")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            } else if !record.readOnly && record.approvedWrite {
                Text("No canonical artifact changes detected.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if record.assistantText.isEmpty {
                Text("No assistant text was streamed.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text(record.assistantText)
                    .font(.caption)
                    .textSelection(.enabled)
            }
        }

        Section("Event Timeline") {
            if record.events.isEmpty {
                Text(record.eventMethods.isEmpty ? "No events captured." : record.eventMethods.joined(separator: ", "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            } else {
                ForEach(record.events) { event in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text("#\(event.sequence)")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.secondary)
                            Text(event.method)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                        }
                        Text(event.summary)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    private func formatBytes(_ value: Int) -> String {
        if value == 0 { return "0 B" }
        let sign = value > 0 ? "+" : "-"
        let absValue = abs(value)
        if absValue < 1024 {
            return "\(sign)\(absValue) B"
        }
        let kb = Double(absValue) / 1024
        return "\(sign)\(kb.formatted(.number.precision(.fractionLength(1)))) KB"
    }
}

private extension ProjectArtifactDiff.Kind {
    var badge: String {
        switch self {
        case .added: return "A"
        case .modified: return "M"
        case .removed: return "D"
        }
    }

    var tint: Color {
        switch self {
        case .added: return .green
        case .modified: return .orange
        case .removed: return .red
        }
    }
}

private struct AgentWriteContractSummary: View {
    let contract: VideoOSAgentWriteContract
    var showForbidden: Bool = false

    var body: some View {
        DisclosureGroup("Write Contract") {
            VStack(alignment: .leading, spacing: 6) {
                LabeledContent("Mode", value: contract.modeLabel)
                LabeledContent("Entrypoint", value: contract.entrypoint)
                LabeledContent("Command", value: contract.commandContract ?? "-")

                artifactList("Allowed outputs", values: contract.allowedArtifactRoots, emptyValue: "none")
                artifactList("Expected artifacts", values: contract.expectedArtifacts, emptyValue: "none")

                if showForbidden {
                    artifactList("Forbidden writes", values: contract.forbiddenWrites, emptyValue: "none", systemImage: "xmark.octagon")
                }
            }
            .padding(.top, 4)
        }
        .font(.caption)
    }

    private func artifactList(
        _ title: String,
        values: [String],
        emptyValue: String,
        systemImage: String = "doc.badge.gearshape"
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
            if values.isEmpty {
                Text(emptyValue)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(values, id: \.self) { value in
                    Label(value, systemImage: systemImage)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
    }
}

private struct PendingApprovalCard: View {
    let approval: AgentJobApproval
    @ObservedObject var model: StudioViewModel

    var body: some View {
        let contract = approval.job.writeContract(projectID: approval.projectID)

        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Operator Approval", systemImage: "exclamationmark.shield")
                    .font(.headline)
                Spacer()
                Text(approval.projectName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            LabeledContent("Job", value: approval.job.title)
            LabeledContent("Sandbox", value: approval.job.sandboxLabel)
            LabeledContent("RAG context", value: approval.ragContextSummary)
            AgentWriteContractSummary(contract: contract, showForbidden: true)

            Text("Codex must still confirm gates and stop before any write outside these scopes.")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Button(role: .cancel) {
                    model.cancelPendingJob()
                } label: {
                    Label("Cancel", systemImage: "xmark.circle")
                }

                Button {
                    model.approvePendingJob()
                } label: {
                    Label("Approve and Run", systemImage: "checkmark.shield")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.appServerStatus == .checking || model.activeThreadID == nil)
            }
        }
        .padding(10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct ProjectPanel: View {
    @ObservedObject var model: StudioViewModel

    private var project: ProjectSummary? {
        model.selectedProject
    }

    var body: some View {
        Form {
            Section("State") {
                LabeledContent("Project", value: project?.name ?? "-")
                LabeledContent("Gate", value: project?.stateLabel ?? "-")
                LabeledContent("Timeline", value: project?.hasTimeline == true ? "available" : "missing")
                LabeledContent("Review", value: project?.hasReview == true ? "available" : "missing")
                LabeledContent("Project creation", value: model.projectInitializationStatus)
            }

            Section("Goal Coverage") {
                LabeledContent("Status", value: model.studioGoalStatus.readinessLabel)
                LabeledContent("Score", value: model.studioGoalStatus.scoreLabel)
                Text(model.studioGoalStatus.nextAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let command = model.studioGoalStatus.nextCommand {
                    Text(command)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                ForEach(model.studioGoalStatus.requirements) { requirement in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: requirement.isSatisfied ? "checkmark.circle.fill" : "circle.dotted")
                            .foregroundStyle(requirement.isSatisfied ? .green : .secondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(requirement.title)
                                .font(.caption)
                            Text(requirement.statusLabel)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Text(requirement.detail)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 8)
                    }
                }
            }

            Section("Studio Readiness") {
                LabeledContent("Status", value: model.studioReadinessStatus.readinessLabel)
                LabeledContent("Score", value: model.studioReadinessStatus.scoreLabel)
                LabeledContent("Marlin default gate", value: model.studioReadinessStatus.marlinDefaultLabel)
                Text(model.studioReadinessStatus.marlinDefaultDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(model.studioReadinessStatus.marlinDefaultNextAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(model.studioReadinessStatus.nextAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let command = model.studioReadinessStatus.nextCommand {
                    Text(command)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                ForEach(Array(model.studioReadinessStatus.capabilities.prefix(5)), id: \.id) { capability in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: capability.isReady ? "checkmark.circle.fill" : "circle.dotted")
                            .foregroundStyle(capability.isReady ? .green : .secondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(capability.title)
                                .font(.caption)
                            Text(capability.readinessLabel)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            if let command = capability.nextCommand {
                                Text(command)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 8)
                    }
                }
                if !model.studioReadinessStatus.actionQueue.isEmpty {
                    Divider()
                    Text("Action Queue")
                        .font(.caption.weight(.semibold))
                    Text(model.studioReadinessActionStatus)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    ForEach(model.studioReadinessStatus.actionQueue.prefix(5)) { action in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(action.title)
                                    .font(.caption)
                                Spacer()
                                Text(action.isBlocking ? "blocking" : "advisory")
                                    .font(.caption2)
                                    .foregroundStyle(action.isBlocking ? .orange : .secondary)
                            }
                            Text(action.action)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                            if let command = action.command {
                                Text(command)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                if command.contains("agent-prompt") {
                                    Text("Codex context: \(model.activeAgentRAGContextSummary)")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                            HStack(spacing: 8) {
                                Button {
                                    model.performStudioReadinessAction(action)
                                } label: {
                                    Label(model.studioReadinessActionButtonTitle(action), systemImage: action.isBlocking ? "play.circle" : "arrow.right.circle")
                                }
                                .controlSize(.small)
                                .disabled(!model.canPerformStudioReadinessAction(action))

                                Button {
                                    model.copyStudioReadinessActionCommand(action)
                                } label: {
                                    Label("Copy", systemImage: "doc.on.doc")
                                }
                                .controlSize(.small)
                                .disabled(action.command == nil)

                                if let reason = model.studioReadinessActionDisabledReason(action) {
                                    Text(reason)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }

            Section("Pipeline Gates") {
                LabeledContent("Status", value: model.pipelineGateStatus.readinessLabel)
                LabeledContent("State", value: model.pipelineGateStatus.currentState ?? "-")
                LabeledContent("Render", value: model.pipelineGateStatus.renderReadinessLabel)
                if !model.pipelineGateStatus.gateSummaryLabel.isEmpty {
                    Text(model.pipelineGateStatus.gateSummaryLabel)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Text(model.pipelineGateStatus.nextAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Library Readiness") {
                LabeledContent("Status", value: model.libraryReadinessStatus.readinessLabel)
                LabeledContent("Media", value: model.libraryReadinessStatus.mediaReady ? "ready" : "\(model.libraryReadinessStatus.mediaMissingCount) missing / \(model.libraryReadinessStatus.mediaProxyNeededCount) proxy")
                LabeledContent("RAG", value: model.libraryReadinessStatus.ragCoverageLabel)
                LabeledContent("Analysis", value: model.libraryReadinessStatus.analysisReady ? "\(model.libraryReadinessStatus.segmentCount) segments" : "incomplete")
                LabeledContent("Marlin", value: model.libraryReadinessStatus.marlinReady ? "\(model.libraryReadinessStatus.marlinEventCount + model.libraryReadinessStatus.marlinFindResultCount) signals" : "not evaluated")
                LabeledContent("Audio", value: model.libraryReadinessStatus.audioReady ? "\(model.libraryReadinessStatus.audioEventCount + model.libraryReadinessStatus.audioStoryNodeCount + model.libraryReadinessStatus.bgmBeatCount) signals" : "not mapped")
                LabeledContent("Handoff notes", value: model.libraryReadinessStatus.handoffAnnotationsExist ? "available" : "missing")
                Text(model.libraryReadinessStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Planning") {
                LabeledContent("Status", value: model.planningStatus.readinessLabel)
                LabeledContent("Intent", value: model.planningStatus.hasCreativeBrief ? "available" : "missing")
                LabeledContent("Analysis", value: model.planningStatus.analysisReady ? "\(model.planningStatus.assetCount) assets / \(model.planningStatus.segmentCount) segments" : "incomplete")
                LabeledContent("Selects", value: model.planningStatus.hasSelects ? "available" : "missing")
                LabeledContent("Blueprint", value: model.planningStatus.hasBlueprint ? "available" : "missing")
                Text(model.planningStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let nextJob = model.planningStatus.nextAgentJob {
                    Button {
                        model.selectedJob = nextJob
                    } label: {
                        Label("Select \(nextJob.title) Job", systemImage: nextJob.systemImage)
                    }
                }
            }

            Section("Intent Brief") {
                LabeledContent("Status", value: model.intentSummary.readinessLabel)
                LabeledContent("Title", value: model.intentSummary.displayTitle)
                LabeledContent("Strategy", value: model.intentSummary.strategy ?? "-")
                LabeledContent("Format", value: model.intentSummary.format ?? "-")
                LabeledContent("Runtime", value: model.intentSummary.runtimeTargetSeconds.map { "\($0)s" } ?? "-")
                LabeledContent("Autonomy", value: model.intentSummary.autonomyLabel)
                if let message = model.intentSummary.primaryMessage {
                    LabeledContent("Message", value: message)
                }
                if let audience = model.intentSummary.primaryAudience {
                    LabeledContent("Audience", value: audience)
                }
                LabeledContent("Must have", value: model.intentSummary.mustHave.prefix(3).joined(separator: ", "))
                LabeledContent("Must avoid", value: model.intentSummary.mustAvoid.prefix(3).joined(separator: ", "))
                LabeledContent("Blockers", value: "\(model.intentSummary.blockerCount) blocker / \(model.intentSummary.softBlockerCount) soft")
                if !model.intentSummary.openBlockerQuestions.isEmpty {
                    Text(model.intentSummary.openBlockerQuestions.prefix(2).joined(separator: "\n"))
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Text(model.intentSummary.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Intent Alignment") {
                LabeledContent("Status", value: model.intentAlignmentStatus.readinessLabel)
                LabeledContent("Coverage", value: model.intentAlignmentStatus.coverageLabel)
                LabeledContent("Review", value: model.intentAlignmentStatus.reviewStatus ?? "-")
                LabeledContent("Brief mismatches", value: "\(model.intentAlignmentStatus.briefMismatchCount)")
                if !model.intentAlignmentStatus.mustHaveMissing.isEmpty {
                    LabeledContent("Missing", value: model.intentAlignmentStatus.mustHaveMissing.prefix(3).joined(separator: ", "))
                }
                if !model.intentAlignmentStatus.mustAvoidAcknowledged.isEmpty {
                    LabeledContent("Avoids handled", value: model.intentAlignmentStatus.mustAvoidAcknowledged.prefix(3).joined(separator: ", "))
                }
                Text(model.intentAlignmentStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Review") {
                LabeledContent("Status", value: model.reviewArtifactStatus.readinessLabel)
                LabeledContent("Judgment", value: model.reviewArtifactStatus.judgmentStatus ?? "-")
                LabeledContent("Issues", value: model.reviewArtifactStatus.issueLabel)
                LabeledContent("Mismatches", value: model.reviewArtifactStatus.mismatchLabel)
                LabeledContent("Patch", value: model.reviewArtifactStatus.patchLabel)
                if let goal = model.reviewArtifactStatus.recommendedGoal {
                    LabeledContent("Next pass", value: goal)
                }
                Text(model.reviewArtifactStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.runReviewAgentJob()
                } label: {
                    Label("Run Review with Codex", systemImage: "checklist.checked")
                }
                .disabled(project == nil || model.appServerStatus == .checking)
                Button {
                    model.compileSelectedProjectWithReviewPatch()
                } label: {
                    if model.isCompilingRoughCut {
                        Label("Applying Review Patch", systemImage: "hourglass")
                    } else {
                        Label("Apply Review Patch", systemImage: "arrow.triangle.2.circlepath")
                    }
                }
                .disabled(project == nil || model.isCompilingRoughCut || !model.reviewArtifactStatus.patchReadable || !model.roughCutCompilePlan.canRun)
            }

            Section("Source Analysis") {
                LabeledContent("Status", value: model.analysisRunPlan.readinessLabel)
                LabeledContent("Sources", value: "\(model.analysisRunPlan.sourceCount)")
                LabeledContent("Skipped files", value: "\(model.analysisRunPlan.skippedSourceCount)")
                Text(model.analysisRunStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.runSelectedProjectAnalysis()
                } label: {
                    if model.isRunningAnalysis {
                        Label("Analyzing Sources", systemImage: "hourglass")
                    } else {
                        Label("Run Source Analysis", systemImage: "waveform.and.magnifyingglass")
                    }
                }
                .disabled(project == nil || model.isRunningAnalysis || !model.analysisRunPlan.canRun)
                Text(model.analysisRunPlan.commandLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Section("Rough Cut Compile") {
                LabeledContent("Status", value: model.roughCutCompilePlan.readinessLabel)
                LabeledContent("Timeline", value: project?.hasTimeline == true ? "available" : "not compiled")
                Text(model.roughCutCompileStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.compileSelectedProjectRoughCut()
                } label: {
                    if model.isCompilingRoughCut {
                        Label("Compiling Rough Cut", systemImage: "hourglass")
                    } else {
                        Label("Compile Rough Cut", systemImage: "timeline.selection")
                    }
                }
                .disabled(project == nil || model.isCompilingRoughCut || !model.roughCutCompilePlan.canRun)
                Text(model.roughCutCompilePlan.commandLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .formStyle(.grouped)
    }
}

private struct ClipInspectorPanel: View {
    @ObservedObject var model: StudioViewModel

    var body: some View {
        Form {
            let timeline = model.timeline
            let selection = model.selectedTimelineClip
            let evidence = model.selectedClipEvidence
            if let timeline, let selection {
                let clip = selection.clip
                Section("Selection") {
                    LabeledContent("Clip", value: clip.id)
                    LabeledContent("Track", value: "\(selection.trackID) / \(selection.trackKind.rawValue)")
                    LabeledContent("Role", value: clip.role)
                    LabeledContent("Confidence", value: formatConfidence(clip.confidence))
                    if let beatID = clip.beatID {
                        LabeledContent("Beat", value: beatID)
                    }
                }

                Section("Source") {
                    LabeledContent("Asset", value: clip.assetID)
                    LabeledContent("Segment", value: clip.segmentID)
                    if let sourceInUS = clip.sourceInUS {
                        LabeledContent("Source In", value: formatMicroseconds(sourceInUS))
                    }
                    if let sourceOutUS = clip.sourceOutUS {
                        LabeledContent("Source Out", value: formatMicroseconds(sourceOutUS))
                    }
                    if let duration = clip.sourceDurationSeconds {
                        LabeledContent("Source Duration", value: formatSeconds(duration))
                    }
                    if let candidateRef = clip.candidateRef {
                        LabeledContent("Candidate", value: candidateRef)
                    }
                }

                Section("Timeline") {
                    LabeledContent("In", value: timeline.sequence.framesToTimecode(clip.timelineInFrame))
                    LabeledContent("Out", value: timeline.sequence.framesToTimecode(clip.timelineOutFrame))
                    LabeledContent("Duration", value: "\(clip.timelineDurationFrames) frames / \(formatSeconds(timeline.sequence.framesToSeconds(clip.timelineDurationFrames)))")
                }

                Section("Editorial Intent") {
                    Text(clip.motivation)
                        .textSelection(.enabled)
                    if !clip.qualityFlags.isEmpty {
                        LabeledContent("Quality Flags", value: clip.qualityFlags.joined(separator: ", "))
                    }
                    if !clip.fallbackSegmentIDs.isEmpty {
                        LabeledContent("Fallbacks", value: clip.fallbackSegmentIDs.joined(separator: ", "))
                    }
                }

                Section("Editor Note") {
                    LabeledContent("Handoff", value: model.editorAnnotationSummary?.statusLabel ?? "no editor annotations")
                    if let saved = model.selectedClipNote {
                        LabeledContent("Saved", value: saved.updatedAt)
                        Text(saved.handoffInstruction)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }

                    TextEditor(text: $model.selectedClipNoteDraft)
                        .font(.body)
                        .frame(minHeight: 72)

                    TextEditor(text: $model.selectedClipHandoffInstructionDraft)
                        .font(.body)
                        .frame(minHeight: 58)

                    HStack {
                        Button {
                            model.proposeSelectedClipNoteWithCodex()
                        } label: {
                            Label("Ask Codex", systemImage: "sparkles")
                        }
                        .disabled(model.appServerStatus == .checking || model.activeThreadID == nil)

                        Button {
                            model.saveSelectedClipNote()
                        } label: {
                            Label("Save Note", systemImage: "note.text.badge.plus")
                        }
                        .disabled(model.selectedClipNoteDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                        Button(role: .destructive) {
                            model.clearSelectedClipNote()
                        } label: {
                            Label("Clear", systemImage: "xmark.circle")
                        }
                        .disabled(model.selectedClipNote == nil)
                    }

                    Text(model.editorAnnotationStatus)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let evidence, evidence.hasAnalysis {
                    AnalysisEvidenceSection(evidence: evidence)
                } else {
                    Section("Analysis Evidence") {
                        Label("No analysis artifact matched this clip yet.", systemImage: "doc.badge.clock")
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                Section("Selection") {
                    Label("Select a timeline clip to inspect source, timing, and editorial rationale.", systemImage: "cursorarrow.click.2")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }

    private func formatConfidence(_ confidence: Double?) -> String {
        guard let confidence else { return "-" }
        return confidence.formatted(.number.precision(.fractionLength(2)))
    }

    private func formatMicroseconds(_ microseconds: Int) -> String {
        formatSeconds(Double(microseconds) / 1_000_000)
    }

    private func formatSeconds(_ seconds: Double) -> String {
        let safeSeconds = max(0, seconds)
        let whole = Int(safeSeconds)
        let minutes = whole / 60
        let remainder = whole % 60
        let fraction = Int((safeSeconds - Double(whole)) * 10)
        return "\(minutes):\(String(format: "%02d", remainder)).\(fraction)"
    }
}

private struct AnalysisEvidenceSection: View {
    var evidence: ClipEvidence

    var body: some View {
        Section("Analysis Evidence") {
            if let asset = evidence.asset {
                LabeledContent("File", value: asset.filename)
                LabeledContent("Asset Role", value: asset.roleGuess ?? "-")
                if asset.durationUS != nil {
                    LabeledContent("Asset Duration", value: formatMicroseconds(asset.durationUS ?? 0))
                }
                if !asset.tags.isEmpty {
                    LabeledContent("Asset Tags", value: asset.tags.joined(separator: ", "))
                }
            }

            if let segment = evidence.segment {
                LabeledContent("Segment Summary", value: segment.summary.isEmpty ? "-" : segment.summary)
                if !segment.tags.isEmpty {
                    LabeledContent("Segment Tags", value: segment.tags.joined(separator: ", "))
                }
                if !segment.transcriptExcerpt.isEmpty {
                    Text(segment.transcriptExcerpt)
                        .font(.caption)
                        .textSelection(.enabled)
                }
                ForEach(segment.interestPoints.indices, id: \.self) { index in
                    let point = segment.interestPoints[index]
                    LabeledContent(
                        "Interest \(index + 1)",
                        value: "\(point.label) / \(point.frameUS.map(formatMicroseconds) ?? "-")"
                    )
                }
                if let peak = segment.peakAnalysis {
                    LabeledContent("Peak", value: peak.selectedPeakUS.map(formatMicroseconds) ?? "-")
                    LabeledContent("Peak Confidence", value: formatConfidence(peak.confidence))
                    if let precisionMode = peak.provenance?.precisionMode {
                        LabeledContent("Peak Source", value: precisionMode)
                    }
                }
            }
        }

        Section("Transcript") {
            if evidence.transcriptItems.isEmpty {
                Text("No overlapping transcript lines.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(evidence.transcriptItems) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(item.speaker)  \(formatMicroseconds(item.startUS))-\(formatMicroseconds(item.endUS))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(item.text)
                            .textSelection(.enabled)
                    }
                }
            }
        }

        Section("Marlin-2B") {
            if let marlinAsset = evidence.marlinAsset {
                LabeledContent("Scene", value: marlinAsset.scene.isEmpty ? "-" : marlinAsset.scene)
                if let caption = marlinAsset.caption, !caption.isEmpty {
                    Text(caption)
                        .font(.caption)
                        .textSelection(.enabled)
                }
            } else {
                Text("marlin_events.json has not been generated for this project.")
                    .foregroundStyle(.secondary)
            }

            ForEach(evidence.marlinEvents) { event in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(formatMicroseconds(event.startUS))-\(formatMicroseconds(event.endUS))  \(event.sourcePass ?? "marlin")")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(event.description)
                        .textSelection(.enabled)
                }
            }

            ForEach(evidence.marlinFindResults) { result in
                LabeledContent(
                    "Find",
                    value: "\(result.query) / \(result.spanStartUS.map(formatMicroseconds) ?? "-")-\(result.spanEndUS.map(formatMicroseconds) ?? "-")"
                )
            }
        }

        Section("Audio") {
            if evidence.audioEvents.isEmpty && evidence.audioStoryNodes.isEmpty && evidence.bgmSections.isEmpty {
                Text("No overlapping audio events, story nodes, or BGM sections.")
                    .foregroundStyle(.secondary)
            }

            ForEach(evidence.audioEvents) { event in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(formatMicroseconds(event.startUS))-\(formatMicroseconds(event.endUS))  \(event.type)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(event.label ?? event.type)
                        .textSelection(.enabled)
                    if let score = event.confidence?.score {
                        Text("confidence \(formatConfidence(score))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            ForEach(evidence.audioStoryNodes) { node in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(formatMicroseconds(node.startUS))-\(formatMicroseconds(node.endUS))  \(node.type)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(node.text ?? node.storyRole ?? node.id)
                        .textSelection(.enabled)
                    Text([node.storyRole, node.refs.speakerRef, node.refs.audioEventRef, node.refs.bgmRef].compactMap { $0 }.joined(separator: " / "))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(evidence.bgmSections) { section in
                LabeledContent(
                    "BGM \(section.label)",
                    value: "\(formatSeconds(section.startSec))-\(formatSeconds(section.endSec)) / energy \(formatConfidence(section.energy))"
                )
            }
        }
    }

    private func formatConfidence(_ confidence: Double?) -> String {
        guard let confidence else { return "-" }
        return confidence.formatted(.number.precision(.fractionLength(2)))
    }

    private func formatMicroseconds(_ microseconds: Int) -> String {
        formatSeconds(Double(microseconds) / 1_000_000)
    }

    private func formatSeconds(_ seconds: Double) -> String {
        let safeSeconds = max(0, seconds)
        let whole = Int(safeSeconds)
        let minutes = whole / 60
        let remainder = whole % 60
        let fraction = Int((safeSeconds - Double(whole)) * 10)
        return "\(minutes):\(String(format: "%02d", remainder)).\(fraction)"
    }
}

private struct MediaPanel: View {
    @ObservedObject var model: StudioViewModel

    private var project: ProjectSummary? {
        model.selectedProject
    }

    var body: some View {
        Form {
            Section("Library") {
                LabeledContent("Status", value: model.libraryReadinessStatus.readinessLabel)
                LabeledContent("Source files", value: "\(project?.mediaFileCount ?? 0)")
                LabeledContent("Analyzed assets", value: "\(model.libraryReadinessStatus.assetCount)")
                LabeledContent("Segments", value: "\(model.libraryReadinessStatus.segmentCount)")
                LabeledContent("Search/RAG", value: model.libraryReadinessStatus.ragCoverageLabel)
                LabeledContent("Timeline", value: model.libraryReadinessStatus.timelineExists ? "available" : "missing")
                LabeledContent("VLM priority", value: "Marlin-2B temporal semantics + existing VLM")
                LabeledContent("Audio priority", value: "STT, diarization, BGM, beats")
                Text(model.libraryReadinessStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Audio Story Graph") {
                LabeledContent("Audio signals", value: "\(model.libraryReadinessStatus.audioEventCount + model.libraryReadinessStatus.audioStoryNodeCount + model.libraryReadinessStatus.bgmBeatCount)")
                LabeledContent("Story nodes", value: "\(model.libraryReadinessStatus.audioStoryNodeCount)")
                LabeledContent("Run", value: model.audioStoryGraphRunPlan.readinessLabel)
                Text(model.audioStoryGraphRunStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.buildSelectedProjectAudioStoryGraph()
                } label: {
                    if model.isBuildingAudioStoryGraph {
                        Label("Building Audio Graph", systemImage: "hourglass")
                    } else {
                        Label("Build Audio Story Graph", systemImage: "waveform.path.ecg")
                    }
                }
                .disabled(project == nil || model.isBuildingAudioStoryGraph || !model.audioStoryGraphRunPlan.canRun)
                Text(model.audioStoryGraphRunPlan.commandLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Section("Marlin Evaluation") {
                LabeledContent("Status", value: model.marlinEvaluationStatus.readinessLabel)
                LabeledContent("Model", value: model.marlinEvaluationStatus.modelLabel)
                LabeledContent("Policy", value: marlinPolicyValue(model.marlinEvaluationStatus))
                LabeledContent("Events", value: "\(model.marlinEvaluationStatus.eventCount) events / \(model.marlinEvaluationStatus.findResultCount) finds")
                LabeledContent("Coverage", value: marlinCoverageValue(model.marlinEvaluationStatus))
                LabeledContent("Preferred VLM", value: model.marlinEvaluationStatus.canPreferMarlin ? "candidate" : "not yet")
                LabeledContent("Runtime", value: "\(model.marlinRuntimeStatus.readinessLabel) / \(model.marlinRuntimeStatus.resolvedDeviceLabel)")
                LabeledContent("HF auth", value: model.marlinAuthReadinessLabel)
                LabeledContent("Model access", value: model.marlinModelAccessStatus.isReadyForLiveMarlin ? "ready" : "blocked")
                LabeledContent("Preference gate", value: model.marlinPreferenceDecision.decisionLabel)
                LabeledContent("Repo evidence", value: marlinPreferenceValue(model.marlinPreferenceDecision))
                LabeledContent("Representative plan", value: model.marlinRepresentativePlan.readinessLabel)
                LabeledContent("Representative buckets", value: "\(model.marlinRepresentativePlan.coveredBucketCount) / \(model.marlinRepresentativePlan.targetBucketCount)")
                LabeledContent("Evaluation queue", value: model.marlinEvaluationQueue.readinessLabel)
                LabeledContent("Runnable projects", value: "\(model.marlinEvaluationQueue.runnableProjectCount) / \(model.marlinEvaluationQueue.projectCount)")
                LabeledContent("Run plan", value: "\(model.marlinEvaluationRunPlan.sourceCount) sources / \(model.marlinEvaluationRunPlan.skippedSourceCount) skipped")
                Text(model.marlinEvaluationStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(model.marlinPreferenceDecision.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(model.marlinEvaluationQueue.nextAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(model.marlinRepresentativePlan.nextAction)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(model.marlinRepresentativePlan.buckets) { bucket in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(bucket.label)
                                .font(.caption.weight(.semibold))
                            Text(bucket.rationale)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(bucket.readinessLabel)
                            .font(.caption2)
                            .foregroundStyle(bucket.isCovered ? Color.green : Color.secondary)
                    }
                    .padding(.vertical, 2)
                }
                ForEach(model.marlinEvaluationQueue.items.prefix(4)) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(item.id)
                                .font(.caption.weight(.semibold))
                            Spacer()
                            Text(item.priorityLabel)
                                .font(.caption2)
                                .foregroundStyle(item.canRunEvaluation ? Color.green : Color.secondary)
                        }
                        Text("sources \(item.sourceCount), missing \(item.mediaMissingCount), coverage \(item.coveredSegmentCount)/\(item.segmentCount)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(item.recommendation)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                }
                Text(model.marlinEvaluationRunStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    Button {
                        model.runSelectedProjectMarlinEvaluation()
                    } label: {
                        if model.isRunningMarlinEvaluation {
                            Label("Running Marlin", systemImage: "hourglass")
                        } else {
                            Label("Run Marlin Evaluation", systemImage: "sparkles.tv")
                        }
                    }
                    .disabled(project == nil || model.isRunningMarlinEvaluation || !model.marlinEvaluationRunPlan.canRun || !model.marlinRuntimeStatus.isReadyForLiveMarlin)

                    Button {
                        model.applyMarlinPreferencePolicy()
                    } label: {
                        Label("Apply Marlin Preference", systemImage: "checkmark.seal")
                    }
                    .disabled(!model.marlinPreferenceDecision.canPreferMarlinAsDefault)
                }
                Text(model.marlinEvaluationRunPlan.commandLine())
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(model.marlinEvaluationStatus.artifactURL.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Section("Preview Readiness") {
                LabeledContent("Ready", value: "\(model.mediaPreviewSummary.readyCount)")
                LabeledContent("Missing", value: "\(model.mediaPreviewSummary.missingCount)")
                LabeledContent("Proxy needed", value: "\(model.mediaPreviewSummary.proxyNeededCount)")
                LabeledContent("Proxy plans", value: "\(model.mediaProxyPlan.pendingCount)")

                if model.mediaPreviewSummary.items.isEmpty {
                    Text("Run analysis or load assets.json to inspect source preview readiness.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.mediaPreviewSummary.items) { item in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Label(item.assetID, systemImage: icon(for: item.playbackStatus))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(color(for: item.playbackStatus))
                                Spacer()
                                Text(item.playbackStatus.rawValue)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(item.filename)
                                .font(.caption)
                                .lineLimit(1)
                            Text(item.recommendation)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            if let url = item.url {
                                Text(url.path)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }

            Section("Source Map") {
                let suggestedRoots = project.map { ProjectMediaRelinker.suggestedSearchRoots(projectURL: $0.path) } ?? []
                LabeledContent("Status", value: model.mediaSourceMapStatus.readinessLabel)
                LabeledContent("Coverage", value: model.mediaSourceMapStatus.coverageLabel)
                LabeledContent("Entries", value: "\(model.mediaSourceMapStatus.entryCount)")
                LabeledContent("Ready paths", value: "\(model.mediaSourceMapStatus.readyAssetCount)")
                LabeledContent("Broken", value: "\(model.mediaSourceMapStatus.brokenEntries.count)")
                LabeledContent("Relinked symlinks", value: "\(model.mediaSourceMapStatus.relinkedSymlinkCount)")
                if let generatedAt = model.mediaSourceMapStatus.generatedAt {
                    LabeledContent("Generated", value: generatedAt)
                }
                Text(model.mediaSourceMapStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(model.mediaSourceMapStatus.sourceMapURL.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if !suggestedRoots.isEmpty {
                    LabeledContent("Suggested roots", value: "\(suggestedRoots.count)")
                    ForEach(suggestedRoots.prefix(4)) { root in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Label(root.exists ? "Available" : "Missing", systemImage: root.exists ? "externaldrive.fill" : "externaldrive.badge.xmark")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(root.exists ? .green : .secondary)
                                Spacer()
                                Text("\(root.referencedAssetCount) refs")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(root.url.path)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                ForEach(model.mediaSourceMapStatus.brokenEntries.prefix(5)) { entry in
                    VStack(alignment: .leading, spacing: 3) {
                        Label(entry.assetID, systemImage: "exclamationmark.triangle")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.orange)
                        Text(entry.filename ?? "-")
                            .font(.caption)
                            .lineLimit(1)
                        Text(entry.checkedPaths.joined(separator: ", "))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }

            Section("Media Relink") {
                let suggestedRoots = project.map { ProjectMediaRelinker.suggestedSearchRoots(projectURL: $0.path) } ?? []
                Text(model.mediaRelinkStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack {
                    Button {
                        model.chooseAndRelinkSelectedProjectMedia()
                    } label: {
                        if model.isRelinkingMedia {
                            Label("Relinking Media", systemImage: "hourglass")
                        } else {
                            Label("Relink Missing Media", systemImage: "link")
                        }
                    }
                    .disabled(project == nil || model.mediaPreviewSummary.missingCount == 0 || model.isRelinkingMedia)

                    Button {
                        model.relinkSelectedProjectMediaFromSourceMap()
                    } label: {
                        Label("Use Source Map Roots", systemImage: "externaldrive.connected.to.line.below")
                    }
                    .disabled(project == nil || model.mediaPreviewSummary.missingCount == 0 || model.isRelinkingMedia || suggestedRoots.allSatisfy { !$0.exists })
                }

                if let plan = model.mediaRelinkPlan {
                    LabeledContent("Matches", value: "\(plan.matchedCount) / \(plan.missingAssetCount)")
                    LabeledContent("Source map", value: plan.sourceMapURL.lastPathComponent)
                    ForEach(plan.items.prefix(8)) { item in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Label(item.assetID, systemImage: item.candidateURL == nil ? "exclamationmark.circle" : "checkmark.circle")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(item.candidateURL == nil ? .orange : .green)
                                Spacer()
                                Text(item.matchedBy ?? "unmatched")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(item.filename)
                                .font(.caption)
                                .lineLimit(1)
                            Text(item.candidateURL?.path ?? "No matching file found in selected roots.")
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    if plan.items.count > 8 {
                        Text("+\(plan.items.count - 8) more relink items")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("Synthetic Demo Media") {
                Text(model.syntheticMediaStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.buildSelectedProjectSyntheticMedia()
                } label: {
                    if model.isBuildingSyntheticMedia {
                        Label("Building Demo Media", systemImage: "hourglass")
                    } else {
                        Label("Build Demo Media", systemImage: "wand.and.stars")
                    }
                }
                .disabled(project == nil || model.mediaSourceMapStatus.assetCount == 0 || model.isBuildingSyntheticMedia)

                Text("Creates short local test videos under 02_media/synthetic and maps analyzed assets for preview and handoff QA.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Divider()

                Text(model.studioSyntheticSmokeStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.runStudioSyntheticSmoke()
                } label: {
                    if model.isRunningStudioSyntheticSmoke {
                        Label("Running Studio Smoke", systemImage: "hourglass")
                    } else {
                        Label("Run Studio Smoke", systemImage: "checkmark.seal")
                    }
                }
                .disabled(model.isRunningStudioSyntheticSmoke)

                Text("Builds a temporary approved project, packages final media, and verifies editor packet media without changing the selected project.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Divider()

                Text(model.studioAcceptanceSmokeStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.runStudioAcceptanceSmoke()
                } label: {
                    if model.isRunningStudioAcceptanceSmoke {
                        Label("Running Acceptance Smoke", systemImage: "hourglass")
                    } else {
                        Label("Run Acceptance Smoke", systemImage: "checkmark.shield")
                    }
                }
                .disabled(model.isRunningStudioAcceptanceSmoke)

                Text("Checks the Codex App Server handshake and the temporary render/package/editor-packet loop as one runtime acceptance gate.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Section("Proxy Transcode Plan") {
                Text(model.mediaProxyOperationStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.buildSelectedProjectMediaProxies()
                } label: {
                    if model.isBuildingMediaProxies {
                        Label("Building Proxies", systemImage: "hourglass")
                    } else {
                        Label("Build Proxies", systemImage: "film.stack")
                    }
                }
                .disabled(project == nil || model.mediaProxyPlan.pendingCount == 0 || model.isBuildingMediaProxies)

                if model.mediaProxyPlan.items.isEmpty {
                    Text("No unsupported source media needs a preview proxy.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.mediaProxyPlan.items) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Label(item.assetID, systemImage: item.outputExists ? "checkmark.circle" : "film.stack")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(item.outputExists ? .green : .orange)
                                Spacer()
                                Text(item.outputExists ? "exists" : "pending")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(item.filename)
                                .font(.caption)
                            Text(item.outputPath)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Text(item.commandLine)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
            }

            Section("Render Package") {
                LabeledContent("Status", value: model.renderPackageStatus.readinessLabel)
                LabeledContent("Run", value: model.renderRunPlan.readinessLabel)
                LabeledContent("QA", value: renderQAValue(model.renderPackageStatus))
                LabeledContent("Source", value: model.renderPackageStatus.manifestSourceOfTruth ?? model.renderPackageStatus.qaSourceOfTruth ?? "-")
                LabeledContent("Checks", value: "\(model.renderPackageStatus.qaCheckCount) total / \(model.renderPackageStatus.qaFailedCheckCount) failed")
                if let createdAt = model.renderPackageStatus.manifestCreatedAt {
                    LabeledContent("Packaged", value: createdAt)
                }

                renderArtifactRow("Final video", url: model.renderPackageStatus.publishedFinalVideoURL, exists: model.renderPackageStatus.publishedFinalVideoExists)
                renderArtifactRow("QA report", url: model.renderPackageStatus.qaReportURL, exists: model.renderPackageStatus.qaReportExists)
                renderArtifactRow("Manifest", url: model.renderPackageStatus.packageManifestURL, exists: model.renderPackageStatus.packageManifestExists)
                renderArtifactRow("Final mix", url: model.renderPackageStatus.finalMixURL, exists: model.renderPackageStatus.finalMixExists)

                if !model.renderPackageStatus.missingRequiredArtifacts.isEmpty {
                    Text("Missing: \(model.renderPackageStatus.missingRequiredArtifacts.joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Text(model.renderRunStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.runSelectedProjectRender()
                } label: {
                    if model.isRunningRender {
                        Label("Rendering Final", systemImage: "hourglass")
                    } else {
                        Label("Render Final Package", systemImage: "film.stack")
                    }
                }
                .disabled(project == nil || model.isRunningRender || !model.renderRunPlan.canRun)
                Text(model.renderRunPlan.commandLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Section("Editor Handoff") {
                LabeledContent("Status", value: model.handoffExportPlan?.readinessLabel ?? "not checked")
                LabeledContent("Clip notes", value: "\(model.handoffExportPlan?.editorAnnotationNoteCount ?? 0)")
                LabeledContent("Source map", value: "\(model.handoffExportPlan?.sourceMapEntryCount ?? 0) entries")
                LabeledContent("Map status", value: model.handoffExportPlan?.sourceMapReadinessLabel ?? "not checked")
                LabeledContent("Map coverage", value: model.handoffExportPlan?.sourceMapCoverageLabel ?? "-")
                LabeledContent("Temporary map", value: model.handoffExportPlan?.usesTemporarySourceMap == true ? "yes" : "no")
                LabeledContent("Generated map", value: "\(model.handoffExportPlan?.generatedSourceMapEntryCount ?? 0) entries")
                LabeledContent("Relinks", value: "\(model.handoffExportPlan?.mediaMissingCount ?? 0)")
                if let annotationURL = model.editorAnnotationSummary?.url {
                    LabeledContent("Annotations", value: annotationURL.lastPathComponent)
                    Text(annotationURL.path)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let output = model.handoffExportPlan?.outputURL {
                    LabeledContent("Premiere XML", value: output.lastPathComponent)
                    Text(output.path)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(model.handoffExportStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.exportSelectedProjectPremiereXML()
                } label: {
                    if model.isExportingPremiereXML {
                        Label("Exporting XML", systemImage: "hourglass")
                    } else {
                        Label("Export Premiere XML", systemImage: "square.and.arrow.up")
                    }
                }
                .disabled(project == nil || model.isExportingPremiereXML || model.handoffExportPlan?.canExportPremiereXML != true)

                Divider()

                LabeledContent("Editor packet", value: model.editorPacketPlan?.readinessLabel ?? "not checked")
                LabeledContent("Review report", value: model.editorPacketPlan?.reviewReportIncluded == true ? "included" : "not included")
                LabeledContent("Review patch", value: model.editorPacketPlan?.reviewPatchIncluded == true ? "included" : "not included")
                LabeledContent("Preview/final media", value: "\(model.editorPacketPlan?.mediaIncludedCount ?? 0) files")
                LabeledContent("Packet verify", value: model.editorPacketVerificationStatus.readinessLabel)
                LabeledContent("Packet files", value: "\(model.editorPacketVerificationStatus.existingFileCount)/\(model.editorPacketVerificationStatus.manifestFileCount)")
                LabeledContent("Final media", value: model.editorPacketVerificationStatus.finalMediaIncluded ? "included" : "missing")
                LabeledContent("Final audio", value: model.editorPacketVerificationStatus.finalAudioIncluded ? "included" : "missing")
                if let packet = model.editorPacketPlan?.packetURL {
                    Text(packet.path)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(model.editorPacketVerificationStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(model.editorPacketStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.exportSelectedProjectEditorPacket()
                } label: {
                    if model.isExportingEditorPacket {
                        Label("Exporting Packet", systemImage: "hourglass")
                    } else {
                        Label("Export Editor Packet", systemImage: "shippingbox.and.arrow.backward")
                    }
                }
                .disabled(project == nil || model.isExportingEditorPacket || model.editorPacketPlan?.canExportPacket != true)

                Button {
                    model.revealEditorPacketInFinder()
                } label: {
                    Label("Reveal Packet", systemImage: "folder")
                }
                .disabled(model.editorPacketPlan == nil)

                if let command = model.handoffExportPlan?.commandLine {
                    Text(command)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            Section("SQLite Index") {
                LabeledContent("Status", value: model.indexStatus.exists ? "available" : "missing")
                LabeledContent("Documents", value: "\(model.indexStatus.documentCount)")
                LabeledContent("Updated", value: model.indexStatus.updatedAt ?? "-")
                Text(model.indexOperationStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.rebuildSelectedProjectIndex()
                } label: {
                    Label("Rebuild Index", systemImage: "externaldrive.badge.plus")
                }
                .disabled(project == nil)
            }

            Section("Search") {
                HStack {
                    TextField("Search transcript, tags, Marlin events", text: $model.indexSearchQuery)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit {
                            model.searchSelectedProjectIndex()
                        }
                    Button {
                        model.searchSelectedProjectIndex()
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .disabled(model.indexSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                Button {
                    model.appendIndexContextToAgentPrompt()
                } label: {
                    Label("Add RAG Context to Agent", systemImage: "text.badge.plus")
                }
                .disabled(model.indexContextPack.isEmpty)

                if model.indexSearchResults.isEmpty {
                    Text("Build the index, then search by dialogue, visual tags, audio cues, or Marlin descriptions.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("\(model.indexContextPack.items.count) cited items ready for Codex prompt context.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(model.indexSearchResults) { result in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(result.kind)
                                    .font(.caption2.weight(.semibold))
                                Spacer()
                                Text([result.assetID, result.segmentID].compactMap { $0 }.joined(separator: " / "))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(result.title)
                                .font(.caption)
                                .lineLimit(2)
                            if !result.text.isEmpty {
                                Text(result.text)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    private func renderQAValue(_ status: ProjectRenderPackageStatus) -> String {
        guard status.qaReportExists else { return "missing" }
        guard status.qaReportReadable else { return "unreadable" }
        if status.qaPassed == true { return "passed" }
        if status.qaPassed == false { return "failed" }
        return "unknown"
    }

    private func marlinPolicyValue(_ status: ProjectMarlinEvaluationStatus) -> String {
        let enabled = status.policyEnabled.map { $0 ? "enabled" : "disabled" } ?? "unknown"
        let mode = status.policyMode ?? "unknown"
        let mock = status.policyMock == true ? "mock" : "live"
        return "\(enabled) / \(mode) / \(mock)"
    }

    private func marlinCoverageValue(_ status: ProjectMarlinEvaluationStatus) -> String {
        guard status.segmentCount > 0 else { return "0/0 segments" }
        let percent = Int((status.coverageRatio * 100).rounded())
        return "\(status.segmentsWithMarlinPeakCount)/\(status.segmentCount) peak segments (\(percent)%)"
    }

    private func marlinPreferenceValue(_ decision: ProjectMarlinPreferenceDecision) -> String {
        let percent = Int((decision.aggregateCoverageRatio * 100).rounded())
        return "\(decision.candidateProjectCount)/\(decision.evaluatedProjectCount) projects, \(decision.representativeCandidateBucketCount)/\(decision.representativeTargetBucketCount) buckets, \(percent)% peak coverage"
    }

    private func renderArtifactRow(_ title: String, url: URL, exists: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Label(title, systemImage: exists ? "checkmark.circle" : "circle.dashed")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(exists ? .green : .secondary)
                Spacer()
                Text(exists ? "exists" : "missing")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Text(url.path)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private func icon(for status: ProjectMediaPreviewStatus.PlaybackStatus) -> String {
        switch status {
        case .directVideo: return "play.rectangle"
        case .proxyVideo: return "rectangle.on.rectangle"
        case .directAudio: return "waveform"
        case .needsProxy: return "arrow.triangle.2.circlepath"
        case .missing: return "questionmark.video"
        }
    }

    private func color(for status: ProjectMediaPreviewStatus.PlaybackStatus) -> Color {
        switch status {
        case .directVideo, .proxyVideo, .directAudio: return .green
        case .needsProxy: return .orange
        case .missing: return .red
        }
    }
}

private struct TimelinePanel: View {
    var project: ProjectSummary?
    var timeline: TimelineDocument?
    var status: String
    var audioCues: [TimelineAudioCue]
    var audioWaveforms: [TimelineAudioWaveform]
    var audioWaveformStatus: String
    @Binding var selectedClipID: TimelineClip.ID?
    var playheadFrame: Int
    var onScrubPlayhead: (Int) -> Void
    var onSelectClip: (TimelineClip.ID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Timeline")
                    .font(.headline)
                Spacer()
                Text(project?.hasTimeline == true ? "timeline.json" : "waiting for compile")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let timeline {
                TimelineRuler(timeline: timeline, playheadFrame: playheadFrame)
                Text(audioWaveformStatus)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Slider(
                    value: Binding(
                        get: { Double(playheadFrame) },
                        set: { onScrubPlayhead(Int($0.rounded())) }
                    ),
                    in: 0...Double(max(timeline.totalFrames, 1)),
                    step: 1
                )
                GeometryReader { geometry in
                    let labelWidth: CGFloat = 34
                    let rowSpacing: CGFloat = 10
                    let trailingPadding: CGFloat = 18
                    let viewportLaneWidth = max(320, geometry.size.width - labelWidth - rowSpacing - trailingPadding)
                    let laneWidth = max(viewportLaneWidth, CGFloat(timeline.totalFrames) * 3.2)

                    ScrollView([.horizontal, .vertical]) {
                        VStack(alignment: .leading, spacing: 6) {
                            TimelineMarkerLane(
                                markers: ProjectTimelineMarkerMap.build(timeline: timeline).markers,
                                totalFrames: timeline.totalFrames,
                                playheadFrame: playheadFrame,
                                laneWidth: laneWidth
                            )
                            ForEach(timeline.displayTracks) { track in
                                TimelineTrackRow(
                                    track: track,
                                    totalFrames: timeline.totalFrames,
                                    laneWidth: laneWidth,
                                    audioCues: audioCues.filter { $0.trackID == track.id },
                                    audioWaveforms: audioWaveforms.filter { $0.trackID == track.id },
                                    selectedClipID: $selectedClipID,
                                    playheadFrame: playheadFrame,
                                    onSelectClip: onSelectClip
                                )
                            }
                        }
                        .padding(.trailing, trailingPadding)
                        .frame(
                            minWidth: geometry.size.width,
                            maxWidth: .infinity,
                            alignment: .topLeading
                        )
                    }
                }
                .frame(minHeight: 132, maxHeight: .infinity)
            } else {
                TimelineEmptyState(status: status)
            }
        }
        .padding(18)
    }
}

private struct TimelineRuler: View {
    var timeline: TimelineDocument
    var playheadFrame: Int

    var body: some View {
        HStack(spacing: 12) {
            LabeledContent("Sequence", value: timeline.sequence.name)
            LabeledContent("Playhead", value: timeline.sequence.framesToTimecode(playheadFrame))
            LabeledContent("FPS", value: timeline.sequence.fps.formatted(.number.precision(.fractionLength(0...2))))
            LabeledContent("Duration", value: formatSeconds(timeline.totalSeconds))
            LabeledContent("Canvas", value: "\(timeline.sequence.width)x\(timeline.sequence.height)")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    private func formatSeconds(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        let minutes = total / 60
        let remainder = total % 60
        return "\(minutes):\(String(format: "%02d", remainder))"
    }
}

private struct TimelineMarkerLane: View {
    var markers: [TimelineMarkerCue]
    var totalFrames: Int
    var playheadFrame: Int
    var laneWidth: CGFloat

    var body: some View {
        HStack(spacing: 10) {
            Text("M")
                .font(.system(.caption, design: .monospaced).weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 34, alignment: .trailing)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(.quaternary)
                ForEach(markers) { marker in
                    TimelineMarkerChip(marker: marker)
                        .offset(x: markerOffset(marker.frame))
                }
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: 2, height: 24)
                    .offset(x: markerOffset(playheadFrame))
            }
            .frame(width: laneWidth, height: 24)
        }
    }

    private func markerOffset(_ frame: Int) -> CGFloat {
        laneWidth * CGFloat(max(0, min(frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }
}

private struct TimelineMarkerChip: View {
    var marker: TimelineMarkerCue

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage)
                .font(.system(size: 8, weight: .bold))
            Text(marker.label)
                .font(.system(size: 9, weight: .semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 5)
        .frame(height: 18)
        .background(color.opacity(0.18), in: Capsule())
        .overlay {
            Capsule().stroke(color.opacity(0.75), lineWidth: 1)
        }
        .foregroundStyle(color)
        .help("\(marker.kind.rawValue) / \(marker.timecode) / \(marker.label)")
    }

    private var color: Color {
        switch marker.kind {
        case .beat: return .green
        case .note: return .blue
        case .warning: return .orange
        case .chapter: return .purple
        case .marker: return .secondary
        }
    }

    private var systemImage: String {
        switch marker.kind {
        case .beat: return "metronome"
        case .note: return "note.text"
        case .warning: return "exclamationmark.triangle"
        case .chapter: return "bookmark"
        case .marker: return "mappin"
        }
    }
}

private struct TimelineTrackRow: View {
    var track: TimelineTrack
    var totalFrames: Int
    var laneWidth: CGFloat
    var audioCues: [TimelineAudioCue]
    var audioWaveforms: [TimelineAudioWaveform]
    @Binding var selectedClipID: TimelineClip.ID?
    var playheadFrame: Int
    var onSelectClip: (TimelineClip.ID) -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text(track.id)
                .font(.system(.caption, design: .monospaced).weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 34, alignment: .trailing)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(.quaternary)
                ForEach(audioWaveforms) { waveform in
                    if let clip = track.clips.first(where: { $0.id == waveform.clipID }) {
                        TimelineWaveformOverlay(
                            waveform: waveform,
                            clip: clip,
                            laneWidth: laneWidth,
                            totalFrames: totalFrames
                        )
                    }
                }
                ForEach(track.clips.sorted { $0.timelineInFrame < $1.timelineInFrame }) { clip in
                    Button {
                        onSelectClip(clip.id)
                    } label: {
                        TimelineClipBlock(
                            clip: clip,
                            trackKind: track.kind,
                            isSelected: selectedClipID == clip.id,
                            isUnderPlayhead: clip.containsTimelineFrame(playheadFrame)
                        )
                    }
                    .buttonStyle(.plain)
                    .frame(
                        width: clipWidth(clip),
                        height: 28
                    )
                    .offset(x: clipOffset(clip))
                }
                ForEach(audioCues) { cue in
                    TimelineAudioCueOverlay(
                        cue: cue,
                        laneWidth: laneWidth,
                        totalFrames: totalFrames
                    )
                }
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: 2, height: 32)
                    .offset(x: playheadOffset)
            }
            .frame(width: laneWidth, height: 32)
        }
    }

    private var playheadOffset: CGFloat {
        laneWidth * CGFloat(max(0, min(playheadFrame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private func clipOffset(_ clip: TimelineClip) -> CGFloat {
        laneWidth * CGFloat(clip.timelineInFrame) / CGFloat(max(totalFrames, 1))
    }

    private func clipWidth(_ clip: TimelineClip) -> CGFloat {
        max(44, laneWidth * CGFloat(clip.timelineDurationFrames) / CGFloat(max(totalFrames, 1)))
    }
}

private struct TimelineWaveformOverlay: View {
    var waveform: TimelineAudioWaveform
    var clip: TimelineClip
    var laneWidth: CGFloat
    var totalFrames: Int

    var body: some View {
        Canvas { context, size in
            guard waveform.peaks.count > 1 else { return }
            let midY = size.height / 2
            let step = size.width / CGFloat(max(waveform.peaks.count - 1, 1))
            var path = Path()

            for (index, peak) in waveform.peaks.enumerated() {
                let x = CGFloat(index) * step
                let height = max(1, CGFloat(peak) * (size.height * 0.42))
                path.move(to: CGPoint(x: x, y: midY - height))
                path.addLine(to: CGPoint(x: x, y: midY + height))
            }

            context.stroke(path, with: .color(.primary.opacity(0.42)), lineWidth: 1)
        }
        .frame(width: width, height: 24)
        .offset(x: offset, y: 4)
        .allowsHitTesting(false)
        .help("waveform: \(waveform.assetID) / \(waveform.resolvedFrom)")
    }

    private var offset: CGFloat {
        laneWidth * CGFloat(clip.timelineInFrame) / CGFloat(max(totalFrames, 1))
    }

    private var width: CGFloat {
        max(44, laneWidth * CGFloat(clip.timelineDurationFrames) / CGFloat(max(totalFrames, 1)))
    }
}

private struct TimelineAudioCueOverlay: View {
    var cue: TimelineAudioCue
    var laneWidth: CGFloat
    var totalFrames: Int

    var body: some View {
        Group {
            if cue.kind == .bgmBeat || cue.kind == .bgmDownbeat {
                Rectangle()
                    .fill(color)
                    .frame(width: cue.kind == .bgmDownbeat ? 3 : 1.5, height: cue.kind == .bgmDownbeat ? 30 : 22)
                    .offset(x: offset(for: cue.frame), y: cue.kind == .bgmDownbeat ? 1 : 5)
            } else {
                RoundedRectangle(cornerRadius: 2)
                    .fill(color.opacity(0.72))
                    .frame(width: width, height: cue.kind == .bgmSection ? 8 : 11)
                    .overlay(alignment: .leading) {
                        if width > 64 {
                            Text(cue.label)
                                .font(.system(size: 8, weight: .semibold))
                                .lineLimit(1)
                                .padding(.horizontal, 4)
                                .foregroundStyle(.primary)
                        }
                    }
                    .offset(x: offset(for: cue.frame), y: cue.kind == .bgmSection ? 23 : 3)
            }
        }
        .help("\(cue.kind.rawValue): \(cue.label)\(cue.detail.map { " / \($0)" } ?? "")")
    }

    private var width: CGFloat {
        guard let endFrame = cue.endFrame else { return 8 }
        let frames = max(1, endFrame - cue.frame)
        return max(8, laneWidth * CGFloat(frames) / CGFloat(max(totalFrames, 1)))
    }

    private func offset(for frame: Int) -> CGFloat {
        laneWidth * CGFloat(max(0, min(frame, totalFrames))) / CGFloat(max(totalFrames, 1))
    }

    private var color: Color {
        switch cue.kind {
        case .audioEvent: return .orange
        case .audioStory: return .teal
        case .bgmBeat: return .green.opacity(0.75)
        case .bgmDownbeat: return .green
        case .bgmSection: return .mint
        }
    }
}

private struct TimelineClipBlock: View {
    var clip: TimelineClip
    var trackKind: TimelineTrackKind
    var isSelected: Bool
    var isUnderPlayhead: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(color.opacity(isUnderPlayhead ? 0.98 : (trackKind == .audio ? 0.70 : 0.82)))
            .overlay {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(isSelected ? Color.accentColor : (isUnderPlayhead ? Color.primary.opacity(0.45) : Color.clear), lineWidth: 2)
            }
            .overlay(alignment: .leading) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(clip.role)
                        .font(.caption2.weight(.semibold))
                    Text(clip.segmentID)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
                .padding(.horizontal, 6)
                .foregroundStyle(.primary)
            }
            .help("\(clip.id) / \(clip.motivation)")
    }

    private var color: Color {
        switch clip.role {
        case "hero": return .blue
        case "dialogue": return .indigo
        case "support": return .cyan
        case "transition": return .purple
        case "texture": return .mint
        case "music", "bgm": return .green
        case "nat_sound", "ambient": return .orange
        case "title": return .pink
        default: return trackKind == .audio ? .orange : .gray
        }
    }
}

private struct TimelineEmptyState: View {
    var status: String

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(.quaternary)
            VStack(spacing: 8) {
                Image(systemName: "timeline.selection")
                    .font(.system(size: 28))
                    .foregroundStyle(.secondary)
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }
            .frame(height: 28)
        }
        .frame(minHeight: 120)
    }
}

struct SettingsView: View {
    @AppStorage("videoOSStudioPreferredTransport") private var preferredTransport = CodexAppServerTransport.stdio.rawValue
    private let policyStatus = ProjectAnalysisPolicyStatusReader.status(repositoryRoot: ProjectScanner.locateRepositoryRoot())
    private let marlinRuntimeStatus = ProjectMarlinRuntimeStatusReader.status(repositoryRoot: ProjectScanner.locateRepositoryRoot())

    var body: some View {
        Form {
            Section("Codex App Server") {
                Picker("Transport", selection: $preferredTransport) {
                    ForEach(CodexAppServerTransport.allCases, id: \.rawValue) { transport in
                        Text(transport.rawValue).tag(transport.rawValue)
                    }
                }
                Text("Initial builds use stdio. WebSocket and Unix socket modes are reserved for embedded runtime and packaged app flows.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Analysis Policy") {
                LabeledContent("Status", value: policyStatus.readinessLabel)
                LabeledContent("Policy file", value: policyStatus.policyURL.path)
                LabeledContent("VLM", value: policyStatus.vlmPolicyLabel)
            }

            Section("Marlin-2B") {
                LabeledContent("Policy", value: policyStatus.marlinPolicyLabel)
                LabeledContent("Runtime", value: marlinRuntimeStatus.readinessLabel)
                LabeledContent("Device", value: "\(marlinRuntimeStatus.resolvedDeviceLabel) / \(marlinRuntimeStatus.deviceStatusLabel)")
                LabeledContent("Accelerators", value: "CUDA \(marlinRuntimeStatus.cudaAvailable ? "yes" : "no") / MPS \(marlinRuntimeStatus.mpsAvailable ? "yes" : "no")")
                LabeledContent("Role", value: policyStatus.marlinRole ?? "-")
                LabeledContent("Model", value: policyStatus.marlinModelAlias ?? "-")
                LabeledContent("Connector", value: policyStatus.marlinConnectorVersion ?? "-")
                LabeledContent("Worker", value: policyStatus.marlinWorkerPath ?? "-")
                LabeledContent("Output", value: policyStatus.marlinOutputArtifact ?? "-")
                ForEach(marlinRuntimeStatus.requirements) { requirement in
                    LabeledContent(requirement.id, value: "\(requirement.statusLabel) / \(requirement.detail)")
                }
                Text(policyStatus.preferredVLMRule)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(marlinRuntimeStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(marlinRuntimeStatus.setupCommand)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .formStyle(.grouped)
    }
}
