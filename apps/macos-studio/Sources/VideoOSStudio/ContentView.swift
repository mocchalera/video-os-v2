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
        .frame(minWidth: 980, minHeight: 700)
        .background(
            CommandPalettePanelPresenter(
                model: model,
                query: $commandPaletteQuery,
                isPresented: $isCommandPalettePresented
            )
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
        )
        .sheet(isPresented: $model.isSwapBrowserPresented) {
            if let clip = model.swapBrowserClip, let dataSource = model.candidateDataSource {
                CandidateSwapView(
                    clip: clip,
                    beatID: clip.beatID,
                    dataSource: dataSource,
                    evidenceStore: model.evidenceStore,
                    projectURL: model.selectedProject?.path,
                    feedbackSession: model.feedbackSession,
                    onSearchForMore: {
                        model.isSwapBrowserPresented = false
                        model.openFootageSearch(for: clip)
                    },
                    isPresented: $model.isSwapBrowserPresented
                )
            } else {
                ProgressView("Loading candidates...")
                    .frame(width: 360, height: 180)
            }
        }
        .sheet(isPresented: $model.isFootageSearchPresented) {
            if let project = model.selectedProject {
                FootageSearchView(
                    feedbackSession: model.feedbackSession,
                    projectURL: project.path,
                    repositoryRoot: model.repositoryRoot,
                    evidenceStore: model.evidenceStore,
                    timeline: model.timeline,
                    selectedClip: model.selectedTimelineClip?.clip,
                    initialBeatID: model.selectedTimelineClip?.clip.beatID,
                    onPreview: { model.previewFootageSearchResult($0) },
                    isPresented: $model.isFootageSearchPresented
                )
            } else {
                ProgressView("Loading project...")
                    .frame(width: 360, height: 180)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .openStudioCommandPalette)) { _ in
            commandPaletteQuery = ""
            isCommandPalettePresented = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .closeStudioCommandPalette)) { _ in
            isCommandPalettePresented = false
        }
    }
}

private struct CommandPalettePanelPresenter: NSViewRepresentable {
    @ObservedObject var model: StudioViewModel
    @Binding var query: String
    @Binding var isPresented: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> NSView {
        NSView(frame: .zero)
    }

    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.parent = self
        if isPresented {
            context.coordinator.show(attachedTo: view)
        } else {
            context.coordinator.closePanelFromBinding()
        }
    }

    final class Coordinator: NSObject, NSWindowDelegate {
        var parent: CommandPalettePanelPresenter
        private var panel: NSPanel?
        private var hostingController: NSHostingController<AnyView>?
        private var isClosingFromBinding = false

        init(parent: CommandPalettePanelPresenter) {
            self.parent = parent
        }

        func show(attachedTo anchorView: NSView) {
            let panel = existingOrNewPanel()
            updateRootView()
            let parentWindow = anchorView.window
                ?? NSApp.mainWindow
                ?? NSApp.keyWindow
                ?? NSApp.windows.first { $0.title == "Video OS Studio" }
            position(panel, near: parentWindow)
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
            panel.orderFrontRegardless()
            DispatchQueue.main.async { [weak self, weak panel] in
                guard let self, let panel else { return }
                panel.makeKey()
                self.focusSearchField(in: panel.contentView)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self, weak panel] in
                guard let self, let panel, panel.isVisible else { return }
                panel.makeKey()
                self.focusSearchField(in: panel.contentView)
            }
        }

        func closePanelFromBinding() {
            guard let panel, panel.isVisible else { return }
            isClosingFromBinding = true
            panel.close()
            isClosingFromBinding = false
        }

        func windowWillClose(_ notification: Notification) {
            guard !isClosingFromBinding else { return }
            if parent.isPresented {
                parent.isPresented = false
            }
        }

        private func existingOrNewPanel() -> NSPanel {
            if let panel { return panel }

            let panel = CommandPalettePanel(
                contentRect: NSRect(x: 0, y: 0, width: 580, height: 540),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            panel.title = "Command Palette"
            panel.identifier = NSUserInterfaceItemIdentifier("CommandPalettePanel")
            panel.isReleasedWhenClosed = false
            panel.hidesOnDeactivate = false
            panel.becomesKeyOnlyIfNeeded = false
            panel.level = .floating
            panel.collectionBehavior = [.transient, .moveToActiveSpace]
            panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
            panel.standardWindowButton(.zoomButton)?.isHidden = true
            panel.delegate = self

            let hostingController = NSHostingController(rootView: rootView())
            hostingController.view.setAccessibilityIdentifier("CommandPaletteHost")
            panel.contentViewController = hostingController
            self.hostingController = hostingController
            self.panel = panel
            return panel
        }

        private func updateRootView() {
            hostingController?.rootView = rootView()
        }

        private func rootView() -> AnyView {
            AnyView(
                StudioCommandPaletteView(
                    model: parent.model,
                    query: Binding(
                        get: { [weak self] in self?.parent.query ?? "" },
                        set: { [weak self] newValue in self?.parent.query = newValue }
                    ),
                    isPresented: Binding(
                        get: { [weak self] in self?.parent.isPresented ?? false },
                        set: { [weak self] newValue in self?.parent.isPresented = newValue }
                    )
                )
                .frame(width: 580, height: 540)
            )
        }

        private func position(_ panel: NSPanel, near window: NSWindow?) {
            guard let window else {
                panel.center()
                return
            }

            let parentFrame = window.frame
            let panelFrame = panel.frame
            let origin = NSPoint(
                x: parentFrame.midX - panelFrame.width / 2,
                y: parentFrame.midY - panelFrame.height / 2
            )
            panel.setFrameOrigin(origin)
        }

        @discardableResult
        private func focusSearchField(in view: NSView?) -> Bool {
            guard let view else { return false }
            if let textField = view as? NSTextField {
                textField.stringValue = parent.query
                view.window?.makeFirstResponder(textField)
                textField.currentEditor()?.string = parent.query
                textField.selectText(nil)
                return true
            }
            for subview in view.subviews {
                if focusSearchField(in: subview) {
                    return true
                }
            }
            return false
        }
    }
}

