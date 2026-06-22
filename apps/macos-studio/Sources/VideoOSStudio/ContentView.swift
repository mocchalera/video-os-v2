import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

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
                .environmentObject(model.feedbackSession)
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
        .sheet(isPresented: $model.isSwapBrowserPresented) {
            if let clip = model.swapBrowserClip, let dataSource = model.candidateDataSource {
                CandidateSwapView(
                    clip: clip,
                    beatID: clip.beatID,
                    dataSource: dataSource,
                    evidenceStore: model.evidenceStore,
                    projectURL: model.selectedProject?.path,
                    feedbackSession: model.feedbackSession,
                    isPresented: $model.isSwapBrowserPresented
                )
            } else {
                ProgressView("Loading candidates...")
                    .frame(width: 360, height: 180)
            }
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
                    playbackContract: model.playbackContractStatus,
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
                onSelectClip: { model.selectTimelineClip($0) },
                onOpenSwapBrowser: { model.openSwapBrowser(for: $0) }
            )
                .frame(minHeight: 230, idealHeight: 280)

            FeedbackStatusBar(
                feedbackSession: model.feedbackSession,
                onApplyAndPreview: { model.applyStudioPatch() },
                onPromote: { model.promoteStudioPatch() },
                onDiscard: { model.feedbackSession.clearAll() }
            )
        }
    }
}
