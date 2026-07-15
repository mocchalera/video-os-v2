import AppKit
import AVKit
import SwiftUI
import VideoOSStudioCore

struct CaptionFinishingView: View {
    private enum QueueFilter: String, CaseIterable, Identifiable {
        case needsAttention = "要確認"
        case blocking = "修正必須"
        case unreviewed = "未確認"
        case verified = "確認済み"
        case all = "すべて"

        var id: String { rawValue }
    }

    private enum QueueOrder: String, CaseIterable, Identifiable {
        case risk = "リスク順"
        case timeline = "時系列"

        var id: String { rawValue }
    }

    @Environment(\.dismiss) private var dismiss
    @StateObject private var session: CaptionReviewSession
    @StateObject private var previewController = CaptionMediaPreviewController()
    @State private var filter: QueueFilter = .needsAttention
    @State private var order: QueueOrder = .risk
    @State private var searchText = ""
    @State private var isSplitConfirmationPresented = false
    @State private var isMergeConfirmationPresented = false
    @State private var isGlossaryProposalPresented = false
    @State private var glossaryCanonical = ""
    @State private var glossaryVariant = ""
    @FocusState private var editorFocused: Bool

    let onRevealInTimeline: (Int) -> Void

    init(
        projectURL: URL,
        repositoryRoot: URL,
        onRevealInTimeline: @escaping (Int) -> Void
    ) {
        _session = StateObject(wrappedValue: CaptionReviewSession(
            projectURL: projectURL,
            repositoryRoot: repositoryRoot
        ))
        self.onRevealInTimeline = onRevealInTimeline
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if session.isBusy && session.items.isEmpty {
                ProgressView("字幕ドラフトを読み込んでいます...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = session.errorMessage, session.items.isEmpty {
                ContentUnavailableView(
                    "字幕レビューを開始できません",
                    systemImage: "captions.bubble.fill",
                    description: Text(error)
                )
            } else {
                HSplitView {
                    queuePane
                        .frame(minWidth: 290, idealWidth: 330, maxWidth: 390)
                    editorPane
                        .frame(minWidth: 470, idealWidth: 580)
                    inspectorPane
                        .frame(minWidth: 250, idealWidth: 290, maxWidth: 340)
                }
            }
            Divider()
            statusBar
        }
        .frame(minWidth: 1080, minHeight: 700)
        .task {
            await session.load()
            preparePreview()
        }
        .onChange(of: session.selectedCaptionID) { _, _ in preparePreview() }
        .onChange(of: session.draftStartFrame) { _, _ in
            updatePreviewCaptionRange()
            session.scheduleAutosave()
        }
        .onChange(of: session.draftEndFrame) { _, _ in
            updatePreviewCaptionRange()
            session.scheduleAutosave()
        }
        .onDisappear { previewController.pause() }
        .confirmationDialog(
            "この字幕を2つに分割しますか？",
            isPresented: $isSplitConfirmationPresented,
            titleVisibility: .visible
        ) {
            Button("中央フレームで分割") {
                Task { await session.splitSelected(at: splitFrame) }
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("本文は中央付近の句読点を優先して分け、両方を未確認へ戻します。")
        }
        .confirmationDialog(
            "次の字幕と結合しますか？",
            isPresented: $isMergeConfirmationPresented,
            titleVisibility: .visible
        ) {
            Button("結合") {
                Task { await session.mergeSelectedWithNext() }
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text(session.nextTimelineItem.map { "\($0.captionID)「\($0.text)」と結合し、未確認へ戻します。" } ?? "次の字幕がありません。")
        }
        .sheet(isPresented: $isGlossaryProposalPresented) {
            glossaryProposalSheet
        }
        .sheet(isPresented: Binding(
            get: { session.conflict != nil },
            set: { isPresented in
                if !isPresented, session.conflict != nil { session.dismissConflict() }
            }
        )) {
            if let conflict = session.conflict {
                CaptionConflictResolutionView(
                    conflict: conflict,
                    useCurrent: { session.resolveConflictUsingCurrent() },
                    keepWorking: { session.resolveConflictKeepingWorkingCopy() }
                )
            }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Label("字幕仕上げ", systemImage: "captions.bubble.fill")
                .font(.title2.weight(.semibold))

            if let document = session.document {
                summaryChip("修正必須", value: document.blockingCount, color: .red)
                summaryChip("注意", value: document.warningCount, color: .orange)
                summaryChip("確認済み", value: document.verifiedCount, color: .green)
                summaryChip("全件", value: document.items.count, color: .secondary)
            }

            Spacer()

            TextField("レビュー担当者", text: $session.reviewer)
                .textFieldStyle(.roundedBorder)
                .frame(width: 180)
                .accessibilityIdentifier("CaptionReviewerField")

            Button {
                Task { await session.undoLastAction() }
            } label: {
                Label(session.undoDepth > 1 ? "取り消す（\(session.undoDepth)）" : "取り消す", systemImage: "arrow.uturn.backward")
            }
            .disabled(!session.canUndo)
            .keyboardShortcut("z", modifiers: [.command])
            .help("保存した字幕編集を1操作単位で取り消します。残り\(session.undoDepth)操作")
            .accessibilityIdentifier("CaptionUndoButton")

            Button("完パケ承認") {
                Task { await session.approve() }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!session.canApprove)
            .help("すべての字幕が確認済みで、修正必須と要確認が0件の場合に承認できます")
            .accessibilityIdentifier("CaptionApproveButton")

            Button("閉じる") { dismiss() }
                .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.regularMaterial)
    }

    private var queuePane: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                Picker("表示", selection: $filter) {
                    ForEach(QueueFilter.allCases) { filter in
                        Text(filter.rawValue).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                Picker("並び順", selection: $order) {
                    ForEach(QueueOrder.allCases) { order in
                        Text(order.rawValue).tag(order)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("CaptionQueueOrderPicker")

                TextField("本文・IDを検索", text: $searchText)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("CaptionQueueSearchField")
            }
            .padding(12)

            Divider()

            List(selection: Binding(
                get: { session.selectedCaptionID },
                set: { session.select($0) }
            )) {
                ForEach(filteredItems) { item in
                    CaptionQueueRow(item: item)
                        .tag(item.captionID)
                }
            }
            .accessibilityIdentifier("CaptionReviewQueue")
            .overlay {
                if filteredItems.isEmpty {
                    ContentUnavailableView(
                        "該当する字幕がありません",
                        systemImage: "captions.bubble",
                        description: Text(searchText.isEmpty ? "表示条件を切り替えてください。" : "検索語または表示条件を変更してください。")
                    )
                }
            }
        }
    }

    private var editorPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let item = session.selectedItem {
                HStack {
                    Button {
                        session.selectPreviousInTimeline()
                    } label: {
                        Label("前の字幕", systemImage: "chevron.left")
                    }
                    .disabled(session.previousTimelineItem == nil || session.hasUnsavedChange)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.captionID)
                            .font(.headline.monospaced())
                        Text("Frame \(item.timelineInFrame) ・ Risk \(Int(item.riskScore))")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        session.selectNextInTimeline()
                    } label: {
                        Label("次の字幕", systemImage: "chevron.right")
                    }
                    .labelStyle(.titleAndIcon)
                    .disabled(session.nextTimelineItem == nil || session.hasUnsavedChange)

                    Button {
                        onRevealInTimeline(item.timelineInFrame)
                    } label: {
                        Label("タイムラインで確認", systemImage: "play.rectangle")
                    }
                    .accessibilityIdentifier("CaptionRevealInTimelineButton")
                }
                .padding(16)

                captionMediaPreview(text: session.draftText)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 14)

                Text("本文・改行")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)