private final class CommandPalettePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        close()
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            close()
            return
        }
        super.keyDown(with: event)
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
                .accessibilityLabel(model.isInitializingProject ? "Creating new project" : "New Project")
                .accessibilityIdentifier("ProjectShelf.NewProject")

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
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.bordered)
                        .tint(project.id == model.selectedProjectID ? .accentColor : .secondary)
                        .accessibilityLabel("\(project.name), \(project.stateLabel)")
                        .accessibilityIdentifier("ProjectShelf.\(project.id)")
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
        ViewThatFits(in: .horizontal) {
            topBarContent {
                surfacePicker(maxWidth: 720)
            }
            topBarContent {
                surfacePicker(maxWidth: 420)
            }
            topBarContent {
                surfaceMenu
            }
        }
        .buttonStyle(.borderless)
        .controlSize(.large)
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(.regularMaterial)
    }

    private func topBarContent<SurfaceControl: View>(
        @ViewBuilder surfaceControl: () -> SurfaceControl
    ) -> some View {
        HStack(spacing: 12) {
            surfaceControl()

            Spacer(minLength: 12)

            Button(action: onOpenCommandPalette) {
                Label("Command Palette", systemImage: "command")
                    .labelStyle(.iconOnly)
                    .frame(width: 30, height: 28)
                    .contentShape(Rectangle())
            }
            .keyboardShortcut("k", modifiers: [.command])
            .accessibilityLabel("Command Palette")
            .accessibilityIdentifier("CommandPaletteButton")
            .help("Command Palette")

            Button(action: onRefresh) {
                Label("Refresh Projects", systemImage: "arrow.clockwise")
                    .labelStyle(.iconOnly)
                    .frame(width: 30, height: 28)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Refresh Projects")
            .accessibilityIdentifier("RefreshProjectsButton")
            .help("Refresh Projects")
        }
    }

    private func surfacePicker(maxWidth: CGFloat) -> some View {
        Picker("Agent Surface", selection: $selectedSurface) {
            ForEach(StudioAgentSurface.allCases) { surface in
                Text(surface.rawValue).tag(surface)
            }
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: maxWidth)
    }

    private var surfaceMenu: some View {
        Menu {
            ForEach(StudioAgentSurface.allCases) { surface in
                Button {
                    selectedSurface = surface
                } label: {
                    Label(
                        surface.rawValue,
                        systemImage: surface == selectedSurface ? "checkmark" : "circle"
                    )
                }
            }
        } label: {
            Label(selectedSurface.rawValue, systemImage: "rectangle.3.group")
                .lineLimit(1)
        }
        .help("Agent Surface")
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
            item.matches(query: normalized)
        }
    }

    private var firstEnabledCommand: StudioCommandPaletteItem? {
        filteredCommands.first { $0.isEnabled }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "command")
                    .foregroundStyle(.secondary)
                TextField("Search commands", text: $query)
                    .textFieldStyle(.plain)
                    .focused($searchFocused)
                    .accessibilityLabel("Search commands")
                    .accessibilityIdentifier("CommandPaletteSearchField")
                    .onSubmit {
                        if let item = firstEnabledCommand {
                            performCommand(item)
                        }
                    }
                Button {
                    isPresented = false
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Close Command Palette")
                .accessibilityIdentifier("CommandPaletteCloseButton")
                .keyboardShortcut(.cancelAction)
            }
            .padding(10)
            .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(filteredCommands) { item in
                        Button {
                            performCommand(item)
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
                        .accessibilityLabel(item.title)
                        .accessibilityIdentifier(item.accessibilityIdentifier)
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
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Command Palette")
        .accessibilityIdentifier("CommandPaletteSheet")
        .onAppear {
            searchFocused = true
        }
        .onExitCommand {
            isPresented = false
        }
    }

    private func performCommand(_ item: StudioCommandPaletteItem) {
        guard item.isEnabled else { return }
        isPresented = false
        item.perform()
    }

    private var commandItems: [StudioCommandPaletteItem] {
        let hasProject = model.selectedProject != nil
        let availability = model.commandAvailabilityContext
        return [
            StudioCommandPaletteItem(
                command: .refreshProjects,
                subtitle: "Reload project list, artifact status, and readiness panels.",
                isEnabled: true,
                perform: { model.refresh() }
            ),
            StudioCommandPaletteItem(
                command: .newProjectFromSource,
                subtitle: "Create a project from the template and link a source media folder.",
                isEnabled: !model.isInitializingProject,
                disabledReason: model.isInitializingProject ? "Creating" : nil,
                perform: { model.chooseAndInitializeProject() }
            ),
            StudioCommandPaletteItem(
                command: .checkCodexAppServer,
                subtitle: "Run the initialize handshake for the Codex runtime.",
                isEnabled: availability.isEnabled(.checkCodexAppServer),
                disabledReason: availability.disabledReason(for: .checkCodexAppServer),
                perform: { model.checkAppServer() }
            ),
            StudioCommandPaletteItem(
                command: .startAgentSession,
                subtitle: "Start a project-scoped Codex App Server thread.",
                isEnabled: availability.isEnabled(.startAgentSession),
                disabledReason: availability.disabledReason(for: .startAgentSession),
                perform: { model.startAgentSession() }
            ),
            StudioCommandPaletteItem(
                command: .stopAgentSession,
                subtitle: "Stop the active Codex session.",
                isEnabled: availability.isEnabled(.stopAgentSession),
                disabledReason: availability.disabledReason(for: .stopAgentSession),
                perform: { model.stopAgentSession() }
            ),
            StudioCommandPaletteItem(
                command: .runSelectedAgentJob,
                subtitle: "Run the selected Codex job or open the approval gate for write jobs.",
                isEnabled: availability.isEnabled(.runSelectedAgentJob),
                disabledReason: availability.disabledReason(for: .runSelectedAgentJob),
                perform: { model.runSelectedJob() }
            ),
            StudioCommandPaletteItem(
                command: .runReadOnlyAgentTurn,
                subtitle: "Run the freeform prompt in read-only sandbox mode.",
                isEnabled: availability.isEnabled(.runReadOnlyAgentTurn),
                disabledReason: availability.disabledReason(for: .runReadOnlyAgentTurn),
                perform: { model.runAgentTurn() }
            ),
            StudioCommandPaletteItem(
                command: .approvePendingAgentJob,
                subtitle: "Approve the currently pending workspace-write Codex job.",
                isEnabled: availability.isEnabled(.approvePendingAgentJob),
                disabledReason: availability.disabledReason(for: .approvePendingAgentJob),
                perform: { model.approvePendingJob() }
            ),
            StudioCommandPaletteItem(
                command: .runSourceAnalysis,
                subtitle: model.analysisRunStatus,
                isEnabled: hasProject && !model.isRunningAnalysis && model.analysisRunPlan.canRun,
                disabledReason: hasProject ? model.analysisRunPlan.readinessLabel : "No project",
                perform: { model.runSelectedProjectAnalysis() }
            ),
            StudioCommandPaletteItem(
                command: .compileRoughCut,
                subtitle: model.roughCutCompileStatus,
                isEnabled: hasProject && !model.isCompilingRoughCut && model.roughCutCompilePlan.canRun,
                disabledReason: hasProject ? model.roughCutCompilePlan.readinessLabel : "No project",
                perform: { model.compileSelectedProjectRoughCut() }
            ),
            StudioCommandPaletteItem(
                command: .applyReviewPatch,
                subtitle: "Apply review_patch.json through the deterministic compiler.",
                isEnabled: hasProject && !model.isCompilingRoughCut,
                disabledReason: hasProject ? nil : "No project",
                perform: { model.compileSelectedProjectWithReviewPatch() }
            ),
            StudioCommandPaletteItem(
                command: .searchFootage,
                subtitle: "Find footage with text, Qwen visual, CLAP audio, or hybrid vector search.",
                isEnabled: hasProject,
                disabledReason: "No project",
                perform: { model.openFootageSearch() }
            ),
            StudioCommandPaletteItem(
                command: .rebuildSearchIndex,
                subtitle: "Rebuild the derived SQLite material/RAG index.",
                isEnabled: hasProject,
                disabledReason: "No project",
                perform: { model.rebuildSelectedProjectIndex() }
            ),
            StudioCommandPaletteItem(
                command: .runMarlinEvaluation,
                subtitle: model.marlinEvaluationRunStatus,
                isEnabled: hasProject && !model.isRunningMarlinEvaluation && model.marlinEvaluationRunPlan.canRun,
                disabledReason: hasProject ? model.marlinEvaluationRunPlan.readinessLabel : "No project",
                perform: { model.runSelectedProjectMarlinEvaluation() }
            ),
            StudioCommandPaletteItem(
                command: .buildAudioStoryGraph,
                subtitle: model.audioStoryGraphRunStatus,
                isEnabled: hasProject && !model.isBuildingAudioStoryGraph && model.audioStoryGraphRunPlan.canRun,
                disabledReason: hasProject ? model.audioStoryGraphRunPlan.readinessLabel : "No project",
                perform: { model.buildSelectedProjectAudioStoryGraph() }
            ),
            StudioCommandPaletteItem(
                command: .buildPreviewProxies,
                subtitle: model.mediaProxyOperationStatus,
                isEnabled: hasProject && !model.isBuildingMediaProxies && model.mediaProxyPlan.pendingCount > 0,
                disabledReason: hasProject ? "No pending proxies" : "No project",
                perform: { model.buildSelectedProjectMediaProxies() }
            ),
            StudioCommandPaletteItem(
                command: .relinkMissingMedia,
                subtitle: model.mediaRelinkStatus,
                isEnabled: hasProject && !model.isRelinkingMedia,
                disabledReason: "No project",
                perform: { model.chooseAndRelinkSelectedProjectMedia() }
            ),
            StudioCommandPaletteItem(
                command: .exportPremiereXML,
                subtitle: model.handoffExportStatus,
                isEnabled: hasProject && !model.isExportingPremiereXML && (model.handoffExportPlan?.canExportPremiereXML ?? false),
                disabledReason: hasProject ? model.handoffExportPlan?.readinessLabel : "No project",
                perform: { model.exportSelectedProjectPremiereXML() }
            ),
            StudioCommandPaletteItem(
                command: .exportEditorPacket,
                subtitle: model.editorPacketStatus,
                isEnabled: hasProject && !model.isExportingEditorPacket && (model.editorPacketPlan?.canExportPacket ?? false),
                disabledReason: hasProject ? model.editorPacketPlan?.readinessLabel : "No project",
                perform: { model.exportSelectedProjectEditorPacket() }
            ),
            StudioCommandPaletteItem(
                command: .renderFinalPackage,
                subtitle: model.renderRunStatus,
                isEnabled: hasProject && !model.isRunningRender && model.renderRunPlan.canRun,
                disabledReason: hasProject ? model.renderRunPlan.readinessLabel : "No project",
                perform: { model.runSelectedProjectRender() }
            ),
            StudioCommandPaletteItem(
                command: .runStudioAcceptanceSmoke,
                subtitle: model.studioAcceptanceSmokeStatus,
                isEnabled: !model.isRunningStudioAcceptanceSmoke,
                disabledReason: "Running",
                perform: { model.runStudioAcceptanceSmoke() }
            ),
            StudioCommandPaletteItem(
                command: .playTimeline,
                isPlaying: model.isPlaying,
                subtitle: model.timelineStatus,
                isEnabled: model.timeline != nil,
                disabledReason: "No timeline",
                perform: { model.togglePlayback() }
            )
        ]
    }
}

