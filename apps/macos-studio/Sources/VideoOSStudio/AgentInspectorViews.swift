import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

struct InspectorPanel: View {
    @ObservedObject var model: StudioViewModel
    @State private var selectedTab: InspectorPanelTab = .agent

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                ForEach(InspectorPanelTab.allCases) { tab in
                    Button {
                        selectedTab = tab
                    } label: {
                        Label {
                            Text(tab.title)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        } icon: {
                            Image(systemName: tab.systemImage)
                        }
                            .font(.caption)
                            .frame(maxWidth: .infinity, minHeight: 30)
                            .contentShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(selectedTab == tab ? .primary : .secondary)
                    .background {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(selectedTab == tab ? Color(nsColor: .selectedControlColor).opacity(0.18) : .clear)
                    }
                    .accessibilityLabel(tab.title)
                    .accessibilityValue(selectedTab == tab ? "選択中" : "未選択")
                    .accessibilityIdentifier("InspectorTab.\(tab.rawValue)")
                    .help(tab.title)
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 6)

            Divider()

            SurfaceContextBanner(surface: model.selectedSurface)

            Divider()

            Group {
                switch selectedTab {
                case .agent:
                    AgentPanel(model: model)
                case .project:
                    ProjectPanel(model: model)
                case .clip:
                    ClipInspectorPanel(model: model)
                case .media:
                    MediaPanel(model: model)
                case .qa:
                    QADashboardPanel(model: model)
                }
            }
        }
        .onAppear {
            selectedTab = InspectorPanelTab.defaultTab(for: model.selectedSurface)
        }
        .onChange(of: model.selectedSurface) { _, surface in
            selectedTab = InspectorPanelTab.defaultTab(for: surface)
        }
    }
}

private struct SurfaceContextBanner: View {
    let surface: StudioAgentSurface

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: surface.systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text("右パネル: \(surface.rawValue)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text("表示中: \(surface.inspectorPanelLabel)パネル")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(surface.summaryText.replacingOccurrences(of: "右パネル: ", with: ""))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.35))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("InspectorSurfaceContextBanner")
    }
}

private enum InspectorPanelTab: String, CaseIterable, Identifiable {
    case agent = "Agent"
    case project = "Project"
    case clip = "Clip"
    case media = "Media"
    case qa = "QA"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .agent:
            return "エージェント"
        case .project:
            return "プロジェクト"
        case .clip:
            return "クリップ"
        case .media:
            return "素材"
        case .qa:
            return "QA"
        }
    }

    var systemImage: String {
        switch self {
        case .agent:
            return "sparkles"
        case .project:
            return "doc.text"
        case .clip:
            return "rectangle.on.rectangle"
        case .media:
            return "film.stack"
        case .qa:
            return "checkmark.diamond"
        }
    }

    static func defaultTab(for surface: StudioAgentSurface) -> InspectorPanelTab {
        switch surface {
        case .ingest, .triage:
            return .media
        case .intent, .blueprint, .compile:
            return .project
        case .review:
            return .qa
        case .package:
            return .project
        }
    }
}

struct AgentPanel: View {
    @ObservedObject var model: StudioViewModel

