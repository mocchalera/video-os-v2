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
                model: model,
                onOpenCommandPalette: {
                    commandPaletteQuery = ""
                    isCommandPalettePresented = true
                }
            )

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
                ProgressView("候補を読み込んでいます...")
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
                ProgressView("プロジェクトを読み込んでいます...")
                    .frame(width: 360, height: 180)
            }
        }
        .sheet(isPresented: $model.isCaptionFinishingPresented) {
            if let project = model.selectedProject {
                CaptionFinishingView(
                    projectURL: project.path,
                    repositoryRoot: model.repositoryRoot,
                    onRevealInTimeline: { frame in
                        model.isCaptionFinishingPresented = false
                        model.scrubPlayhead(to: frame)
                    }
                )
            } else {
                ProgressView("プロジェクトを読み込んでいます...")
                    .frame(width: 360, height: 180)
            }
        }
        .sheet(isPresented: $model.isBGMReviewPresented) {
            if let project = model.selectedProject {
                BGMReviewView(
                    projectURL: project.path,
                    repositoryRoot: model.repositoryRoot
                )
            } else {
                ProgressView("プロジェクトを読み込んでいます...")
                    .frame(width: 360, height: 180)
            }
        }
        .sheet(isPresented: $model.isEditorialPreferenceMemoryPresented) {
            EditorialPreferenceMemoryView(
                model: model,
                isPresented: $model.isEditorialPreferenceMemoryPresented
            )
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
            panel.title = "コマンド検索"
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

private struct StudioTopBar: View {
    @ObservedObject var model: StudioViewModel
    var onOpenCommandPalette: () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            topBarContent {
                productRoutePicker(maxWidth: 720)
            }
            topBarContent {
                productRoutePicker(maxWidth: 420)
            }
            topBarContent {
                productRouteMenu
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
            projectMenu

            Divider()
                .frame(height: 24)

            Label("制作ルート", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .labelStyle(.titleAndIcon)
                .accessibilityLabel("制作ルート")

            surfaceControl()

            Label("\(model.selectedProductStage.rawValue) / \(model.selectedSurface.rawValue)", systemImage: model.selectedProductStage.systemImage)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(model.selectedSurface.summaryText)
                .accessibilityIdentifier("SelectedSurfaceSummary")

            Text("interview-highlight")
                .font(.caption2.monospaced().weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.quaternary.opacity(0.7), in: Capsule())
                .help("標準製品プロファイル: インタビュー・セミナー・イベント収録から60〜180秒のハイライト")
                .accessibilityLabel("標準プロファイル interview-highlight")
                .accessibilityIdentifier("SpeechLedProductProfileBadge")

            Spacer(minLength: 12)

            Button(action: onOpenCommandPalette) {
                Label("コマンド検索", systemImage: "command")
                    .labelStyle(.iconOnly)
                    .frame(width: 30, height: 28)
                    .contentShape(Rectangle())
            }
            .keyboardShortcut("k", modifiers: [.command])
            .accessibilityLabel("コマンドを検索")
            .accessibilityIdentifier("CommandPaletteButton")
            .help("コマンドを検索")

            Button(action: { model.isCaptionFinishingPresented = true }) {
                Label("字幕仕上げ", systemImage: "captions.bubble")
                    .labelStyle(.iconOnly)
                    .frame(width: 30, height: 28)
                    .contentShape(Rectangle())
            }
            .disabled(model.selectedProject == nil)
            .accessibilityLabel("字幕仕上げを開く")
            .accessibilityIdentifier("CaptionFinishingButton")
            .help("字幕の本文、改行、確認状態をリスク順に仕上げます")

            Button(action: { model.isBGMReviewPresented = true }) {
                Label("BGM試聴・レビュー", systemImage: "music.note.list")
                    .labelStyle(.iconOnly)
                    .frame(width: 30, height: 28)
                    .contentShape(Rectangle())
            }
            .disabled(model.selectedProject == nil)
            .accessibilityLabel("BGM試聴・レビューを開く")
            .accessibilityIdentifier("BGMReviewButton")
            .help("生成BGM候補を会話と重ねて試聴し、音楽・品質・独自性・権利をレビューします")

            Button(action: { model.refresh() }) {
                Label("プロジェクトを更新", systemImage: "arrow.clockwise")
                    .labelStyle(.iconOnly)
                    .frame(width: 30, height: 28)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("プロジェクトを更新")
            .accessibilityIdentifier("RefreshProjectsButton")
            .help("プロジェクトを更新")
        }
    }

    private func productRoutePicker(maxWidth: CGFloat) -> some View {
        Picker("制作ルート", selection: Binding(
            get: { model.selectedProductStage },
            set: { model.selectProductStage($0) }
        )) {
            ForEach(StudioProductStage.allCases) { stage in
                Text(stage.rawValue).tag(stage)
            }
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .frame(maxWidth: maxWidth)
        .help("Brief → Sources → Story → Cut → Review → Export。ViewerとTimelineは常に編集可能です")
        .accessibilityIdentifier("SpeechLedProductRoutePicker")
    }

    private var productRouteMenu: some View {
        Menu {
            ForEach(StudioProductStage.allCases) { stage in
                Button {
                    model.selectProductStage(stage)
                } label: {
                    Label(
                        "\(stage.rawValue) / \(stage.localizedTitle)",
                        systemImage: stage == model.selectedProductStage ? "checkmark" : stage.systemImage
                    )
                }
            }
        } label: {
            Label("\(model.selectedProductStage.rawValue) / \(model.selectedProductStage.localizedTitle)", systemImage: model.selectedProductStage.systemImage)
                .lineLimit(1)
        }
        .help("speech-led制作ルートを切り替えます。ViewerとTimelineは固定です")
    }

    private var projectMenu: some View {
        Menu {
            Button {
                model.chooseAndInitializeProject()
            } label: {
                Label(model.isInitializingProject ? "作成中" : "新規プロジェクト", systemImage: "folder.badge.plus")
            }
            .disabled(model.isInitializingProject)

            Button {
                model.refresh()
            } label: {
                Label("プロジェクトを更新", systemImage: "arrow.clockwise")
            }

            Divider()

            if model.projects.isEmpty {
                Text("プロジェクトがありません")
            } else {
                ForEach(model.projects) { project in
                    Button {
                        model.selectProject(project.id)
                    } label: {
                        Label(
                            "\(project.name) / \(project.stateLabel)",
                            systemImage: project.id == model.selectedProjectID ? "checkmark.circle.fill" : "folder"
                        )
                    }
                    .accessibilityIdentifier("ProjectMenu.\(project.id)")
                }
            }
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.selectedProject?.name ?? "プロジェクト未選択")
                        .lineLimit(1)
                    Text(model.selectedProject?.stateLabel ?? "選択してください")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } icon: {
                Image(systemName: model.selectedProject?.hasTimeline == true ? "timeline.selection" : "folder")
            }
            .frame(maxWidth: 260, alignment: .leading)
        }
        .accessibilityIdentifier("ProjectMenuButton")
        .help("プロジェクトを切り替え")
    }
}

extension StudioAgentSurface {
    var summaryText: String {
        switch self {
        case .ingest:
            return "右パネル: 素材 / 素材リンク、解析、検索インデックスを準備"
        case .intent:
            return "右パネル: プロジェクト / 目的、対象、避けることを確認"
        case .triage:
            return "右パネル: 素材 / 使える候補と不足素材を絞り込み"
        case .blueprint:
            return "右パネル: プロジェクト / ビート構成と尺配分を設計"
        case .compile:
            return "右パネル: プロジェクト / timeline.jsonを生成しプレビュー差分を確認"
        case .review:
            return "右パネル: QA / 粗編集の問題を検出して修正候補を作成"
        case .package:
            return "右パネル: プロジェクト / 最終動画、Premiere XML、編集者パケットを書き出し"
        }
    }

    var inspectorPanelLabel: String {
        switch self {
        case .ingest, .triage:
            return "素材"
        case .intent, .blueprint, .compile, .package:
            return "プロジェクト"
        case .review:
            return "QA"
        }
    }

    var systemImage: String {
        switch self {
        case .ingest:
            return "waveform.and.magnifyingglass"
        case .intent:
            return "target"
        case .triage:
            return "line.3.horizontal.decrease.circle"
        case .blueprint:
            return "rectangle.3.group"
        case .compile:
            return "timeline.selection"
        case .review:
            return "checkmark.diamond"
        case .package:
            return "shippingbox"
        }
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
                TextField("コマンドを検索", text: $query)
                    .textFieldStyle(.plain)
                    .focused($searchFocused)
                    .accessibilityLabel("コマンドを検索")
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
                .accessibilityLabel("コマンドパレットを閉じる")
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
                                    Text(item.disabledReason ?? "利用できません")
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
                    ContentUnavailableView("該当するコマンドがありません", systemImage: "magnifyingglass", description: Text("別のキーワードで検索してください。"))
                }
            }
        }
        .padding(18)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("コマンドパレット")
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
                subtitle: "プロジェクト一覧、成果物の状態、準備状況を更新します。",
                isEnabled: true,
                perform: { model.refresh() }
            ),
            StudioCommandPaletteItem(
                command: .newProjectFromSource,
                subtitle: "テンプレートからプロジェクトを作成し、素材フォルダをリンクします。",
                isEnabled: !model.isInitializingProject,
                disabledReason: model.isInitializingProject ? "作成中" : nil,
                perform: { model.chooseAndInitializeProject() }
            ),
            StudioCommandPaletteItem(
                command: .checkCodexAppServer,
                subtitle: "Codexランタイムとの接続を確認します。",
                isEnabled: availability.isEnabled(.checkCodexAppServer),
                disabledReason: availability.disabledReason(for: .checkCodexAppServer),
                perform: { model.checkAppServer() }
            ),
            StudioCommandPaletteItem(
                command: .startAgentSession,
                subtitle: "選択中プロジェクト用のCodexセッションを開始します。",
                isEnabled: availability.isEnabled(.startAgentSession),
                disabledReason: availability.disabledReason(for: .startAgentSession),
                perform: { model.startAgentSession() }
            ),
            StudioCommandPaletteItem(
                command: .stopAgentSession,
                subtitle: "現在のCodexセッションを停止します。",
                isEnabled: availability.isEnabled(.stopAgentSession),
                disabledReason: availability.disabledReason(for: .stopAgentSession),
                perform: { model.stopAgentSession() }
            ),
            StudioCommandPaletteItem(
                command: .runSelectedAgentJob,
                subtitle: "選択したCodexジョブを実行します。書き込みがある場合は承認画面を開きます。",
                isEnabled: availability.isEnabled(.runSelectedAgentJob),
                disabledReason: availability.disabledReason(for: .runSelectedAgentJob),
                perform: { model.runSelectedJob() }
            ),
            StudioCommandPaletteItem(
                command: .runReadOnlyAgentTurn,
                subtitle: "自由入力プロンプトを読み取り専用で実行します。",
                isEnabled: availability.isEnabled(.runReadOnlyAgentTurn),
                disabledReason: availability.disabledReason(for: .runReadOnlyAgentTurn),
                perform: { model.runAgentTurn() }
            ),
            StudioCommandPaletteItem(
                command: .prepareTimelineAgentPrompt,
                subtitle: "\(model.timelineAgentSelectionLabel) の相談プロンプトだけを準備します。実行やタイムライン変更はしません。",
                isEnabled: model.canPrepareTimelineAgentPrompt,
                disabledReason: timelineAgentPromptOnlyDisabledReason,
                perform: { model.prepareTimelineSelectionAgentPrompt() }
            ),
            StudioCommandPaletteItem(
                command: .runAgentTightenSelection,
                subtitle: "\(model.timelineAgentSelectionLabel) を短く整える読み取り専用相談を準備し、Agentセッションがあれば実行します。",
                isEnabled: model.canPrepareTimelineAgentPrompt && model.appServerStatus != .checking,
                disabledReason: timelineAgentConsultationDisabledReason,
                perform: { model.prepareAndRunTimelineSelectionAgentPrompt(intent: .tightenSelection) }
            ),
            StudioCommandPaletteItem(
                command: .runAgentShortenBeat,
                subtitle: "\(model.timelineAgentSelectionLabel) をより短いビートにする読み取り専用相談を準備し、Agentセッションがあれば実行します。",
                isEnabled: model.canPrepareTimelineAgentPrompt && model.appServerStatus != .checking,
                disabledReason: timelineAgentConsultationDisabledReason,
                perform: { model.prepareAndRunTimelineSelectionAgentPrompt(intent: .shortenBeat) }
            ),
            StudioCommandPaletteItem(
                command: .runAgentFindStrongerAlternate,
                subtitle: "\(model.timelineAgentSelectionLabel) に対して強い代替素材や差し替え根拠を探す読み取り専用相談を準備します。",
                isEnabled: model.canPrepareTimelineAgentPrompt && model.appServerStatus != .checking,
                disabledReason: timelineAgentConsultationDisabledReason,
                perform: { model.prepareAndRunTimelineSelectionAgentPrompt(intent: .findStrongerAlternate) }
            ),
            StudioCommandPaletteItem(
                command: .runAgentExplainCut,
                subtitle: "\(model.timelineAgentSelectionLabel) のカットが効く/弱い理由を説明する読み取り専用相談を準備します。",
                isEnabled: model.canPrepareTimelineAgentPrompt && model.appServerStatus != .checking,
                disabledReason: timelineAgentConsultationDisabledReason,
                perform: { model.prepareAndRunTimelineSelectionAgentPrompt(intent: .explainCut) }
            ),
            StudioCommandPaletteItem(
                command: .approvePendingAgentJob,
                subtitle: "保留中の書き込みジョブを承認します。",
                isEnabled: availability.isEnabled(.approvePendingAgentJob),
                disabledReason: availability.disabledReason(for: .approvePendingAgentJob),
                perform: { model.approvePendingJob() }
            ),
            StudioCommandPaletteItem(
                command: .runSourceAnalysis,
                subtitle: model.analysisRunStatus,
                isEnabled: hasProject && !model.isRunningAnalysis && model.analysisRunPlan.canRun,
                disabledReason: hasProject ? localizedStudioLabel(model.analysisRunPlan.readinessLabel) : "プロジェクト未選択",
                perform: { model.runSelectedProjectAnalysis() }
            ),
            StudioCommandPaletteItem(
                command: .compileRoughCut,
                subtitle: model.roughCutCompileStatus,
                isEnabled: hasProject && !model.isCompilingRoughCut && model.roughCutCompilePlan.canRun,
                disabledReason: hasProject ? localizedStudioLabel(model.roughCutCompilePlan.readinessLabel) : "プロジェクト未選択",
                perform: { model.compileSelectedProjectRoughCut() }
            ),
            StudioCommandPaletteItem(
                command: .applyReviewPatch,
                subtitle: "review_patch.jsonを確定的なコンパイラで反映します。",
                isEnabled: hasProject && !model.isCompilingRoughCut,
                disabledReason: hasProject ? nil : "プロジェクト未選択",
                perform: { model.compileSelectedProjectWithReviewPatch() }
            ),
            StudioCommandPaletteItem(
                command: .openSwapBrowser,
                subtitle: "選択中クリップの現在カットと代替候補を比較します。",
                isEnabled: availability.isEnabled(.openSwapBrowser),
                disabledReason: availability.disabledReason(for: .openSwapBrowser),
                perform: { model.openSwapBrowserForSelectedClip() }
            ),
            StudioCommandPaletteItem(
                command: .searchFootage,
                subtitle: "テキスト、画像、音声、ハイブリッド検索で差し替え素材を探します。",
                isEnabled: availability.isEnabled(.searchFootage),
                disabledReason: availability.disabledReason(for: .searchFootage),
                perform: { model.openFootageSearch() }
            ),
            StudioCommandPaletteItem(
                command: .rebuildSearchIndex,
                subtitle: "素材/RAG用のSQLiteインデックスを再構築します。",
                isEnabled: hasProject,
                disabledReason: hasProject ? nil : "プロジェクト未選択",
                perform: { model.rebuildSelectedProjectIndex() }
            ),
            StudioCommandPaletteItem(
                command: .runMarlinEvaluation,
                subtitle: model.marlinEvaluationRunStatus,
                isEnabled: hasProject && !model.isRunningMarlinEvaluation && model.marlinEvaluationRunPlan.canRun,
                disabledReason: hasProject ? localizedStudioLabel(model.marlinEvaluationRunPlan.readinessLabel) : "プロジェクト未選択",
                perform: { model.runSelectedProjectMarlinEvaluation() }
            ),
            StudioCommandPaletteItem(
                command: .buildAudioStoryGraph,
                subtitle: model.audioStoryGraphRunStatus,
                isEnabled: hasProject && !model.isBuildingAudioStoryGraph && model.audioStoryGraphRunPlan.canRun,
                disabledReason: hasProject ? localizedStudioLabel(model.audioStoryGraphRunPlan.readinessLabel) : "プロジェクト未選択",
                perform: { model.buildSelectedProjectAudioStoryGraph() }
            ),
            StudioCommandPaletteItem(
                command: .openBGMReview,
                subtitle: "生成BGM候補を会話と重ねて試聴し、5つの独立ゲートを保存します。",
                isEnabled: hasProject,
                disabledReason: hasProject ? nil : "プロジェクト未選択",
                perform: { model.isBGMReviewPresented = true }
            ),
            StudioCommandPaletteItem(
                command: .buildPreviewProxies,
                subtitle: model.mediaProxyOperationStatus,
                isEnabled: hasProject && !model.isBuildingMediaProxies && model.mediaProxyPlan.pendingCount > 0,
                disabledReason: hasProject ? "作成待ちのプロキシはありません" : "プロジェクト未選択",
                perform: { model.buildSelectedProjectMediaProxies() }
            ),
            StudioCommandPaletteItem(
                command: .relinkMissingMedia,
                subtitle: model.mediaRelinkStatus,
                isEnabled: hasProject && !model.isRelinkingMedia,
                disabledReason: hasProject ? nil : "プロジェクト未選択",
                perform: { model.chooseAndRelinkSelectedProjectMedia() }
            ),
            StudioCommandPaletteItem(
                command: .exportPremiereXML,
                subtitle: model.handoffExportStatus,
                isEnabled: hasProject && !model.isExportingPremiereXML && (model.handoffExportPlan?.canExportPremiereXML ?? false),
                disabledReason: hasProject ? model.handoffExportPlan.map { localizedStudioLabel($0.readinessLabel) } : "プロジェクト未選択",
                perform: { model.exportSelectedProjectPremiereXML() }
            ),
            StudioCommandPaletteItem(
                command: .exportEditorPacket,
                subtitle: model.editorPacketStatus,
                isEnabled: hasProject && !model.isExportingEditorPacket && (model.editorPacketPlan?.canExportPacket ?? false),
                disabledReason: hasProject ? model.editorPacketPlan.map { localizedStudioLabel($0.readinessLabel) } : "プロジェクト未選択",
                perform: { model.exportSelectedProjectEditorPacket() }
            ),
            StudioCommandPaletteItem(
                command: .renderFinalPackage,
                subtitle: model.renderRunStatus,
                isEnabled: hasProject && !model.isRunningRender && model.renderRunPlan.canRun,
                disabledReason: hasProject ? localizedStudioLabel(model.renderRunPlan.readinessLabel) : "プロジェクト未選択",
                perform: { model.runSelectedProjectRender() }
            ),
            StudioCommandPaletteItem(
                command: .promoFinish,
                subtitle: model.promoFinishRunStatus,
                isEnabled: hasProject && !model.isRunningPromoFinish && model.promoFinishRunPlan.canRun,
                disabledReason: hasProject ? localizedStudioLabel(model.promoFinishRunPlan.readinessLabel) : "プロジェクト未選択",
                perform: { model.runSelectedProjectPromoFinish() }
            ),
            StudioCommandPaletteItem(
                command: .runStudioAcceptanceSmoke,
                subtitle: model.studioAcceptanceSmokeStatus,
                isEnabled: !model.isRunningStudioAcceptanceSmoke,
                disabledReason: "実行中",
                perform: { model.runStudioAcceptanceSmoke() }
            ),
            StudioCommandPaletteItem(
                command: .playTimeline,
                isPlaying: model.isPlaying,
                subtitle: model.timelineStatus,
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.togglePlayback() }
            ),
            StudioCommandPaletteItem(
                command: .playTimelineReverse,
                subtitle: "Jキー。TimelineまたはSource Monitor focus中に逆方向再生します。押すたび1x/2x/4xで切り替わります。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.playReverseShuttle() }
            ),
            StudioCommandPaletteItem(
                command: .pauseTimeline,
                subtitle: "Kキー。TimelineまたはSource Monitor focus中の再生を停止します。",
                isEnabled: model.timeline != nil && model.isPlaying,
                disabledReason: model.timeline == nil ? "タイムラインがありません" : "再生中ではありません",
                perform: { model.pausePlayback() }
            ),
            StudioCommandPaletteItem(
                command: .stepTimelineBackward,
                subtitle: ",キー。TimelineまたはSource Monitor focus中の現在位置を1フレーム戻します。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.stepBackward() }
            ),
            StudioCommandPaletteItem(
                command: .stepTimelineForward,
                subtitle: ".キー。TimelineまたはSource Monitor focus中の現在位置を1フレーム進めます。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.stepForward() }
            ),
            StudioCommandPaletteItem(
                command: .jumpToPreviousTimelineEditPoint,
                subtitle: "Up Arrow。前の編集点、マーカー、タイムライン境界へViewerごと移動します。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.jumpToPreviousTimelineEditPoint() }
            ),
            StudioCommandPaletteItem(
                command: .jumpToNextTimelineEditPoint,
                subtitle: "Down Arrow。次の編集点、マーカー、タイムライン境界へViewerごと移動します。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.jumpToNextTimelineEditPoint() }
            ),
            StudioCommandPaletteItem(
                command: .markSourceMonitorInAtPlaybackTime,
                subtitle: "ソースモニターの現在位置をINとしてマークします。Source Monitor focus時はIキー。",
                isEnabled: model.canMarkSourceMonitorInAtPlaybackTime,
                disabledReason: model.sourceMonitorMediaReference == nil
                    ? "ソースモニターに素材がありません"
                    : "現在位置を取得できていません",
                perform: { model.markSourceMonitorInAtPlaybackTime() }
            ),
            StudioCommandPaletteItem(
                command: .markSourceMonitorOutAtPlaybackTime,
                subtitle: "ソースモニターの現在位置をOUTとしてマークします。Source Monitor focus時はOキー。",
                isEnabled: model.canMarkSourceMonitorOutAtPlaybackTime,
                disabledReason: model.sourceMonitorMediaReference == nil
                    ? "ソースモニターに素材がありません"
                    : "現在位置を取得できていません",
                perform: { model.markSourceMonitorOutAtPlaybackTime() }
            ),
            StudioCommandPaletteItem(
                command: .nudgeSourceMonitorMarkInEarlier,
                subtitle: "Option-[。表示中ソース候補のINを0.5秒前へ戻します。追加/ドラッグ/上書き/置換時はマーク範囲を使います。",
                isEnabled: model.canNudgeSourceMonitorMarkInEarlier,
                disabledReason: sourceMonitorRangeNudgeDisabledReason(boundary: "INをこれ以上前へ戻せません"),
                perform: { model.nudgeSourceMonitorMarkIn(by: -500_000) }
            ),
            StudioCommandPaletteItem(
                command: .nudgeSourceMonitorMarkInLater,
                subtitle: "Option-]。表示中ソース候補のINを0.5秒後ろへ送ります。追加/ドラッグ/上書き/置換時はマーク範囲を使います。",
                isEnabled: model.canNudgeSourceMonitorMarkInLater,
                disabledReason: sourceMonitorRangeNudgeDisabledReason(boundary: "INをこれ以上後ろへ送れません"),
                perform: { model.nudgeSourceMonitorMarkIn(by: 500_000) }
            ),
            StudioCommandPaletteItem(
                command: .nudgeSourceMonitorMarkOutEarlier,
                subtitle: "Shift-Option-[。表示中ソース候補のOUTを0.5秒前へ詰めます。追加/ドラッグ/上書き/置換時はマーク範囲を使います。",
                isEnabled: model.canNudgeSourceMonitorMarkOutEarlier,
                disabledReason: sourceMonitorRangeNudgeDisabledReason(boundary: "OUTをこれ以上前へ詰められません"),
                perform: { model.nudgeSourceMonitorMarkOut(by: -500_000) }
            ),
            StudioCommandPaletteItem(
                command: .nudgeSourceMonitorMarkOutLater,
                subtitle: "Shift-Option-]。表示中ソース候補のOUTを0.5秒後ろへ伸ばします。追加/ドラッグ/上書き/置換時はマーク範囲を使います。",
                isEnabled: model.canNudgeSourceMonitorMarkOutLater,
                disabledReason: sourceMonitorRangeNudgeDisabledReason(boundary: "OUTをこれ以上後ろへ伸ばせません"),
                perform: { model.nudgeSourceMonitorMarkOut(by: 500_000) }
            ),
            StudioCommandPaletteItem(
                command: .resetSourceMonitorMarkedRange,
                subtitle: "Shift-R。表示中ソース候補のIN/OUTマークを候補全体へ戻します。",
                isEnabled: model.canResetSourceMonitorMarkedRange,
                disabledReason: model.sourceMonitorMediaReference == nil
                    ? "ソースモニターに素材がありません"
                    : "リセットするマーク範囲がありません",
                perform: { model.resetSourceMonitorMarkedRange() }
            ),
            StudioCommandPaletteItem(
                command: .selectPreviousSourceMonitorCandidate,
                subtitle: "Source Monitor focus時は [ キー。表示中の素材で前のselect候補へ移動します。",
                isEnabled: model.canSelectPreviousSourceMonitorCandidate,
                disabledReason: model.sourceMonitorMediaReference == nil
                    ? "ソースモニターに素材がありません"
                    : "前のselect候補がありません",
                perform: { model.selectPreviousSourceMonitorCandidate() }
            ),
            StudioCommandPaletteItem(
                command: .selectNextSourceMonitorCandidate,
                subtitle: "Source Monitor focus時は ] キー。表示中の素材で次のselect候補へ移動します。",
                isEnabled: model.canSelectNextSourceMonitorCandidate,
                disabledReason: model.sourceMonitorMediaReference == nil
                    ? "ソースモニターに素材がありません"
                    : "次のselect候補がありません",
                perform: { model.selectNextSourceMonitorCandidate() }
            ),
            StudioCommandPaletteItem(
                command: .insertSourceMonitorAtPlayhead,
                subtitle: "Source Monitor focus時はWキー。表示中の候補とIN/OUT範囲を再生位置へ追加し、TimelineとViewerへ即時反映します。",
                isEnabled: model.canInsertSourceMonitorAtPlayhead,
                disabledReason: model.sourceMonitorMediaReference == nil
                    ? "ソースモニターに素材がありません"
                    : model.sourceMonitorInsertHelp,
                perform: { model.insertSourceMonitorAtPlayhead() }
            ),
            StudioCommandPaletteItem(
                command: .appendSourceMonitorToTimelineEnd,
                subtitle: "Source Monitor focus時はEキー。表示中の候補とIN/OUT範囲をタイムライン末尾へ追加します。",
                isEnabled: model.canAppendSourceMonitorToTimelineEnd,
                disabledReason: model.sourceMonitorMediaReference == nil
                    ? "ソースモニターに素材がありません"
                    : model.sourceMonitorAppendHelp,
                perform: { model.appendSourceMonitorToTimelineEnd() }
            ),
            StudioCommandPaletteItem(
                command: .overwriteSourceMonitorAtPlayhead,
                subtitle: "Source Monitor focus時はDキー。表示中の候補とIN/OUT範囲で再生位置から上書きします。",
                isEnabled: model.canOverwriteSourceMonitorAtPlayhead,
                disabledReason: model.sourceMonitorMediaReference == nil
                    ? "ソースモニターに素材がありません"
                    : model.sourceMonitorOverwriteHelp,
                perform: { model.overwriteSourceMonitorAtPlayhead() }
            ),
            StudioCommandPaletteItem(
                command: .replaceSelectedClipWithSourceMonitor,
                subtitle: "Source Monitor focus時はRキー。選択中クリップを表示中のソース候補で置換します。",
                isEnabled: model.canReplaceSelectedClipWithSourceMonitorCandidate,
                disabledReason: model.sourceMonitorMediaReference == nil
                    ? "ソースモニターに素材がありません"
                    : model.sourceMonitorReplaceHelp,
                perform: { model.replaceSelectedClipWithSourceMonitorCandidate() }
            ),
            StudioCommandPaletteItem(
                command: .revealSelectedClipInSourceMonitor,
                subtitle: "タイムライン選択clipの元素材をSource Monitorへ開きます。タイムラインフォーカス時はFキー。",
                isEnabled: model.canRevealSelectedTimelineClipInSourceMonitor,
                disabledReason: model.selectedTimelineClip == nil
                    ? "タイムラインクリップを選択してください"
                    : "選択clipの素材はソースモニターで再生できません",
                perform: { model.revealSelectedTimelineClipInSourceMonitor() }
            ),
            StudioCommandPaletteItem(
                command: .setLoopRangeToSelection,
                subtitle: "選択clip範囲または選択transition周辺をループ範囲にします。タイムラインフォーカス時はRキー。",
                isEnabled: model.timeline != nil && model.canSetLoopPlaybackRangeToSelection,
                disabledReason: model.timeline == nil ? "タイムラインがありません" : "ループ範囲にする選択がありません",
                perform: { model.setLoopPlaybackRangeToSelectedClip() }
            ),
            StudioCommandPaletteItem(
                command: .toggleLoopPlayback,
                subtitle: model.playbackLoopLabel ?? "ループ範囲がない場合は現在の選択から設定します。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.toggleLoopPlayback() }
            ),
            StudioCommandPaletteItem(
                command: .clearLoopRange,
                subtitle: model.playbackLoopLabel ?? "ループ範囲は未設定です。",
                isEnabled: model.timeline != nil && model.playbackLoopRange != nil,
                disabledReason: model.timeline == nil ? "タイムラインがありません" : "ループ範囲がありません",
                perform: { model.clearLoopPlaybackRange() }
            ),
            StudioCommandPaletteItem(
                command: .selectAllTimelineClips,
                subtitle: "Command-A。タイムライン上の全クリップを複数選択します。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.selectAllTimelineClips() }
            ),
            StudioCommandPaletteItem(
                command: .clearTimelineSelection,
                subtitle: "Esc。選択、トランジション選択、Blade/Multi-selectの一時状態を解除します。",
                isEnabled: model.timeline != nil && model.hasTimelineSelectionOrTemporaryTool,
                disabledReason: model.timeline == nil ? "タイムラインがありません" : "解除する選択がありません",
                perform: { model.clearTimelineSelectionAndTemporaryTools() }
            ),
            StudioCommandPaletteItem(
                command: .selectPreviousTimelineClip,
                subtitle: "Left Arrow。現在の選択トラックで前のクリップへ移動し、Viewerをその先頭へ同期します。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.selectPreviousTimelineClip() }
            ),
            StudioCommandPaletteItem(
                command: .selectNextTimelineClip,
                subtitle: "Right Arrow。現在の選択トラックで次のクリップへ移動し、Viewerをその先頭へ同期します。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.selectNextTimelineClip() }
            ),
            StudioCommandPaletteItem(
                command: .extendTimelineSelectionPrevious,
                subtitle: "Shift-Left Arrow。現在の選択から前の隣接クリップまで範囲選択を拡張します。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.extendTimelineSelectionPrevious() }
            ),
            StudioCommandPaletteItem(
                command: .extendTimelineSelectionNext,
                subtitle: "Shift-Right Arrow。現在の選択から次の隣接クリップまで範囲選択を拡張します。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.extendTimelineSelectionNext() }
            ),
            StudioCommandPaletteItem(
                command: .deleteTimelineSelection,
                subtitle: "Deleteキー。同一トラックまたは同じ時間範囲の複数トラックclipはリップル削除し、その他の複数トラック選択は空きを保持して削除、transitionはcutへ戻します。",
                isEnabled: model.timeline != nil && model.canDeleteTimelineSelection,
                disabledReason: model.timeline == nil
                    ? "タイムラインがありません"
                    : "削除する選択項目がありません",
                perform: { model.deleteTimelineSelection() }
            ),
            StudioCommandPaletteItem(
                command: .applyDefaultCrossfadeTransition,
                subtitle: "Command-T。選択中または再生位置近くの映像編集点へクロスフェードを適用し、TimelineとViewerへ即時反映します。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.applyTransitionPresetNearContext(TimelineTransitionPreset.defaultPreset.id) }
            ),
            StudioCommandPaletteItem(
                command: .shortenSelectedTransition,
                subtitle: "Shift-[。選択中のトランジションを0.5秒短くし、TimelineとViewerへ即時反映します。",
                isEnabled: model.timeline != nil && model.canShortenSelectedTimelineTransitionDuration,
                disabledReason: model.timeline == nil
                    ? "タイムラインがありません"
                    : "トランジションを選択するか、これ以上短くできる編集点を選んでください",
                perform: { model.shortenSelectedTimelineTransitionDuration() }
            ),
            StudioCommandPaletteItem(
                command: .lengthenSelectedTransition,
                subtitle: "Shift-]。選択中のトランジションを0.5秒長くし、TimelineとViewerへ即時反映します。",
                isEnabled: model.timeline != nil && model.canLengthenSelectedTimelineTransitionDuration,
                disabledReason: model.timeline == nil
                    ? "タイムラインがありません"
                    : "トランジションを選択するか、これ以上長くできる編集点を選んでください",
                perform: { model.lengthenSelectedTimelineTransitionDuration() }
            ),
            StudioCommandPaletteItem(
                command: .trimTimelineClipStartToPlayhead,
                subtitle: "Qキー。選択クリップの先頭を再生位置まで詰め、タイムラインとViewerへ即時反映します。",
                isEnabled: model.timeline != nil && model.canTrimSelectedTimelineClipStartToPlayhead,
                disabledReason: model.timeline == nil
                    ? "タイムラインがありません"
                    : "クリップを1つ選択し、再生位置をそのクリップの内側へ移動してください",
                perform: { model.trimSelectedTimelineClipStartToPlayhead() }
            ),
            StudioCommandPaletteItem(
                command: .trimTimelineClipEndToPlayhead,
                subtitle: "Wキー。選択クリップの末尾を再生位置まで詰め、タイムラインとViewerへ即時反映します。",
                isEnabled: model.timeline != nil && model.canTrimSelectedTimelineClipEndToPlayhead,
                disabledReason: model.timeline == nil
                    ? "タイムラインがありません"
                    : "クリップを1つ選択し、再生位置をそのクリップの内側へ移動してください",
                perform: { model.trimSelectedTimelineClipEndToPlayhead() }
            ),
            StudioCommandPaletteItem(
                command: .zoomTimelineOut,
                subtitle: "タイムライン表示を縮小します。タイムラインフォーカス時は - キー。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.zoomTimelineOut() }
            ),
            StudioCommandPaletteItem(
                command: .zoomTimelineIn,
                subtitle: "タイムライン表示を拡大します。タイムラインフォーカス時は = キー。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.zoomTimelineIn() }
            ),
            StudioCommandPaletteItem(
                command: .fitTimelineToWindow,
                subtitle: "シーケンス全体をタイムライン幅に収めます。現在: \(model.timelineZoomLabel)。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.fitTimelineToWindow() }
            ),
            StudioCommandPaletteItem(
                command: .resetTimelineZoom,
                subtitle: "タイムライン表示倍率を100%へ戻します。現在: \(model.timelineZoomLabel)。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.resetTimelineZoom() }
            ),
            StudioCommandPaletteItem(
                command: .toggleTimelineSnapping,
                subtitle: model.isTimelineSnappingEnabled
                    ? "Nキー。現在オンです。ドラッグとスクラブは近い編集点へ吸着します。"
                    : "Nキー。現在オフです。ドラッグとスクラブはカーソル位置を優先します。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.toggleTimelineSnapping() }
            ),
            StudioCommandPaletteItem(
                command: .toggleTimelineBladeMode,
                subtitle: model.isTimelineBladeModeEnabled
                    ? "Bキー。現在オンです。クリック位置でクリップを分割します。"
                    : "Bキー。オンにするとタイムライン上のクリップをクリック位置で分割できます。",
                isEnabled: model.timeline != nil,
                disabledReason: "タイムラインがありません",
                perform: { model.toggleTimelineBladeMode() }
            )
        ]
    }

    private var timelineAgentConsultationDisabledReason: String {
        if model.appServerStatus == .checking {
            return "Agent接続を確認中です"
        }
        return timelineAgentPromptOnlyDisabledReason
    }

    private var timelineAgentPromptOnlyDisabledReason: String {
        if model.selectedProject == nil {
            return "プロジェクト未選択"
        }
        if model.timeline == nil {
            return "タイムラインがありません"
        }
        return "タイムラインのクリップまたはトランジションを選択してください"
    }

    private func sourceMonitorRangeNudgeDisabledReason(boundary: String) -> String {
        if model.sourceMonitorMediaReference == nil {
            return "ソースモニターに素材がありません"
        }
        if model.sourceMonitorInsertCandidateSummary == nil {
            return "調整できるselect候補がありません"
        }
        return boundary
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
        self.title = command.localizedTitle(isPlaying: isPlaying)
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
    @FocusState private var sourceMonitorFocused: Bool

    var body: some View {
        GeometryReader { proxy in
            workspaceLayout(isCompact: proxy.size.width < 1040, availableHeight: proxy.size.height)
        }
        .onChange(of: model.sourceMonitorAssetID) { _, assetID in
            sourceMonitorFocused = assetID != nil
            if assetID != nil {
                timelineFocused = false
            }
        }
        .onChange(of: timelineFocused) { _, isFocused in
            if isFocused {
                sourceMonitorFocused = false
            }
        }
        .onChange(of: sourceMonitorFocused) { _, isFocused in
            if isFocused {
                timelineFocused = false
            }
        }
    }

    @ViewBuilder
    private func workspaceLayout(isCompact: Bool, availableHeight: CGFloat) -> some View {
        let feedbackBarHeight: CGFloat = 46
        let dividerBudget: CGFloat = 2
        let minimumTimelineHeight: CGFloat = 220
        let preferredUpperHeight = max(280, min(400, availableHeight * 0.52))
        let upperBudget = max(220, availableHeight - minimumTimelineHeight - feedbackBarHeight - dividerBudget)
        let upperHeight = min(preferredUpperHeight, upperBudget)
        let timelineHeight = max(210, availableHeight - upperHeight - feedbackBarHeight - dividerBudget)

        VStack(spacing: 0) {
            if isCompact {
                let inspectorHeight = min(230, max(150, upperHeight * 0.34))
                let viewerHeight = max(180, upperHeight - inspectorHeight - dividerBudget)
                VStack(spacing: 0) {
                    viewerPanel
                        .frame(height: viewerHeight)
                    Divider()
                    InspectorPanel(model: model)
                        .frame(height: inspectorHeight)
                }
                .frame(height: upperHeight)
            } else {
                HStack(spacing: 0) {
                    viewerPanel
                        .frame(minWidth: 600, maxWidth: .infinity, maxHeight: .infinity)
                    Divider()
                    InspectorPanel(model: model)
                        .frame(minWidth: 300, idealWidth: 340, maxWidth: 360)
                }
                .frame(height: upperHeight)
            }

            Divider()

            TimelinePanel(
                project: model.selectedProject,
                timeline: model.timeline,
                status: model.timelineStatus,
                audioCues: model.timelineAudioCues,
                audioWaveforms: model.timelineAudioWaveforms,
                assetDurationsUSByID: model.timelineAssetDurationsUSByID,
                thumbnailURLByAssetID: model.timelineThumbnailURLByAssetID,
                audioWaveformStatus: model.audioWaveformStatus,
                recentlyChangedClipIDs: model.recentlyChangedClipIDs,
                selectedClip: model.selectedTimelineClip,
                selectedClipCount: model.selectedTimelineClipCount,
                selectedClipIDs: model.selectedTimelineClipIDs,
                sourceOverwritePreview: model.sourceMonitorOverwritePreview,
                playbackLoopRange: model.playbackLoopRange,
                isLoopPlaybackEnabled: model.isLoopPlaybackEnabled,
                isPlaying: model.isPlaying,
                playheadRevealRequest: model.timelinePlayheadRevealRequest,
                timelineSkimPreview: model.timelineSkimPreview,
                timelineZoomLabel: model.timelineZoomLabel,
                timelinePixelsPerFrame: model.timelinePixelsPerFrame,
                isTimelineFitToWindowEnabled: model.isTimelineFitToWindowEnabled,
                timelineTrackDensity: model.timelineTrackDensity,
                isSnappingEnabled: model.isTimelineSnappingEnabled,
                isBladeModeEnabled: model.isTimelineBladeModeEnabled,
                canTrimSelectedClip: model.canTrimSelectedTimelineClip,
                canTrimSelectedClipStartToPlayhead: model.canTrimSelectedTimelineClipStartToPlayhead,
                canTrimSelectedClipEndToPlayhead: model.canTrimSelectedTimelineClipEndToPlayhead,
                canExtendSelectedClipStart: model.canExtendSelectedTimelineClipStart,
                canExtendSelectedClipEnd: model.canExtendSelectedTimelineClipEnd,
                canRollIncomingEditLeft: model.canRollSelectedIncomingEditLeft,
                canRollIncomingEditRight: model.canRollSelectedIncomingEditRight,
                canRollOutgoingEditLeft: model.canRollSelectedOutgoingEditLeft,
                canRollOutgoingEditRight: model.canRollSelectedOutgoingEditRight,
                canSlipSelectedClipLeft: model.canSlipSelectedTimelineClipLeft,
                canSlipSelectedClipRight: model.canSlipSelectedTimelineClipRight,
                canSplitSelectedClipAtPlayhead: model.canSplitSelectedTimelineClipAtPlayhead,
                canDeleteSelection: model.canDeleteTimelineSelection,
                canRippleDeleteSelectedClip: model.canRippleDeleteSelectedTimelineClip,
                canNudgeSelectedClipEarlier: model.canNudgeSelectedTimelineClipEarlier,
                canNudgeSelectedClipLater: model.canNudgeSelectedTimelineClipLater,
                canRemoveSelectedTransition: model.canRemoveSelectedTimelineTransition,
                canShortenSelectedTransition: model.canShortenSelectedTimelineTransitionDuration,
                canLengthenSelectedTransition: model.canLengthenSelectedTimelineTransitionDuration,
                isPatchApplying: model.isCompilingRoughCut && model.roughCutCompileActivity == .studioPatch,
                selectedClipID: $model.selectedTimelineClipID,
                selectedTransitionID: $model.selectedTimelineTransitionID,
                isMultiSelectMode: $model.isTimelineMultiSelectMode,
                playheadFrame: model.playheadFrame,
                onScrubPlayhead: {
                    timelineFocused = true
                    model.scrubPlayhead(to: $0)
                },
                onPreviewTimelineSkim: { frame, trackID, clipID in
                    model.previewTimelineSkim(at: frame, trackID: trackID, clipID: clipID)
                },
                onEndTimelineSkim: {
                    model.clearTimelineSkimPreview()
                },
                onSelectClip: { clipID, extendingSelection in
                    timelineFocused = true
                    model.selectTimelineClip(
                        clipID,
                        extendingSelection: extendingSelection || model.isTimelineMultiSelectMode
                    )
                },
                onSelectClipRange: { trackID, frameRange in
                    timelineFocused = true
                    model.selectTimelineClips(in: trackID, frameRange: frameRange)
                },
                onTimelineZoomChange: {
                    timelineFocused = true
                    model.setTimelinePixelsPerFrame($0)
                },
                onTrackDensityChange: {
                    timelineFocused = true
                    model.setTimelineTrackDensity($0)
                },
                onZoomTimelineIn: {
                    timelineFocused = true
                    model.zoomTimelineIn()
                },
                onZoomTimelineOut: {
                    timelineFocused = true
                    model.zoomTimelineOut()
                },
                onFitTimelineToWindow: {
                    timelineFocused = true
                    model.fitTimelineToWindow()
                },
                onResetTimelineZoom: {
                    timelineFocused = true
                    model.resetTimelineZoom()
                },
                onToggleMultiSelectMode: {
                    timelineFocused = true
                    model.toggleTimelineMultiSelectMode()
                },
                onToggleSnapping: {
                    timelineFocused = true
                    model.toggleTimelineSnapping()
                },
                onToggleBladeMode: {
                    timelineFocused = true
                    model.toggleTimelineBladeMode()
                },
                onApproveSelected: {
                    timelineFocused = true
                    model.approveSelectedTimelineClip()
                },
                onRejectSelected: {
                    timelineFocused = true
                    model.rejectSelectedTimelineClip()
                },
                onTrimSelectedStart: {
                    timelineFocused = true
                    model.trimSelectedTimelineClipStart()
                },
                onTrimSelectedEnd: {
                    timelineFocused = true
                    model.trimSelectedTimelineClipEnd()
                },
                onTrimSelectedStartToPlayhead: {
                    timelineFocused = true
                    model.trimSelectedTimelineClipStartToPlayhead()
                },
                onTrimSelectedEndToPlayhead: {
                    timelineFocused = true
                    model.trimSelectedTimelineClipEndToPlayhead()
                },
                onExtendStart: {
                    timelineFocused = true
                    model.extendSelectedTimelineClipStart()
                },
                onExtendEnd: {
                    timelineFocused = true
                    model.extendSelectedTimelineClipEnd()
                },
                onRollIncomingLeft: {
                    timelineFocused = true
                    model.rollSelectedIncomingEditLeft()
                },
                onRollIncomingRight: {
                    timelineFocused = true
                    model.rollSelectedIncomingEditRight()
                },
                onRollOutgoingLeft: {
                    timelineFocused = true
                    model.rollSelectedOutgoingEditLeft()
                },
                onRollOutgoingRight: {
                    timelineFocused = true
                    model.rollSelectedOutgoingEditRight()
                },
                onSlipLeft: {
                    timelineFocused = true
                    model.slipSelectedTimelineClipLeft()
                },
                onSlipRight: {
                    timelineFocused = true
                    model.slipSelectedTimelineClipRight()
                },
                onNudgeEarlier: {
                    timelineFocused = true
                    model.nudgeSelectedTimelineClipEarlier()
                },
                onNudgeLater: {
                    timelineFocused = true
                    model.nudgeSelectedTimelineClipLater()
                },
                onSplitAtPlayhead: {
                    timelineFocused = true
                    model.splitSelectedTimelineClipAtPlayhead()
                },
                onDeleteSelection: {
                    timelineFocused = true
                    model.deleteTimelineSelection()
                },
                onBladeSplitClip: { clipID, splitFrame in
                    timelineFocused = true
                    model.bladeSplitTimelineClip(clipID, at: splitFrame)
                },
                onPreviewDragTrim: { clipID, edge, frameDelta, snapThresholdFrames in
                    timelineFocused = true
                    model.previewTimelineDragTrim(
                        clipID,
                        edge: edge,
                        frameDelta: frameDelta,
                        snapThresholdFrames: snapThresholdFrames
                    )
                },
                onEndDragTrimPreview: {
                    model.clearTimelineDragTrimPreview()
                },
                onDragTrim: { clipID, edge, frameDelta, snapThresholdFrames in
                    timelineFocused = true
                    model.dragTrimTimelineClip(
                        clipID,
                        edge: edge,
                        frameDelta: frameDelta,
                        snapThresholdFrames: snapThresholdFrames
                    )
                },
                onPreviewRollTrim: { clipID, boundary, frameDelta in
                    timelineFocused = true
                    model.previewTimelineRollTrim(
                        clipID,
                        boundary: boundary,
                        frameDelta: frameDelta
                    )
                },
                onEndRollTrimPreview: {
                    model.clearTimelineRollTrimPreview()
                },
                onDragRollTrim: { clipID, boundary, frameDelta in
                    timelineFocused = true
                    model.dragRollTimelineEdit(
                        clipID,
                        boundary: boundary,
                        frameDelta: frameDelta
                    )
                },
                onPreviewSlipTrim: { clipID, frameDelta in
                    timelineFocused = true
                    model.previewTimelineSlipTrim(clipID, frameDelta: frameDelta)
                },
                onEndSlipTrimPreview: {
                    model.clearTimelineSlipTrimPreview()
                },
                onDragSlipTrim: { clipID, frameDelta in
                    timelineFocused = true
                    model.dragSlipTimelineClip(clipID, frameDelta: frameDelta)
                },
                onBeginClipBodyDrag: { clipID in
                    timelineFocused = true
                    model.beginTimelineClipBodyDrag(clipID)
                },
                onDragMove: { clipID, frameDelta, snapThresholdFrames, targetTrackID in
                    timelineFocused = true
                    model.dragMoveTimelineClip(
                        clipID,
                        frameDelta: frameDelta,
                        snapThresholdFrames: snapThresholdFrames,
                        targetTrackID: targetTrackID
                    )
                },
                onPreviewMove: { clipID, frameDelta, snapThresholdFrames, targetTrackID in
                    timelineFocused = true
                    model.previewTimelineClipMove(
                        clipID,
                        frameDelta: frameDelta,
                        snapThresholdFrames: snapThresholdFrames,
                        targetTrackID: targetTrackID
                    )
                },
                onEndMovePreview: {
                    model.clearTimelineClipMovePreview()
                },
                onApplyTransitionPreset: { presetID, trackID, fromClipID, toClipID in
                    timelineFocused = true
                    model.applyTransitionPreset(
                        presetID,
                        trackID: trackID,
                        fromClipID: fromClipID,
                        toClipID: toClipID
                    )
                },
                onApplyTransitionPresetNearContext: { presetID in
                    timelineFocused = true
                    model.applyTransitionPresetNearContext(presetID)
                },
                onPreviewTransitionPresetDrop: { presetID, trackID, fromClipID, toClipID in
                    timelineFocused = true
                    model.previewTransitionPresetDrop(
                        presetID,
                        trackID: trackID,
                        fromClipID: fromClipID,
                        toClipID: toClipID
                    )
                },
                onPreviewDefaultTransitionEditPointHover: { trackID, fromClipID, toClipID in
                    timelineFocused = true
                    model.previewDefaultTransitionEditPointHover(
                        trackID: trackID,
                        fromClipID: fromClipID,
                        toClipID: toClipID
                    )
                },
                onPreviewTransitionMove: { transitionID, trackID, fromClipID, toClipID in
                    timelineFocused = true
                    model.previewTimelineTransitionMove(
                        transitionID,
                        targetTrackID: trackID,
                        targetFromClipID: fromClipID,
                        targetToClipID: toClipID
                    )
                },
                onMoveTransition: { transitionID, trackID, fromClipID, toClipID in
                    timelineFocused = true
                    model.moveTimelineTransition(
                        transitionID,
                        targetTrackID: trackID,
                        targetFromClipID: fromClipID,
                        targetToClipID: toClipID
                    )
                },
                onSelectTransition: { trackID, fromClipID, toClipID in
                    timelineFocused = true
                    model.selectTimelineTransition(trackID: trackID, fromClipID: fromClipID, toClipID: toClipID)
                },
                onAdjustTransitionDuration: { trackID, fromClipID, toClipID, frameDelta in
                    timelineFocused = true
                    model.adjustTimelineTransitionDuration(
                        trackID: trackID,
                        fromClipID: fromClipID,
                        toClipID: toClipID,
                        frameDelta: frameDelta
                    )
                },
                onPreviewTransitionDuration: { trackID, fromClipID, toClipID, frameDelta in
                    timelineFocused = true
                    model.previewTimelineTransitionDuration(
                        trackID: trackID,
                        fromClipID: fromClipID,
                        toClipID: toClipID,
                        frameDelta: frameDelta
                    )
                },
                onEndTransitionDurationPreview: {
                    model.clearTimelineTransitionDurationPreview()
                },
                onShortenSelectedTransition: {
                    timelineFocused = true
                    model.shortenSelectedTimelineTransitionDuration()
                },
                onLengthenSelectedTransition: {
                    timelineFocused = true
                    model.lengthenSelectedTimelineTransitionDuration()
                },
                onRemoveSelectedTransition: {
                    timelineFocused = true
                    model.removeSelectedTimelineTransition()
                },
                onRippleDeleteSelected: {
                    timelineFocused = true
                    model.rippleDeleteSelectedTimelineClip()
                },
                onPreviewSourceCandidateDrop: { assetID, candidateID, frame, targetTrackID, snapThresholdFrames in
                    model.previewSourceMonitorCandidateDropOnTimeline(
                        sourceAssetID: assetID,
                        candidateID: candidateID,
                        timelineFrame: frame,
                        targetTrackID: targetTrackID,
                        snapThresholdFrames: snapThresholdFrames
                    )
                },
                onDropSourceCandidate: { assetID, candidateID, frame, targetTrackID, snapThresholdFrames in
                    timelineFocused = true
                    model.dropSourceMonitorCandidateOnTimeline(
                        sourceAssetID: assetID,
                        candidateID: candidateID,
                        timelineFrame: frame,
                        targetTrackID: targetTrackID,
                        snapThresholdFrames: snapThresholdFrames
                    )
                },
                onApplyPatch: {
                    timelineFocused = true
                    model.applyStudioPatch()
                },
                onUndoPatch: {
                    timelineFocused = true
                    model.undoLastPatch()
                },
                onOpenSwapBrowser: {
                    timelineFocused = true
                    model.openSwapBrowser(for: $0)
                },
                onOpenFootageSearch: {
                    timelineFocused = true
                    model.openFootageSearch(for: $0)
                },
                onRevealClipSource: {
                    timelineFocused = false
                    model.revealTimelineClipInSourceMonitor($0)
                    sourceMonitorFocused = model.sourceMonitorAssetID != nil
                }
            )
                .frame(height: timelineHeight)
                .focusable(true)
                .focused($timelineFocused)
                .simultaneousGesture(TapGesture().onEnded {
                    timelineFocused = true
                })

            FeedbackStatusBar(
                feedbackSession: model.feedbackSession,
                statusMessage: model.roughCutCompileStatus,
                canPromote: model.canPromoteLatestStudioPatch,
                canUndo: !model.feedbackSession.patchHistory.isEmpty,
                canOpenPreferenceMemory: model.selectedProject != nil,
                onApplyAndPreview: { model.applyStudioPatch() },
                onPromote: { model.promoteStudioPatch() },
                onUndo: { model.undoLastPatch() },
                onDiscard: { model.discardPendingStudioFeedback() },
                onOpenPreferenceMemory: { model.openEditorialPreferenceMemory() }
            )
            .frame(height: feedbackBarHeight)
        }
        .overlay(alignment: .topLeading) {
            VStack(spacing: 0) {
                TimelineShortcutButtons(model: model, isEnabled: timelineFocused)
                SourceMonitorShortcutButtons(
                    model: model,
                    isEnabled: sourceMonitorFocused && model.sourceMonitorAssetID != nil
                )
            }
        }
    }

    private var viewerPanel: some View {
        ViewerPanel(
            project: model.selectedProject,
            playbackContract: model.playbackContractStatus,
            selection: model.activeViewerSelection,
            media: model.activeViewerMediaReference,
            audioMedia: model.activeViewerAudioMediaReference,
            nextMedia: model.activeViewerNextMediaReference,
            transitionPreview: model.activeViewerTransitionPreview,
            captionText: model.activeViewerCaptionText,
            monitorSnapshot: model.activeViewerMonitorSnapshot,
            interviewVisualTransformPreview: model.activeInterviewVisualTransformPreview,
            sequenceWidth: model.timeline?.sequence.width ?? 1_920,
            sequenceHeight: model.timeline?.sequence.height ?? 1_080,
            mediaPreviewSummary: model.mediaPreviewSummary,
            timelinePreviewDiagnostics: model.timelinePreviewDiagnostics,
            playheadLabel: model.activeViewerPlayheadLabel,
            isPlaying: model.isPlaying,
            playbackRate: model.playbackRate,
            playbackRateLabel: model.playbackRateLabel,
            playbackLoopLabel: model.playbackLoopLabel,
            isLoopPlaybackEnabled: model.isLoopPlaybackEnabled,
            syncGeneration: model.mediaPlaybackSyncGeneration,
            audioSyncGeneration: model.audioPlaybackSyncGeneration,
            audioMuted: model.monitorAudioMuted,
            audioVolume: model.monitorAudioVolume,
            onDiagnosticAction: { model.performViewerDiagnosticAction($0) },
            onTogglePlayback: { model.togglePlayback() },
            onPlayReverse: { model.playReverseShuttle() },
            onPlayForward: { model.playForwardShuttle() },
            onTogglePlaybackLoop: { model.toggleLoopPlayback() },
            onStepBackward: { model.stepBackward() },
            onStepForward: { model.stepForward() },
            onToggleAudioMute: { model.toggleMonitorAudioMute() },
            onAudioVolumeChange: { model.setMonitorAudioVolume($0) },
            onPlaybackTimeUpdate: { model.updateSourceMonitorPlaybackTime(seconds: $0) }
        )
        .focusable(true)
        .focused($sourceMonitorFocused)
        .simultaneousGesture(TapGesture().onEnded {
            guard model.sourceMonitorAssetID != nil else { return }
            sourceMonitorFocused = true
        })
    }
}