private struct StudioCommandPaletteItem: Identifiable {
    let command: StudioCommandPaletteCommand
    let id: StudioCommandPaletteCommand
    let title: String
    let subtitle: String
    let systemImage: String
    let isEnabled: Bool
    let disabledReason: String?
    let perform: () -> Void

    init(
        command: StudioCommandPaletteCommand,
        isPlaying: Bool = false,
        subtitle: String,
        isEnabled: Bool,
        disabledReason: String? = nil,
        perform: @escaping () -> Void
    ) {
        self.command = command
        self.id = command
        self.title = command.title(isPlaying: isPlaying)
        self.subtitle = subtitle
        self.systemImage = command.systemImage(isPlaying: isPlaying)
        self.isEnabled = isEnabled
        self.disabledReason = disabledReason
        self.perform = perform
    }

    var accessibilityIdentifier: String {
        command.accessibilityIdentifier
    }

    func matches(query: String) -> Bool {
        command.matches(query: query, title: title, subtitle: subtitle)
    }
}

private struct StudioWorkspaceView: View {
    @ObservedObject var model: StudioViewModel
    @FocusState private var timelineFocused: Bool

    var body: some View {
        GeometryReader { proxy in
            workspaceLayout(isCompact: proxy.size.width < 1040)
        }
    }