    var body: some View {
        Form {
            Section("Codex App Server") {
                LabeledContent("接続方式", value: model.appServerPlan.displayName)
                LabeledContent("状態", value: model.appServerStatus.localizedLabel)
                if let activeThreadID = model.activeThreadID {
                    LabeledContent("スレッド", value: activeThreadID)
                }
                if let activeModel = model.activeModel {
                    LabeledContent("モデル", value: activeModel)
                }
                LabeledContent("作業フォルダ", value: model.repositoryRoot.path)
                LabeledContent("起動コマンド", value: model.appServerPlan.environmentDescription)
                Text(model.appServerDetail)
                    .font(.caption)
                    .foregroundStyle(model.appServerStatus == .failed ? .red : .secondary)
                Button {
                    model.checkAppServer()
                } label: {
                    Label("接続を確認", systemImage: "bolt.horizontal.circle")
                }
                .accessibilityIdentifier("AgentPanel.CheckConnectionButton")
                .disabled(model.appServerStatus == .checking)
                Button {
                    model.startAgentSession()
                } label: {
                    Label("セッション開始", systemImage: "play.circle")
                }
                .accessibilityIdentifier("AgentPanel.StartSessionButton")
                .disabled(model.appServerStatus == .checking || model.activeThreadID != nil)
                Button {
                    model.stopAgentSession()
                } label: {
                    Label("セッション停止", systemImage: "stop.circle")
                }
                .accessibilityIdentifier("AgentPanel.StopSessionButton")
                .disabled(model.activeThreadID == nil)
            }

            Section("現在の工程") {
                LabeledContent("工程", value: model.selectedSurface.rawValue)
                LabeledContent("コマンド", value: model.selectedSurface.commandName)
                Text("Codexは判断と提案を担当します。タイムライン、レンダー、パッケージ、検証の確定書き込みは決定的エンジンが担当します。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("エージェント実行") {
                Picker("ジョブ", selection: $model.selectedJob) {
                    ForEach(VideoOSAgentJob.allCases) { job in
                        Label(localizedAgentJobTitle(job), systemImage: job.systemImage)
                            .accessibilityIdentifier("AgentPanel.JobOption.\(job.rawValue)")
                            .tag(job)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("AgentPanel.JobPicker")

                Button {
                    model.runSelectedJob()
                } label: {
                    Label(model.selectedJob.requiresOperatorApproval ? "書き込み計画を確認" : "ジョブを実行", systemImage: model.selectedJob.systemImage)
                }
                .accessibilityIdentifier("AgentPanel.RunSelectedJobButton")
                .disabled(!model.selectedJobCanRun)

                LabeledContent("サンドボックス", value: localizedSandboxLabel(model.selectedJob.sandboxLabel))
                LabeledContent("参照コンテキスト", value: model.activeAgentRAGContextSummary)
                Text(localizedStudioText(model.selectedJobReadinessLabel))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("AgentPanel.JobReadinessLabel")
                AgentWriteContractSummary(
                    contract: model.selectedJob.writeContract(projectID: model.selectedProject?.id ?? "<id>"),
                    showForbidden: model.selectedJob.requiresOperatorApproval
                )

                if let approval = model.pendingApproval {
                    PendingApprovalCard(approval: approval, model: model)
                }

                if model.selectedJob.showsTimelineConsultationControls {
                    Picker("相談内容", selection: $model.selectedTimelineAgentIntent) {
                        ForEach(TimelineAgentConsultationIntent.allCases) { intent in
                            Text(intent.localizedTitle)
                                .tag(intent)
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("AgentPanel.TimelineConsultationIntentPicker")
                    LabeledContent("対象", value: model.timelineAgentSelectionLabel)
                        .accessibilityIdentifier("AgentPanel.TimelineConsultationTarget")
                    VStack(alignment: .leading, spacing: 4) {
                        Label("相談プレビュー", systemImage: "scope")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(model.timelineAgentConsultationPreviewLabel)
                            .font(.caption)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("AgentPanel.TimelineConsultationPreview")
                        Text(model.timelineAgentConsultationContractLabel)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("AgentPanel.TimelineConsultationContract")
                    }
                    HStack(spacing: 8) {
                        Button {
                            model.prepareTimelineSelectionAgentPrompt()
                        } label: {
                            Label("プロンプトへ", systemImage: "sparkles")
                        }
                        .help("選択中のクリップまたはトランジションから読み取り専用の相談プロンプトを作成")
                        .accessibilityIdentifier("AgentPanel.PrepareTimelineSelectionPromptButton")
                        .disabled(!model.canPrepareTimelineAgentPrompt)

                        Button {
                            model.prepareAndRunTimelineSelectionAgentPrompt()
                        } label: {
                            Label("相談を実行", systemImage: "paperplane.circle")
                        }
                        .help("選択範囲の相談プロンプトを作成し、Agentセッションがあれば読み取り専用で実行")
                        .accessibilityIdentifier("AgentPanel.RunTimelineSelectionConsultationButton")
                        .disabled(!model.canPrepareTimelineAgentPrompt || model.appServerStatus == .checking)
                    }
                }

                if model.selectedJob.showsFreeformPromptControls {
                    TextEditor(text: $model.agentPrompt)
                        .font(.body)
                        .frame(minHeight: 72)
                        .accessibilityIdentifier("AgentPanel.PromptEditor")
                    Button {
                        model.runAgentTurn()
                    } label: {
                        Label("読み取り専用で実行", systemImage: "paperplane")
                    }
                    .accessibilityIdentifier("AgentPanel.RunReadOnlyTurnButton")
                    .disabled(model.appServerStatus == .checking || model.activeThreadID == nil)
                }
                LabeledContent("状態", value: model.turnStatus)
                    .accessibilityIdentifier("AgentPanel.TurnStatus")
            }

            Section("実行結果") {
                if model.turnHistory.isEmpty {
                    Text(model.turnTranscript.isEmpty ? "完了した実行はまだありません。" : model.turnTranscript)
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
                                    Text(localizedAgentJobTitle(record.title))
                                        .lineLimit(1)
                                    Text("\(record.projectName) / \(localizedSandboxLabel(record.sandboxLabel)) / イベント \(record.events.count)件 / 差分 \(record.artifactDiffs.count)件 / 契約警告 \(record.writeViolations.count)件\(record.engineStatus == nil ? "" : " / エンジン")")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(localizedRunStatus(record.status))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if let record = model.selectedTurnRecord {
                TurnResultDetail(record: record, model: model)
            }
        }
        .formStyle(.grouped)
    }
}

private extension StudioViewModel.AppServerStatus {
    var localizedLabel: String {
        switch self {
        case .unchecked:
            return "未確認"
        case .checking:
            return "確認中"
        case .ready:
            return "接続済み"
        case .failed:
            return "失敗"
        }
    }
}

struct TurnResultDetail: View {
    let record: AgentTurnRecord
    @ObservedObject var model: StudioViewModel

    var body: some View {
        Section("選択中のターン") {
            LabeledContent("ターン", value: record.turnID)
            LabeledContent("ジョブ", value: localizedAgentJobTitle(record.title))
            LabeledContent("プロジェクト", value: record.projectName)
            LabeledContent("状態", value: localizedRunStatus(record.status))
            LabeledContent("サンドボックス", value: localizedSandboxLabel(record.sandboxLabel))
            LabeledContent("承認", value: record.approvalLabel)
            LabeledContent("所要時間", value: record.durationMs.map { "\($0) ms" } ?? "-")
            if let engineStatus = record.engineStatus {
                LabeledContent("ネイティブエンジン", value: engineStatus)
            }
            Button {
                model.pinSelectedAgentTurnToClipNoteDraft()
            } label: {
                Label("選択クリップのメモ下書きへ", systemImage: "pin")
            }
            .help("AI相談結果を読み取り専用の参考メモとして、選択クリップの編集メモ下書きへ追加します")
            .accessibilityIdentifier("AgentPanel.PinTurnToSelectedClipNoteButton")
            .disabled(!model.canPinSelectedAgentTurnToClipNoteDraft)

            if let draft = model.selectedAgentReviewPatchDraft {
                VStack(alignment: .leading, spacing: 6) {
                    Label("PREVIEW編集候補", systemImage: "doc.text.magnifyingglass")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                    LabeledContent("操作", value: draft.summaryLabel)
                        .font(.caption)
                        .accessibilityIdentifier("AgentPanel.ReviewPatchDraftSummary")
                    ForEach(draft.operationSummaries.prefix(4)) { operation in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(operation.operationName)
                                .font(.caption2.monospaced())
                                .foregroundStyle(operation.isCompilerReady ? Color.secondary : Color.orange)
                                .frame(width: 92, alignment: .leading)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(operation.targetLabel)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Text(operation.impactLabel)
                                    .font(.caption2)
                                    .foregroundStyle(operation.isCompilerReady ? Color.secondary : Color.orange)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                        }
                    }
                    if draft.operationSummaries.count > 4 {
                        Text("+\(draft.operationSummaries.count - 4)件の候補")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(Array(draft.warnings.enumerated()), id: \.offset) { _, warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .lineLimit(2)
                    }
                    if let plan = model.selectedAgentReviewPatchApplyPlan {
                        Label(plan.summaryLabel, systemImage: plan.canApply ? "checkmark.circle" : "exclamationmark.triangle")
                            .font(.caption2)
                            .foregroundStyle(plan.canApply ? Color.secondary : Color.orange)
                            .lineLimit(2)
                        if !plan.previewDiffs.isEmpty {
                            Label("反映前後", systemImage: "arrow.left.arrow.right")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                            ForEach(plan.previewDiffs.prefix(3)) { diff in
                                HStack(alignment: .firstTextBaseline, spacing: 6) {
                                    Text(diff.operationName)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                        .frame(width: 92, alignment: .leading)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(diff.targetLabel)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                        Text("\(diff.beforeLabel) → \(diff.afterLabel)")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                            .truncationMode(.middle)
                                    }
                                }
                            }
                            if plan.previewDiffs.count > 3 {
                                Text("+\(plan.previewDiffs.count - 3)件の差分")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        ForEach(Array(plan.blockedReasons.dropFirst().prefix(2).enumerated()), id: \.offset) { _, reason in
                            Label(reason, systemImage: "exclamationmark.triangle")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                                .lineLimit(2)
                        }
                    }
                    HStack(spacing: 8) {
                        Button {
                            model.applySelectedAgentReviewPatchDraftToTimeline()
                        } label: {
                            Label("Timelineへ表示反映", systemImage: "wand.and.stars")
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .help("AI編集候補を未保存のStudio編集としてTimelineとViewerへ反映")
                        .accessibilityIdentifier("AgentPanel.ApplyReviewPatchDraftButton")
                        .disabled(!model.canApplySelectedAgentReviewPatchDraftToTimeline)

                        Text("保存前")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    Text("まだtimeline.jsonには保存していません。")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("AgentPanel.ReviewPatchDraft")
            }

            if !record.plannedWriteScopes.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("承認済みの書き込み範囲")
                        .font(.caption.weight(.semibold))
                    ForEach(record.plannedWriteScopes, id: \.self) { scope in
                        Label(localizedContractArtifact(scope), systemImage: "doc.badge.gearshape")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .help(scope)
                    }
                }
            }

            if !record.writeViolations.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Label("書き込み契約の警告", systemImage: "exclamationmark.triangle")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                    ForEach(record.writeViolations) { violation in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(violation.relativePath)
                                .font(.caption)
                                .lineLimit(1)
                            Text("\(localizedArtifactDiffKind(violation.kind)): \(localizedWriteViolationReason(violation.reason))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
            }

            if !record.artifactDiffs.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("成果物差分プレビュー")
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
                                Text("差分 \(formatBytes(diff.byteDelta))")
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
                        Text("+\(record.artifactDiffs.count - 12)件の成果物変更")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            } else if !record.readOnly && record.approvedWrite {
                Text("正準成果物の変更は検出されませんでした。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if record.assistantText.isEmpty {
                Text("アシスタント本文はストリーミングされませんでした。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text(record.assistantText)
                    .font(.caption)
                    .textSelection(.enabled)
            }
        }

        Section("イベント履歴") {
            if record.events.isEmpty {
                Text(record.eventMethods.isEmpty ? "イベントは記録されていません。" : record.eventMethods.joined(separator: ", "))
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

extension ProjectArtifactDiff.Kind {
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

struct AgentWriteContractSummary: View {
    let contract: VideoOSAgentWriteContract
    var showForbidden: Bool = false

    var body: some View {
        DisclosureGroup("書き込み契約") {
            VStack(alignment: .leading, spacing: 6) {
                LabeledContent("モード", value: localizedContractMode(contract.modeLabel))
                LabeledContent("入口", value: contract.entrypoint)
                LabeledContent("コマンド", value: contract.commandContract ?? "-")

                artifactList("許可された出力先", values: contract.allowedArtifactRoots, emptyValue: "なし", valueFormatter: localizedContractArtifact)
                artifactList("期待される成果物", values: contract.expectedArtifacts, emptyValue: "なし", valueFormatter: localizedContractArtifact)

                if showForbidden {
                    artifactList("禁止された書き込み", values: contract.forbiddenWrites, emptyValue: "なし", systemImage: "xmark.octagon", valueFormatter: localizedForbiddenWrite)
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
        systemImage: String = "doc.badge.gearshape",
        valueFormatter: @escaping (String) -> String = { $0 }
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
            if values.isEmpty {
                Text(emptyValue)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(values, id: \.self) { value in
                    Label(valueFormatter(value), systemImage: systemImage)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .help(value)
                }
            }
        }
    }
}

struct PendingApprovalCard: View {
    let approval: AgentJobApproval
    @ObservedObject var model: StudioViewModel

    var body: some View {
        let contract = approval.job.writeContract(projectID: approval.projectID)

        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("オペレーター承認", systemImage: "exclamationmark.shield")
                    .font(.headline)
                    .accessibilityIdentifier("AgentPanel.PendingApprovalTitle")
                Spacer()
                Text(approval.projectName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("AgentPanel.PendingApprovalProject")
            }

            LabeledContent("ジョブ", value: localizedAgentJobTitle(approval.job))
                .accessibilityIdentifier("AgentPanel.PendingApprovalJob")
            LabeledContent("サンドボックス", value: localizedSandboxLabel(approval.job.sandboxLabel))
                .accessibilityIdentifier("AgentPanel.PendingApprovalSandbox")
            LabeledContent("RAGコンテキスト", value: approval.ragContextSummary)
                .accessibilityIdentifier("AgentPanel.PendingApprovalRAGContext")
            AgentWriteContractSummary(contract: contract, showForbidden: true)

            Text("Codexはゲートを確認し、この範囲外へ書き込む前に必ず停止する必要があります。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("AgentPanel.PendingApprovalWarning")

            HStack {
                Button(role: .cancel) {
                    model.cancelPendingJob()
                } label: {
                    Label("キャンセル", systemImage: "xmark.circle")
                }
                .accessibilityIdentifier("AgentPanel.PendingApprovalCancelButton")

                Button {
                    model.approvePendingJob()
                } label: {
                    Label("承認して実行", systemImage: "checkmark.shield")
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("AgentPanel.PendingApprovalApproveButton")
                .disabled(model.appServerStatus == .checking || model.activeThreadID == nil)
            }
        }
        .padding(10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }
}