private extension StudioCommandPaletteCommand {
    func localizedTitle(isPlaying: Bool = false) -> String {
        switch self {
        case .refreshProjects:
            return "プロジェクトを更新"
        case .newProjectFromSource:
            return "素材から新規プロジェクト"
        case .checkCodexAppServer:
            return "Codex接続を確認"
        case .startAgentSession:
            return "エージェントセッションを開始"
        case .stopAgentSession:
            return "セッションを停止"
        case .runSelectedAgentJob:
            return "選択中のジョブを実行"
        case .runReadOnlyAgentTurn:
            return "読み取り専用で相談"
        case .prepareTimelineAgentPrompt:
            return "AI相談プロンプトを準備"
        case .runAgentTightenSelection:
            return "AIに選択範囲を短く相談"
        case .runAgentShortenBeat:
            return "AIにこのビートを短く相談"
        case .runAgentFindStrongerAlternate:
            return "AIに代替素材を相談"
        case .runAgentExplainCut:
            return "AIにカットを説明させる"
        case .approvePendingAgentJob:
            return "保留中ジョブを承認"
        case .runSourceAnalysis:
            return "素材解析を実行"
        case .compileRoughCut:
            return "粗編集を生成"
        case .applyReviewPatch:
            return "レビュー修正を反映"
        case .openSwapBrowser:
            return "差し替え候補を開く"
        case .searchFootage:
            return "素材を検索"
        case .rebuildSearchIndex:
            return "検索インデックスを再構築"
        case .runMarlinEvaluation:
            return "Marlin評価を実行"
        case .buildAudioStoryGraph:
            return "音声ストーリーを構築"
        case .openBGMReview:
            return "BGM試聴・レビューを開く"
        case .buildPreviewProxies:
            return "プレビュー素材を作成"
        case .relinkMissingMedia:
            return "未リンク素材を再接続"
        case .exportPremiereXML:
            return "Premiere XMLを書き出し"
        case .exportEditorPacket:
            return "編集者パケットを書き出し"
        case .renderFinalPackage:
            return "最終動画を書き出し"
        case .promoFinish:
            return "宣材テロップ仕上げ"
        case .runStudioAcceptanceSmoke:
            return "受け入れチェックを実行"
        case .playTimeline:
            return isPlaying ? "再生を一時停止" : "タイムラインを再生"
        case .playTimelineReverse:
            return "逆再生"
        case .pauseTimeline:
            return "再生を停止"
        case .stepTimelineBackward:
            return "1フレーム戻る"
        case .stepTimelineForward:
            return "1フレーム進む"
        case .jumpToPreviousTimelineEditPoint:
            return "前の編集点へ移動"
        case .jumpToNextTimelineEditPoint:
            return "次の編集点へ移動"
        case .markSourceMonitorInAtPlaybackTime:
            return "ソースINを現在位置へ"
        case .markSourceMonitorOutAtPlaybackTime:
            return "ソースOUTを現在位置へ"
        case .nudgeSourceMonitorMarkInEarlier:
            return "ソースINを0.5秒前へ"
        case .nudgeSourceMonitorMarkInLater:
            return "ソースINを0.5秒後ろへ"
        case .nudgeSourceMonitorMarkOutEarlier:
            return "ソースOUTを0.5秒前へ"
        case .nudgeSourceMonitorMarkOutLater:
            return "ソースOUTを0.5秒後ろへ"
        case .resetSourceMonitorMarkedRange:
            return "ソース範囲をリセット"
        case .selectPreviousSourceMonitorCandidate:
            return "前のソース候補"
        case .selectNextSourceMonitorCandidate:
            return "次のソース候補"
        case .insertSourceMonitorAtPlayhead:
            return "ソースを再生位置へ追加"
        case .appendSourceMonitorToTimelineEnd:
            return "ソースを末尾へ追加"
        case .overwriteSourceMonitorAtPlayhead:
            return "ソースで上書き"
        case .replaceSelectedClipWithSourceMonitor:
            return "選択クリップをソースで置換"
        case .revealSelectedClipInSourceMonitor:
            return "選択クリップをソース確認"
        case .setLoopRangeToSelection:
            return "選択範囲をループ"
        case .toggleLoopPlayback:
            return "ループ再生をオン/オフ"
        case .clearLoopRange:
            return "ループ範囲を解除"
        case .selectAllTimelineClips:
            return "タイムラインを全選択"
        case .clearTimelineSelection:
            return "タイムライン選択を解除"
        case .selectPreviousTimelineClip:
            return "前のクリップを選択"
        case .selectNextTimelineClip:
            return "次のクリップを選択"
        case .extendTimelineSelectionPrevious:
            return "前へ範囲選択"
        case .extendTimelineSelectionNext:
            return "次へ範囲選択"
        case .deleteTimelineSelection:
            return "選択項目を削除"
        case .applyDefaultCrossfadeTransition:
            return "クロスフェードを適用"
        case .shortenSelectedTransition:
            return "トランジションを短く"
        case .lengthenSelectedTransition:
            return "トランジションを長く"
        case .trimTimelineClipStartToPlayhead:
            return "先頭を再生位置へトリム"
        case .trimTimelineClipEndToPlayhead:
            return "末尾を再生位置へトリム"
        case .zoomTimelineOut:
            return "タイムラインを縮小"
        case .zoomTimelineIn:
            return "タイムラインを拡大"
        case .fitTimelineToWindow:
            return "タイムライン全体を表示"
        case .resetTimelineZoom:
            return "タイムライン100%"
        case .toggleTimelineSnapping:
            return "吸着をオン/オフ"
        case .toggleTimelineBladeMode:
            return "ブレードをオン/オフ"
        }
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
            Button("選択クリップを承認") {
                model.approveSelectedTimelineClip()
            }
            .keyboardShortcut("a", modifiers: [])
            .disabled(!isEnabled || !hasSelectedClip)

            Button("選択クリップを却下") {
                model.rejectSelectedTimelineClip()
            }
            .keyboardShortcut("x", modifiers: [])
            .disabled(!isEnabled || !hasSelectedClip)

            Button("差し替え候補を開く") {
                model.openSwapBrowserForSelectedClip()
            }
            .keyboardShortcut("s", modifiers: [])
            .disabled(!isEnabled || !hasSelectedClip)

            Button("表示中のStudio編集を保存") {
                model.applyStudioPatch()
            }
            .keyboardShortcut(.return, modifiers: [.command])
            .disabled(!isEnabled || !model.feedbackSession.isDirty || hasPatchConflicts || model.isCompilingRoughCut)

            Button("直前の修正を戻す") {
                model.undoLastPatch()
            }
            .keyboardShortcut("z", modifiers: [.command])
            .disabled(!isEnabled || model.feedbackSession.patchHistory.isEmpty)

            Button("タイムラインを全選択") {
                model.selectAllTimelineClips()
            }
            .keyboardShortcut("a", modifiers: [.command])
            .disabled(!isEnabled || model.timeline == nil)

            Button("タイムライン選択を解除") {
                model.clearTimelineSelectionAndTemporaryTools()
            }
            .keyboardShortcut(.cancelAction)
            .disabled(!isEnabled || !model.hasTimelineSelectionOrTemporaryTool)

            Button("前のクリップを選択") {
                model.selectPreviousTimelineClip()
            }
            .keyboardShortcut(.leftArrow, modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("次のクリップを選択") {
                model.selectNextTimelineClip()
            }
            .keyboardShortcut(.rightArrow, modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("前へ範囲選択") {
                model.extendTimelineSelectionPrevious()
            }
            .keyboardShortcut(.leftArrow, modifiers: [.shift])
            .disabled(!isEnabled || model.timeline == nil)

            Button("次へ範囲選択") {
                model.extendTimelineSelectionNext()
            }
            .keyboardShortcut(.rightArrow, modifiers: [.shift])
            .disabled(!isEnabled || model.timeline == nil)

            Button("選択項目を削除") {
                model.deleteTimelineSelection()
            }
            .keyboardShortcut(.delete, modifiers: [])
            .disabled(!isEnabled || !model.canDeleteTimelineSelection)

            Button("選択クリップをソース確認") {
                model.revealSelectedTimelineClipInSourceMonitor()
            }
            .keyboardShortcut("f", modifiers: [])
            .disabled(!isEnabled || !model.canRevealSelectedTimelineClipInSourceMonitor)

            Button("クロスフェードを適用") {
                model.applyTransitionPresetNearContext(TimelineTransitionPreset.defaultPreset.id)
            }
            .keyboardShortcut("t", modifiers: [.command])
            .disabled(!isEnabled || model.timeline == nil)

            Button("選択クリップの先頭を再生位置へトリム") {
                model.trimSelectedTimelineClipStartToPlayhead()
            }
            .keyboardShortcut("q", modifiers: [])
            .disabled(!isEnabled || !model.canTrimSelectedTimelineClipStartToPlayhead)

            Button("選択クリップの末尾を再生位置へトリム") {
                model.trimSelectedTimelineClipEndToPlayhead()
            }
            .keyboardShortcut("w", modifiers: [])
            .disabled(!isEnabled || !model.canTrimSelectedTimelineClipEndToPlayhead)

            Button("逆再生") {
                model.playReverseShuttle()
            }
            .keyboardShortcut("j", modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("1フレーム戻る") {
                model.stepBackward()
            }
            .keyboardShortcut(",", modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("前の編集点へ移動") {
                model.jumpToPreviousTimelineEditPoint()
            }
            .keyboardShortcut(.upArrow, modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("次の編集点へ移動") {
                model.jumpToNextTimelineEditPoint()
            }
            .keyboardShortcut(.downArrow, modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("再生を停止") {
                model.pausePlayback()
            }
            .keyboardShortcut("k", modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("タイムラインを再生") {
                model.playForwardShuttle()
            }
            .keyboardShortcut("l", modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("選択クリップをループ") {
                model.toggleLoopPlayback()
            }
            .keyboardShortcut("r", modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("タイムラインを縮小") {
                model.zoomTimelineOut()
            }
            .keyboardShortcut("-", modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("タイムラインを拡大") {
                model.zoomTimelineIn()
            }
            .keyboardShortcut("=", modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("選択クリップを0.5秒前へ移動") {
                model.nudgeSelectedTimelineClipEarlier()
            }
            .keyboardShortcut("[", modifiers: [])
            .disabled(!isEnabled || !model.canNudgeSelectedTimelineClipEarlier)

            Button("選択クリップを0.5秒後ろへ移動") {
                model.nudgeSelectedTimelineClipLater()
            }
            .keyboardShortcut("]", modifiers: [])
            .disabled(!isEnabled || !model.canNudgeSelectedTimelineClipLater)

            Button("選択トランジションを0.5秒短く") {
                model.shortenSelectedTimelineTransitionDuration()
            }
            .keyboardShortcut("[", modifiers: [.shift])
            .disabled(!isEnabled || !model.canShortenSelectedTimelineTransitionDuration)

            Button("選択トランジションを0.5秒長く") {
                model.lengthenSelectedTimelineTransitionDuration()
            }
            .keyboardShortcut("]", modifiers: [.shift])
            .disabled(!isEnabled || !model.canLengthenSelectedTimelineTransitionDuration)

            Button("タイムライン吸着を切り替え") {
                model.toggleTimelineSnapping()
            }
            .keyboardShortcut("n", modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("ブレードを切り替え") {
                model.toggleTimelineBladeMode()
            }
            .keyboardShortcut("b", modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)
        }
        .frame(width: 0, height: 0)
        .clipped()
        .opacity(0)
        .accessibilityHidden(true)
    }
}

private struct SourceMonitorShortcutButtons: View {
    @ObservedObject var model: StudioViewModel
    var isEnabled: Bool

    var body: some View {
        VStack {
            Button("ソースINを現在位置へ") {
                model.markSourceMonitorInAtPlaybackTime()
            }
            .keyboardShortcut("i", modifiers: [])
            .disabled(!isEnabled || !model.canMarkSourceMonitorInAtPlaybackTime)

            Button("ソースOUTを現在位置へ") {
                model.markSourceMonitorOutAtPlaybackTime()
            }
            .keyboardShortcut("o", modifiers: [])
            .disabled(!isEnabled || !model.canMarkSourceMonitorOutAtPlaybackTime)

            Button("ソースモニターを再生/一時停止") {
                model.togglePlayback()
            }
            .keyboardShortcut(.space, modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("ソースモニターを逆再生") {
                model.playReverseShuttle()
            }
            .keyboardShortcut("j", modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("ソースモニターを停止") {
                model.pausePlayback()
            }
            .keyboardShortcut("k", modifiers: [])
            .disabled(!isEnabled || model.timeline == nil || !model.isPlaying)

            Button("ソースモニターを順再生") {
                model.playForwardShuttle()
            }
            .keyboardShortcut("l", modifiers: [])
            .disabled(!isEnabled || model.timeline == nil)

            Button("ソースモニターを1フレーム戻る") {
                model.stepBackward()
            }
            .keyboardShortcut(",", modifiers: [])
            .disabled(!isEnabled || !model.canStepSourceMonitorBackward)

            Button("ソースモニターを1フレーム進む") {
                model.stepForward()
            }
            .keyboardShortcut(".", modifiers: [])
            .disabled(!isEnabled || !model.canStepSourceMonitorForward)

            Button("ソースINを0.5秒前へ") {
                model.nudgeSourceMonitorMarkIn(by: -500_000)
            }
            .keyboardShortcut("[", modifiers: [.option])
            .disabled(!isEnabled || !model.canNudgeSourceMonitorMarkInEarlier)

            Button("ソースINを0.5秒後ろへ") {
                model.nudgeSourceMonitorMarkIn(by: 500_000)
            }
            .keyboardShortcut("]", modifiers: [.option])
            .disabled(!isEnabled || !model.canNudgeSourceMonitorMarkInLater)

            Button("ソースOUTを0.5秒前へ") {
                model.nudgeSourceMonitorMarkOut(by: -500_000)
            }
            .keyboardShortcut("[", modifiers: [.option, .shift])
            .disabled(!isEnabled || !model.canNudgeSourceMonitorMarkOutEarlier)

            Button("ソースOUTを0.5秒後ろへ") {
                model.nudgeSourceMonitorMarkOut(by: 500_000)
            }
            .keyboardShortcut("]", modifiers: [.option, .shift])
            .disabled(!isEnabled || !model.canNudgeSourceMonitorMarkOutLater)

            Button("ソース範囲をリセット") {
                model.resetSourceMonitorMarkedRange()
            }
            .keyboardShortcut("r", modifiers: [.shift])
            .disabled(!isEnabled || !model.canResetSourceMonitorMarkedRange)

            Button("前のソース候補") {
                model.selectPreviousSourceMonitorCandidate()
            }
            .keyboardShortcut("[", modifiers: [])
            .disabled(!isEnabled || !model.canSelectPreviousSourceMonitorCandidate)

            Button("次のソース候補") {
                model.selectNextSourceMonitorCandidate()
            }
            .keyboardShortcut("]", modifiers: [])
            .disabled(!isEnabled || !model.canSelectNextSourceMonitorCandidate)

            Button("ソースを再生位置へ追加") {
                model.insertSourceMonitorAtPlayhead()
            }
            .keyboardShortcut("w", modifiers: [])
            .disabled(!isEnabled || !model.canInsertSourceMonitorAtPlayhead)

            Button("ソースを末尾へ追加") {
                model.appendSourceMonitorToTimelineEnd()
            }
            .keyboardShortcut("e", modifiers: [])
            .disabled(!isEnabled || !model.canAppendSourceMonitorToTimelineEnd)

            Button("ソースで上書き") {
                model.overwriteSourceMonitorAtPlayhead()
            }
            .keyboardShortcut("d", modifiers: [])
            .disabled(!isEnabled || !model.canOverwriteSourceMonitorAtPlayhead)

            Button("選択クリップをソースで置換") {
                model.replaceSelectedClipWithSourceMonitorCandidate()
            }
            .keyboardShortcut("r", modifiers: [])
            .disabled(!isEnabled || !model.canReplaceSelectedClipWithSourceMonitorCandidate)
        }
        .frame(width: 0, height: 0)
        .clipped()
        .opacity(0)
        .accessibilityHidden(true)
    }
}