    @ViewBuilder
    private func workspaceLayout(isCompact: Bool) -> some View {
        VStack(spacing: 0) {
            if isCompact {
                VStack(spacing: 0) {
                    viewerPanel
                        .frame(minHeight: 280, maxHeight: .infinity)
                    Divider()
                    InspectorPanel(model: model)
                        .frame(minHeight: 180, idealHeight: 220, maxHeight: 260)
                }
                .frame(minHeight: 430, maxHeight: .infinity)
            } else {
                HStack(spacing: 0) {
                    viewerPanel
                        .frame(minWidth: 600, maxWidth: .infinity, maxHeight: .infinity)
                    Divider()
                    InspectorPanel(model: model)
                        .frame(minWidth: 300, idealWidth: 340, maxWidth: 360)
                }
                .frame(minHeight: 430, maxHeight: .infinity)
            }

            Divider()

            TimelinePanel(
                project: model.selectedProject,
                timeline: model.timeline,
                status: model.timelineStatus,
                audioCues: model.timelineAudioCues,
                audioWaveforms: model.timelineAudioWaveforms,
                audioWaveformStatus: model.audioWaveformStatus,
                recentlyChangedClipIDs: model.recentlyChangedClipIDs,
                selectedClipID: $model.selectedTimelineClipID,
                playheadFrame: model.playheadFrame,
                onScrubPlayhead: {
                    timelineFocused = true
                    model.scrubPlayhead(to: $0)
                },
                onSelectClip: {
                    timelineFocused = true
                    model.selectTimelineClip($0)
                },
                onOpenSwapBrowser: {
                    timelineFocused = true
                    model.openSwapBrowser(for: $0)
                },
                onOpenFootageSearch: {
                    timelineFocused = true
                    model.openFootageSearch(for: $0)
                }
            )
                .frame(minHeight: 230, idealHeight: 280)
                .focusable(true)
                .focused($timelineFocused)
                .simultaneousGesture(TapGesture().onEnded {
                    timelineFocused = true
                })

            FeedbackStatusBar(
                feedbackSession: model.feedbackSession,
                statusMessage: model.roughCutCompileStatus,
                canPromote: model.canPromoteLatestStudioPatch,
                onApplyAndPreview: { model.applyStudioPatch() },
                onPromote: { model.promoteStudioPatch() },
                onDiscard: { model.feedbackSession.clearAll() }
            )
        }
        .overlay(alignment: .topLeading) {
            TimelineShortcutButtons(model: model, isEnabled: timelineFocused)
        }
    }