                IMEAwareTextEditor(
                    text: $session.draftText,
                    isFocused: Binding(
                        get: { editorFocused },
                        set: { editorFocused = $0 }
                    ),
                    onTextChange: { isCompositionActive in
                        session.handleTextChange(isCompositionActive: isCompositionActive)
                    }
                )
                    .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(editorFocused ? Color.accentColor : Color.secondary.opacity(0.25), lineWidth: 1)
                    )
                    .padding(.horizontal, 16)
                    .frame(minHeight: 120)

                timingEditor(item: item)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)

                HStack(spacing: 10) {
                    Button {
                        isSplitConfirmationPresented = true
                    } label: {
                        Label("2つに分割", systemImage: "scissors")
                    }
                    .disabled(session.isBusy || session.hasUnsavedChange || item.timelineDurationFrames < 2)
                    .help("現在の字幕を中央フレームと本文の句読点付近で分割します")
                    .accessibilityIdentifier("CaptionSplitButton")

                    Button {
                        isMergeConfirmationPresented = true
                    } label: {
                        Label("次と結合", systemImage: "rectangle.2.swap")
                    }
                    .disabled(session.isBusy || session.hasUnsavedChange || session.nextTimelineItem == nil)
                    .help("時系列で直後にある字幕と結合します")
                    .accessibilityIdentifier("CaptionMergeButton")

                    Spacer()

                    Toggle("自動保存", isOn: $session.isAutosaveEnabled)
                        .toggleStyle(.switch)
                        .controlSize(.small)
                        .help("入力停止から約1.2秒後に未確認として保存します")
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)

                HStack(spacing: 10) {
                    Text("\(session.draftText.replacingOccurrences(of: "\n", with: "").count)文字 / \(session.draftText.split(separator: "\n", omittingEmptySubsequences: false).count)行")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)

                    Spacer()

                    Button("要確認にする") {
                        Task { await session.saveSelected(state: .flagged) }
                    }
                    .disabled(session.isBusy || session.isTextCompositionActive ||
                        (!session.hasUnsavedChange && item.reviewState == .flagged))

                    Button("修正を保存") {
                        Task { await session.saveSelected(state: .unreviewed) }
                    }
                    .disabled(session.isBusy || session.isTextCompositionActive ||
                        (!session.hasUnsavedChange && item.reviewState == .unreviewed))

                    Button("保存して確認済み") {
                        Task { await session.saveSelected(state: .verified) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(session.isBusy || session.isTextCompositionActive ||
                        (!session.hasUnsavedChange && item.reviewState == .verified))
                    .keyboardShortcut(.return, modifiers: [.command])
                    .accessibilityIdentifier("CaptionVerifyButton")
                }
                .padding(16)
            } else {
                ContentUnavailableView(
                    "字幕を選択してください",
                    systemImage: "captions.bubble",
                    description: Text("左のリスク順キューから確認する字幕を選びます。")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var inspectorPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let item = session.selectedItem {
                    Label(item.reviewState.localizedLabel, systemImage: stateIcon(item.reviewState))
                        .font(.headline)
                        .foregroundStyle(stateColor(item.reviewState))

                    Divider()

                    Text("検出事項")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                    if item.issues.isEmpty {
                        Label("機械検査の指摘なし", systemImage: "checkmark.circle")
                            .foregroundStyle(.green)
                    } else {
                        ForEach(item.issues) { issue in
                            VStack(alignment: .leading, spacing: 5) {
                                Label(issue.severity.localizedLabel, systemImage: issueIcon(issue.severity))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(issueColor(issue.severity))
                                Text(issue.message)
                                    .font(.callout)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(issueColor(issue.severity).opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }

                    Divider()

                    glossaryInspector(item: item)

                    Divider()

                    Text("元の本文hash")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(item.textHash)
                        .font(.caption2.monospaced())
                        .textSelection(.enabled)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(16)
        }
    }

    private func glossaryInspector(item: CaptionReviewQueueItem) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("プロジェクト用語集")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            Button {
                glossaryCanonical = session.draftText
                    .replacingOccurrences(of: "\n", with: "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                glossaryVariant = (item.sourceText ?? item.text)
                    .replacingOccurrences(of: "\n", with: "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if glossaryCanonical == glossaryVariant { glossaryVariant = "" }
                isGlossaryProposalPresented = true
            } label: {
                Label("この修正を用語集候補へ", systemImage: "character.book.closed")
            }
            .disabled(session.isBusy || session.hasUnsavedChange)
            .help("正しい表記と誤認識例を、人間確認待ちのプロジェクト用語候補として保存します")
            .accessibilityIdentifier("CaptionGlossaryProposalButton")

            let proposals = session.document?.glossaryProposals.filter {
                $0.sourceCaptionIDs.contains(item.captionID)
            } ?? []
            ForEach(proposals) { proposal in
                VStack(alignment: .leading, spacing: 3) {
                    Label(proposal.canonical, systemImage: "checkmark.bubble")
                        .font(.callout.weight(.medium))
                    if !proposal.variants.isEmpty {
                        Text("誤認識: \(proposal.variants.joined(separator: "、"))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.accentColor.opacity(0.07), in: RoundedRectangle(cornerRadius: 7))
            }
        }
    }

    private var glossaryProposalSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("プロジェクト用語集候補", systemImage: "character.book.closed.fill")
                .font(.title2.weight(.semibold))
            Text("この段階では候補として保存します。確認済み字幕や辞書ファイルは自動変更しません。")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Form {
                TextField("正しい表記", text: $glossaryCanonical)
                    .accessibilityIdentifier("CaptionGlossaryCanonicalField")
                TextField("誤認識・別表記（任意）", text: $glossaryVariant)
                    .accessibilityIdentifier("CaptionGlossaryVariantField")
            }
            .formStyle(.grouped)

            HStack {
                Spacer()
                Button("キャンセル") { isGlossaryProposalPresented = false }
                    .keyboardShortcut(.cancelAction)
                Button("候補へ追加") {
                    let canonical = glossaryCanonical
                    let variant = glossaryVariant
                    isGlossaryProposalPresented = false
                    Task { await session.proposeGlossaryTerm(canonical: canonical, variant: variant) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(glossaryCanonical.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("CaptionGlossarySubmitButton")
            }
        }
        .padding(24)
        .frame(width: 480)
    }

    private var statusBar: some View {
        HStack(spacing: 10) {
            if session.isBusy {
                ProgressView()
                    .controlSize(.small)
            }
            if session.requiresManualConflictSave {
                Label("競合後の作業案は明示保存待ち", systemImage: "hand.raised.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
            }
            if session.isTextCompositionActive {
                Label("変換中・保存待機", systemImage: "character.cursor.ibeam")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.blue)
            }
            Image(systemName: session.errorMessage == nil ? "info.circle" : "exclamationmark.triangle.fill")
                .foregroundStyle(session.errorMessage == nil ? Color.secondary : Color.red)
            Text(session.errorMessage ?? session.statusMessage)
                .font(.caption)
                .lineLimit(2)
            Spacer()
            Text("⌘↩ 保存して確認済み")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .frame(height: 38)
        .background(.bar)
    }

    private var filteredItems: [CaptionReviewQueueItem] {
        session.items.filter { item in
            let matchesFilter: Bool
            switch filter {
            case .needsAttention:
                matchesFilter = item.hasBlockingIssue || item.hasWarning || item.reviewState != .verified
            case .blocking:
                matchesFilter = item.hasBlockingIssue
            case .unreviewed:
                matchesFilter = item.reviewState == .unreviewed
            case .verified:
                matchesFilter = item.reviewState == .verified
            case .all:
                matchesFilter = true
            }
            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            return matchesFilter && (query.isEmpty ||
                item.captionID.localizedCaseInsensitiveContains(query) ||
                item.text.localizedCaseInsensitiveContains(query))
        }.sorted { lhs, rhs in
            switch order {
            case .risk:
                return lhs.riskScore > rhs.riskScore ||
                    (lhs.riskScore == rhs.riskScore && lhs.timelineInFrame < rhs.timelineInFrame)
            case .timeline:
                return lhs.timelineInFrame < rhs.timelineInFrame ||
                    (lhs.timelineInFrame == rhs.timelineInFrame && lhs.captionID < rhs.captionID)
            }
        }
    }

    private func captionMediaPreview(text: String) -> some View {
        VStack(spacing: 8) {
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.black.gradient)
                VideoPlayer(player: previewController.player)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                CaptionActualSizeOverlay(
                    text: text.isEmpty ? "字幕プレビュー" : text,
                    style: session.document?.captionStyle ?? .default
                )
            }
            .frame(height: 190)

            CaptionWaveformStrip(
                peaks: previewController.waveformPeaks,
                loopStartSeconds: previewController.loopStartSeconds,
                loopEndSeconds: previewController.loopEndSeconds,
                currentSeconds: previewController.currentSeconds,
                fps: session.document?.fps ?? 24,
                captionStartFrame: $session.draftStartFrame,
                captionEndFrame: $session.draftEndFrame
            )
            .frame(height: 44)

            HStack(spacing: 10) {
                Button {
                    previewController.togglePlayback()
                } label: {
                    Label(previewController.isPlaying ? "一時停止" : "前後をループ再生", systemImage: previewController.isPlaying ? "pause.fill" : "play.fill")
                }
                .keyboardShortcut(.space, modifiers: [])
                .accessibilityIdentifier("CaptionPreviewPlayButton")

                Button {
                    previewController.restartLoop()
                } label: {
                    Image(systemName: "backward.end.fill")
                }
                .help("発話前の余白から再生")
                .accessibilityLabel("前後プレビューを先頭から再生")

                Text(previewController.statusMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("字幕の発話前後プレビュー")
    }

    private func timingEditor(item: CaptionReviewQueueItem) -> some View {
        HStack(spacing: 14) {
            Label("表示タイミング", systemImage: "timer")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            Stepper(
                "IN \(session.draftStartFrame)",
                value: $session.draftStartFrame,
                in: 0...max(0, session.draftEndFrame - 1)
            )
            .font(.caption.monospacedDigit())
            .accessibilityIdentifier("CaptionStartFrameStepper")

            Stepper(
                "OUT \(session.draftEndFrame)",
                value: $session.draftEndFrame,
                in: (session.draftStartFrame + 1)...max(
                    session.draftStartFrame + 1,
                    item.timelineOutFrame + Int((session.document?.fps ?? 24) * 10)
                )
            )
            .font(.caption.monospacedDigit())
            .accessibilityIdentifier("CaptionEndFrameStepper")

            Spacer()

            Text("\(session.draftEndFrame - session.draftStartFrame)f / \(formatSeconds(Double(session.draftEndFrame - session.draftStartFrame) / max(session.document?.fps ?? 24, 1)))")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    private var splitFrame: Int {
        session.draftStartFrame + max(1, (session.draftEndFrame - session.draftStartFrame) / 2)
    }

    private func preparePreview() {
        guard let item = session.selectedItem else {
            previewController.pause()
            return
        }
        previewController.prepare(
            projectURL: session.projectURL,
            item: item,
            fps: session.document?.fps ?? 24
        )
    }

    private func updatePreviewCaptionRange() {
        previewController.updateCaptionRange(
            startFrame: session.draftStartFrame,
            endFrame: session.draftEndFrame,
            fps: session.document?.fps ?? 24
        )
    }

    private func formatSeconds(_ seconds: Double) -> String {
        String(format: "%.2fs", max(0, seconds))
    }

    private func summaryChip(_ label: String, value: Int, color: Color) -> some View {
        HStack(spacing: 5) {
            Text("\(value)")
                .font(.caption.monospacedDigit().weight(.bold))
            Text(label)
                .font(.caption)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(color.opacity(0.09), in: Capsule())
    }

    private func stateIcon(_ state: CaptionReviewState) -> String {
        switch state {
        case .unreviewed: return "circle.dashed"
        case .verified: return "checkmark.circle.fill"
        case .flagged: return "flag.fill"
        }
    }

    private func stateColor(_ state: CaptionReviewState) -> Color {
        switch state {
        case .unreviewed: return .secondary
        case .verified: return .green
        case .flagged: return .red
        }
    }

    private func issueIcon(_ severity: CaptionReviewSeverity) -> String {
        switch severity {
        case .info: return "info.circle"
        case .warn: return "exclamationmark.triangle"
        case .block: return "xmark.octagon.fill"
        }
    }

    private func issueColor(_ severity: CaptionReviewSeverity) -> Color {
        switch severity {
        case .info: return .secondary
        case .warn: return .orange
        case .block: return .red
        }
    }
}

private struct CaptionConflictResolutionView: View {
    @Environment(\.dismiss) private var dismiss

    let conflict: CaptionReviewConflict
    let useCurrent: () -> Void
    let keepWorking: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("字幕の編集競合", systemImage: "arrow.triangle.branch")
                .font(.title2.weight(.semibold))
            Text("\(conflict.loaded.captionID) は読み込み後に別の編集で更新されました。現在版を基準に、作業案を残すか選んでください。")
                .foregroundStyle(.secondary)

            HStack(alignment: .top, spacing: 12) {
                conflictCard(
                    title: "読み込み時",
                    text: conflict.loaded.text,
                    frames: conflict.loaded.timelineInFrame..<conflict.loaded.timelineOutFrame,
                    color: .secondary
                )
                conflictCard(
                    title: "現在版",
                    text: conflict.current.text,
                    frames: conflict.current.timelineInFrame..<conflict.current.timelineOutFrame,
                    color: .blue
                )
                conflictCard(
                    title: "作業案",
                    text: conflict.workingText,
                    frames: conflict.workingStartFrame..<conflict.workingEndFrame,
                    color: .orange
                )
            }

            HStack {
                Text("自動保存は競合解決まで停止します。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("現在版を使う") {
                    useCurrent()
                    dismiss()
                }
                Button("作業案を残す") {
                    keepWorking()
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .help("現在版を新しい基準として読み込み、作業案を未保存の状態で残します")
                .accessibilityIdentifier("CaptionConflictKeepWorkingButton")
            }
        }
        .padding(24)
        .frame(width: 820)
        .accessibilityIdentifier("CaptionConflictResolutionSheet")
    }

    private func conflictCard(
        title: String,
        text: String,
        frames: Range<Int>,
        color: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(color)
            Text(text)
                .font(.system(size: 17, weight: .medium))
                .lineSpacing(4)
                .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
                .textSelection(.enabled)
            Text("IN \(frames.lowerBound) / OUT \(frames.upperBound)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(color.opacity(0.45), lineWidth: 1)
        )
    }
}

private struct CaptionQueueRow: View {
    let item: CaptionReviewQueueItem

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            RoundedRectangle(cornerRadius: 2)
                .fill(indicatorColor)
                .frame(width: 4)

            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(item.captionID)
                        .font(.caption.monospaced().weight(.semibold))
                    Spacer()
                    Text("R\(Int(item.riskScore))")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Text(item.text.replacingOccurrences(of: "\n", with: " / "))
                    .font(.callout)
                    .lineLimit(2)
                HStack(spacing: 5) {
                    Image(systemName: stateIcon)
                    Text(item.reviewState.localizedLabel)
                    if !item.issues.isEmpty {
                        Text("・\(item.issues.count)件")
                    }
                }
                .font(.caption2)
                .foregroundStyle(indicatorColor)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.captionID)、\(item.reviewState.localizedLabel)、リスク\(Int(item.riskScore))、\(item.text)")
    }

    private var indicatorColor: Color {
        if item.hasBlockingIssue || item.reviewState == .flagged { return .red }
        if item.hasWarning { return .orange }
        if item.reviewState == .verified { return .green }
        return .secondary
    }

    private var stateIcon: String {
        switch item.reviewState {
        case .unreviewed: return "circle.dashed"
        case .verified: return "checkmark.circle.fill"
        case .flagged: return "flag.fill"
        }
    }
}

private struct CaptionWaveformStrip: View {
    let peaks: [Double]
    let loopStartSeconds: Double
    let loopEndSeconds: Double
    let currentSeconds: Double
    let fps: Double
    @Binding var captionStartFrame: Int
    @Binding var captionEndFrame: Int
    @State private var startDragOriginFrame: Int?
    @State private var endDragOriginFrame: Int?

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let duration = max(loopEndSeconds - loopStartSeconds, 0.001)
            let captionStartSeconds = Double(captionStartFrame) / max(fps, 1)
            let captionEndSeconds = Double(captionEndFrame) / max(fps, 1)
            let captionStartX = xPosition(captionStartSeconds, duration: duration, width: size.width)
            let captionEndX = xPosition(captionEndSeconds, duration: duration, width: size.width)
            ZStack {
                Canvas { context, canvasSize in
                    let playheadX = xPosition(currentSeconds, duration: duration, width: canvasSize.width)

                    context.fill(
                        Path(CGRect(
                            x: captionStartX,
                            y: 0,
                            width: max(1, captionEndX - captionStartX),
                            height: canvasSize.height
                        )),
                        with: .color(.accentColor.opacity(0.14))
                    )

                    if peaks.isEmpty {
                        context.draw(
                            Text("波形を読み込んでいます...")
                                .font(.caption2)
                                .foregroundStyle(.secondary),
                            at: CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
                        )
                    } else {
                        let columnWidth = canvasSize.width / CGFloat(peaks.count)
                        for (index, peak) in peaks.enumerated() {
                            let height = max(1, min(1, peak) * Double(canvasSize.height - 8))
                            let x = CGFloat(index) * columnWidth + columnWidth * 0.2
                            let y = (canvasSize.height - CGFloat(height)) / 2
                            context.fill(
                                Path(CGRect(
                                    x: x,
                                    y: y,
                                    width: max(1, columnWidth * 0.6),
                                    height: CGFloat(height)
                                )),
                                with: .color(.secondary.opacity(0.72))
                            )
                        }
                    }

                    var captionStartPath = Path()
                    captionStartPath.move(to: CGPoint(x: captionStartX, y: 0))
                    captionStartPath.addLine(to: CGPoint(x: captionStartX, y: canvasSize.height))
                    context.stroke(captionStartPath, with: .color(.accentColor), lineWidth: 1.5)

                    var captionEndPath = Path()
                    captionEndPath.move(to: CGPoint(x: captionEndX, y: 0))
                    captionEndPath.addLine(to: CGPoint(x: captionEndX, y: canvasSize.height))
                    context.stroke(captionEndPath, with: .color(.accentColor), lineWidth: 1.5)

                    var playheadPath = Path()
                    playheadPath.move(to: CGPoint(x: playheadX, y: 0))
                    playheadPath.addLine(to: CGPoint(x: playheadX, y: canvasSize.height))
                    context.stroke(playheadPath, with: .color(.primary), lineWidth: 1)
                }

                timingHandle(label: "IN", frame: captionStartFrame)
                    .position(x: handlePosition(captionStartX, width: size.width), y: size.height / 2)
                    .gesture(startHandleGesture(width: size.width, duration: duration))
                    .accessibilityAdjustableAction { direction in
                        adjustStartFrame(direction)
                    }

                timingHandle(label: "OUT", frame: captionEndFrame)
                    .position(x: handlePosition(captionEndX, width: size.width), y: size.height / 2)
                    .gesture(endHandleGesture(width: size.width, duration: duration))
                    .accessibilityAdjustableAction { direction in
                        adjustEndFrame(direction)
                    }
            }
        }
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 6))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.secondary.opacity(0.22), lineWidth: 1)
        )
        .accessibilityLabel("発話前後の音声波形。青いINとOUTハンドルをドラッグして字幕表示区間を調整できます")
    }

    private func xPosition(_ seconds: Double, duration: Double, width: CGFloat) -> CGFloat {
        let progress = min(1, max(0, (seconds - loopStartSeconds) / duration))
        return width * CGFloat(progress)
    }

    private func handlePosition(_ position: CGFloat, width: CGFloat) -> CGFloat {
        min(max(9, position), max(9, width - 9))
    }

    private func timingHandle(label: String, frame: Int) -> some View {
        VStack(spacing: 1) {
            Text(label)
                .font(.system(size: 7, weight: .bold, design: .monospaced))
            Capsule()
                .fill(Color.accentColor)
                .frame(width: 6, height: 27)
        }
        .foregroundStyle(.primary)
        .frame(width: 18, height: 44)
        .contentShape(Rectangle())
        .help("\(label) \(frame)f：左右へドラッグ")
        .accessibilityElement()
        .accessibilityLabel("字幕\(label)点")
        .accessibilityValue("\(frame)フレーム")
        .onHover { hovering in
            (hovering ? NSCursor.resizeLeftRight : NSCursor.arrow).set()
        }
    }

    private func startHandleGesture(width: CGFloat, duration: Double) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if startDragOriginFrame == nil { startDragOriginFrame = captionStartFrame }
                let delta = CaptionWaveformTiming.frameDelta(
                    translationPoints: Double(value.translation.width),
                    widthPoints: Double(width),
                    loopDurationSeconds: duration,
                    fps: fps
                )
                captionStartFrame = CaptionWaveformTiming.clampedStartFrame(
                    (startDragOriginFrame ?? captionStartFrame) + delta,
                    endFrame: captionEndFrame,
                    loopStartFrame: loopStartFrame,
                    loopEndFrame: loopEndFrame
                )
            }
            .onEnded { _ in startDragOriginFrame = nil }
    }

    private func endHandleGesture(width: CGFloat, duration: Double) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if endDragOriginFrame == nil { endDragOriginFrame = captionEndFrame }
                let delta = CaptionWaveformTiming.frameDelta(
                    translationPoints: Double(value.translation.width),
                    widthPoints: Double(width),
                    loopDurationSeconds: duration,
                    fps: fps
                )
                captionEndFrame = CaptionWaveformTiming.clampedEndFrame(
                    (endDragOriginFrame ?? captionEndFrame) + delta,
                    startFrame: captionStartFrame,
                    loopStartFrame: loopStartFrame,
                    loopEndFrame: loopEndFrame
                )
            }
            .onEnded { _ in endDragOriginFrame = nil }
    }

    private var loopStartFrame: Int {
        Int((loopStartSeconds * max(fps, 1)).rounded(.down))
    }

    private var loopEndFrame: Int {
        Int((loopEndSeconds * max(fps, 1)).rounded(.up))
    }

    private func adjustStartFrame(_ direction: AccessibilityAdjustmentDirection) {
        let delta = direction == .increment ? 1 : -1
        captionStartFrame = CaptionWaveformTiming.clampedStartFrame(
            captionStartFrame + delta,
            endFrame: captionEndFrame,
            loopStartFrame: loopStartFrame,
            loopEndFrame: loopEndFrame
        )
    }

    private func adjustEndFrame(_ direction: AccessibilityAdjustmentDirection) {
        let delta = direction == .increment ? 1 : -1
        captionEndFrame = CaptionWaveformTiming.clampedEndFrame(
            captionEndFrame + delta,
            startFrame: captionStartFrame,
            loopStartFrame: loopStartFrame,
            loopEndFrame: loopEndFrame
        )
    }
}