    private var viewerPanel: some View {
        ViewerPanel(
            project: model.selectedProject,
            playbackContract: model.playbackContractStatus,
            selection: model.programTimelineClip ?? model.selectedTimelineClip,
            media: model.programMediaReference,
            audioMedia: model.programAudioMediaReference,
            nextMedia: model.nextProgramMediaReference,
            mediaPreviewSummary: model.mediaPreviewSummary,
            playheadLabel: model.timeline?.sequence.framesToTimecode(model.playheadFrame),
            isPlaying: model.isPlaying,
            syncGeneration: model.mediaPlaybackSyncGeneration,
            audioSyncGeneration: model.audioPlaybackSyncGeneration,
            audioMuted: model.monitorAudioMuted,
            audioVolume: model.monitorAudioVolume,
            onDiagnosticAction: { model.performViewerDiagnosticAction($0) },
            onTogglePlayback: { model.togglePlayback() },
            onStepBackward: { model.stepBackward() },
            onStepForward: { model.stepForward() },
            onToggleAudioMute: { model.toggleMonitorAudioMute() },
            onAudioVolumeChange: { model.setMonitorAudioVolume($0) }
        )
    }
}

private struct TimelineShortcutButtons: View {
    @ObservedObject var model: StudioViewModel
    var isEnabled: Bool

    private var hasSelectedClip: Bool {
        model.selectedTimelineClip != nil
    }

    private var hasPatchConflicts: Bool {
        !model.feedbackSession.detectConflicts().isEmpty
    }

    var body: some View {
        VStack {
            Button("Approve Selected Clip") {
                model.approveSelectedTimelineClip()
            }
            .keyboardShortcut("a", modifiers: [])
            .disabled(!isEnabled || !hasSelectedClip)

            Button("Reject Selected Clip") {
                model.rejectSelectedTimelineClip()
            }
            .keyboardShortcut("x", modifiers: [])
            .disabled(!isEnabled || !hasSelectedClip)

            Button("Open Swap Browser") {
                model.openSwapBrowserForSelectedClip()
            }
            .keyboardShortcut("s", modifiers: [])
            .disabled(!isEnabled || !hasSelectedClip)

            Button("Apply Pending Patch") {
                model.applyStudioPatch()
            }
            .keyboardShortcut(.return, modifiers: [.command])
            .disabled(!isEnabled || !model.feedbackSession.isDirty || hasPatchConflicts || model.isCompilingRoughCut)

            Button("Undo Last Studio Patch") {
                model.undoLastPatch()
            }
            .keyboardShortcut("z", modifiers: [.command])
            .disabled(!isEnabled || model.feedbackSession.patchHistory.isEmpty)
        }
        .frame(width: 0, height: 0)
        .clipped()
        .opacity(0)
        .accessibilityHidden(true)
    }
}