private struct CaptionActualSizeOverlay: View {
    let text: String
    let style: CaptionReviewPreviewStyle

    var body: some View {
        GeometryReader { geometry in
            let scale = geometry.size.height / 1080
            let fontSize = max(1, style.fontSizePx1080 * scale)
            let lineSpacing = max(0, (style.lineHeightPx1080 - style.fontSizePx1080) * scale)
            let outline = max(0.35, style.outlinePx1080 * scale)
            let bottomMargin = style.marginV1080 * scale

            Text(text)
                .font(.custom(style.fontFamily, size: fontSize).weight(style.fontWeight >= 700 ? .bold : .regular))
                .multilineTextAlignment(.center)
                .lineSpacing(lineSpacing)
                .foregroundStyle(.white)
                .shadow(color: .black, radius: 0, x: outline, y: outline)
                .shadow(color: .black, radius: 0, x: -outline, y: outline)
                .shadow(color: .black, radius: 0, x: outline, y: -outline)
                .shadow(color: .black, radius: 0, x: -outline, y: -outline)
                .frame(width: geometry.size.width * min(1, max(0.1, style.maxWidthRatio)))
                .position(
                    x: geometry.size.width / 2,
                    y: verticalPosition(
                        height: geometry.size.height,
                        contentHeight: max(fontSize, style.lineHeightPx1080 * scale * Double(max(1, text.split(separator: "\n", omittingEmptySubsequences: false).count))),
                        margin: bottomMargin
                    )
                )
                .lineLimit(3)
                .allowsHitTesting(false)
        }
        .accessibilityHidden(true)
    }

    private func verticalPosition(height: CGFloat, contentHeight: Double, margin: Double) -> CGFloat {
        switch style.alignment {
        case .bottomCenter:
            return max(0, height - CGFloat(margin) - CGFloat(contentHeight) / 2)
        case .center:
            return height / 2
        case .topCenter:
            return min(height, CGFloat(margin) + CGFloat(contentHeight) / 2)
        }
    }
}
