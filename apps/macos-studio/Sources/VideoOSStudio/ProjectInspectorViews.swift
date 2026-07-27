import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

struct ProjectPanel: View {
    @ObservedObject var model: StudioViewModel

    private var project: ProjectSummary? {
        model.selectedProject
    }

    private var previewReadinessLabel: String {
        if model.timelinePreviewDiagnostics.hasTimeline,
           model.timelinePreviewDiagnostics.previewMediaFilename == nil {
            return "プレビュー動画なし"
        }
        if model.timelinePreviewDiagnostics.previewAudioNeedsAttention {
            return "音声なしプレビュー"
        }
        if model.timelinePreviewDiagnostics.previewCoverageNeedsAttention {
            return "プレビュー不足"
        }
        if model.timelinePreviewDiagnostics.previewUsesCollapsedGapContract {
            return "空白詰めプレビュー"
        }
        if model.playbackContractStatus.state == .exact,
           model.timelinePreviewDiagnostics.editorialStructureNeedsAttention {
            return "照合済み・構成注意"
        }
        return model.playbackContractStatus.readinessLabel
    }

    private var previewBlocksApproval: Bool {
        model.timelinePreviewDiagnostics.previewCoverageNeedsAttention
            || model.timelinePreviewDiagnostics.previewAudioNeedsAttention
    }

    var body: some View {
        Form {
            Section("状態") {
                LabeledContent("プロジェクト", value: project?.name ?? "-")
                LabeledContent("ゲート", value: project?.stateLabel ?? "-")
                LabeledContent("タイムライン", value: project?.hasTimeline == true ? "あり" : "なし")
                LabeledContent("レビュー", value: project?.hasReview == true ? "あり" : "なし")
                Text("プロジェクト作成: \(model.projectInitializationStatus)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("ProjectPanel.ProjectInitializationStatus")
            }

            if model.selectedSurface == .package {
                DeliveryQuickActionsSection(model: model, project: project)
            }

            Section("目的達成カバレッジ") {
                LabeledContent("状態", value: localizedStudioLabel(model.studioGoalStatus.readinessLabel))
                LabeledContent("スコア", value: model.studioGoalStatus.scoreLabel)
                Text(localizedStudioText(model.studioGoalStatus.nextAction))
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
                            Text(localizedStudioLabel(requirement.statusLabel))
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

            Section("Studio準備状況") {
                LabeledContent("状態", value: localizedStudioLabel(model.studioReadinessStatus.readinessLabel))
                LabeledContent("スコア", value: model.studioReadinessStatus.scoreLabel)
                LabeledContent("Marlin既定ゲート", value: localizedStudioLabel(model.studioReadinessStatus.marlinDefaultLabel))
                Text(model.studioReadinessStatus.marlinDefaultDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(localizedStudioText(model.studioReadinessStatus.marlinDefaultNextAction))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(localizedStudioText(model.studioReadinessStatus.nextAction))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let command = model.studioReadinessStatus.nextCommand {
                    Text(command)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                if let primaryAction = model.studioReadinessStatus.primaryAction {
                    VStack(alignment: .leading, spacing: 6) {
                        Label(primaryAction.title, systemImage: primaryAction.isBlocking ? "exclamationmark.circle.fill" : "arrow.right.circle.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(primaryAction.isBlocking ? .orange : .secondary)
                        Text(localizedStudioText(primaryAction.action))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                        Button {
                            model.performStudioReadinessAction(primaryAction)
                        } label: {
                            Label("\(primaryAction.title)を\(model.studioReadinessActionButtonTitle(primaryAction))", systemImage: "play.circle.fill")
                                .frame(maxWidth: .infinity, alignment: .center)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(!model.canPerformStudioReadinessAction(primaryAction))
                        .accessibilityIdentifier("ProjectPanel.PrimaryActionRunButton.\(primaryAction.id)")
                        if let reason = model.studioReadinessActionDisabledReason(primaryAction) {
                            Text(reason)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .accessibilityIdentifier("ProjectPanel.PrimaryActionDisabledReason.\(primaryAction.id)")
                        }
                    }
                }
                ForEach(model.studioReadinessStatus.capabilities, id: \.id) { capability in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: capability.isReady ? "checkmark.circle.fill" : "circle.dotted")
                            .foregroundStyle(capability.isReady ? .green : .secondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(capability.title)
                                .font(.caption)
                            Text(localizedStudioLabel(capability.readinessLabel))
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
                    Text("アクションキュー")
                        .font(.caption.weight(.semibold))
                    Text(localizedStudioStatusText(model.studioReadinessActionStatus))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .accessibilityIdentifier("ProjectPanel.ActionQueueStatus")
                    ForEach(model.studioReadinessStatus.actionQueue) { action in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(action.title)
                                    .font(.caption)
                                Spacer()
                                Text(action.isBlocking ? "必須" : "推奨")
                                    .font(.caption2)
                                    .foregroundStyle(action.isBlocking ? .orange : .secondary)
                            }
                            Text(localizedStudioText(action.action))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                            if let command = action.command {
                                Text(command)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .accessibilityIdentifier("ProjectPanel.ActionQueueCommand.\(action.id)")
                                if command.contains("agent-prompt") {
                                    Text("Codexコンテキスト: \(model.activeAgentRAGContextSummary)")
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
                                .accessibilityIdentifier("ProjectPanel.ActionQueueRunButton.\(action.id)")

                                Button {
                                    model.copyStudioReadinessActionCommand(action)
                                } label: {
                                    Label("コピー", systemImage: "doc.on.doc")
                                }
                                .controlSize(.small)
                                .disabled(action.command == nil)
                                .accessibilityIdentifier("ProjectPanel.ActionQueueCopyButton.\(action.id)")

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

            Section("パイプラインゲート") {
                LabeledContent("状態", value: localizedStudioLabel(model.pipelineGateStatus.readinessLabel))
                LabeledContent("現在状態", value: model.pipelineGateStatus.currentState ?? "-")
                LabeledContent("レンダー", value: localizedStudioLabel(model.pipelineGateStatus.renderReadinessLabel))
                if !model.pipelineGateStatus.gateSummaryLabel.isEmpty {
                    Text(model.pipelineGateStatus.gateSummaryLabel)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Text(localizedStudioText(model.pipelineGateStatus.nextAction))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("プレビュー照合") {
                LabeledContent("状態", value: previewReadinessLabel)
                LabeledContent("プレビュー", value: model.timelinePreviewDiagnostics.previewCoverageLabel)
                LabeledContent("再生媒体", value: model.timelinePreviewDiagnostics.previewSourceLabel)
                LabeledContent("構成", value: model.timelinePreviewDiagnostics.trackCompositionLabel)
                LabeledContent("候補素材", value: model.timelinePreviewDiagnostics.candidatePoolLabel)
                LabeledContent("切り替え", value: model.timelinePreviewDiagnostics.transitionLabel)
                LabeledContent("繰り返し", value: model.timelinePreviewDiagnostics.repeatRiskLabel)
                if previewBlocksApproval {
                    Text("manifestは現在のtimeline.json由来ですが、実際に再生しているプレビュー動画は承認判断に足りません。")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("ProjectPanel.PlaybackContractRecommendation")
                } else {
                    Text(model.playbackContractStatus.recommendation)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("ProjectPanel.PlaybackContractRecommendation")
                }
                Text(model.timelinePreviewDiagnostics.recommendation)
                    .font(.caption)
                    .foregroundStyle(
                        previewBlocksApproval
                        || model.timelinePreviewDiagnostics.previewUsesCollapsedGapContract
                        || model.timelinePreviewDiagnostics.sameAssetAdjacentPairCount > 0
                        || model.timelinePreviewDiagnostics.sameAudioAssetAdjacentPairCount > 0
                        || model.timelinePreviewDiagnostics.editorialStructureNeedsAttention ? .orange : .secondary
                    )
                    .accessibilityIdentifier("ProjectPanel.TimelinePreviewDiagnosticsRecommendation")
            }

            Section("ライブラリ準備") {
                LabeledContent("状態", value: localizedStudioLabel(model.libraryReadinessStatus.readinessLabel))
                LabeledContent("素材", value: model.libraryReadinessStatus.mediaReady ? "準備済み" : "未リンク \(model.libraryReadinessStatus.mediaMissingCount)件 / プロキシ \(model.libraryReadinessStatus.mediaProxyNeededCount)件")
                LabeledContent("RAG", value: localizedRAGCoverageLabel(model.libraryReadinessStatus.ragCoverageLabel))
                LabeledContent("解析", value: model.libraryReadinessStatus.analysisReady ? "\(model.libraryReadinessStatus.segmentCount)セグメント" : "未完了")
                LabeledContent("Marlin", value: model.libraryReadinessStatus.marlinReady ? "\(model.libraryReadinessStatus.marlinEventCount + model.libraryReadinessStatus.marlinFindResultCount)シグナル" : "未評価")
                LabeledContent("音声", value: model.libraryReadinessStatus.audioReady ? "\(model.libraryReadinessStatus.audioEventCount + model.libraryReadinessStatus.audioStoryNodeCount + model.libraryReadinessStatus.bgmBeatCount)シグナル" : "未対応付け")
                LabeledContent("受け渡しメモ", value: model.libraryReadinessStatus.handoffAnnotationsExist ? "あり" : "なし")
                Text(localizedStudioText(model.libraryReadinessStatus.recommendation))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("計画") {
                LabeledContent("状態", value: localizedStudioLabel(model.planningStatus.readinessLabel))
                LabeledContent("意図", value: model.planningStatus.hasCreativeBrief ? "あり" : "なし")
                LabeledContent("解析", value: model.planningStatus.analysisReady ? "\(model.planningStatus.assetCount)素材 / \(model.planningStatus.segmentCount)セグメント" : "未完了")
                if model.planningStatus.dialogueEvidenceRequired {
                    LabeledContent("音声根拠", value: model.planningStatus.dialogueEvidenceReady ? "あり" : "不足")
                }
                LabeledContent("候補選定", value: model.planningStatus.hasSelects ? "あり" : "なし")
                LabeledContent("構成設計", value: model.planningStatus.hasBlueprint ? (model.planningStatus.isBlueprintFresh ? "あり" : "古い") : "なし")
                Text(localizedStudioText(model.planningStatus.recommendation))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let nextJob = model.planningStatus.nextAgentJob {
                    LabeledContent("次に実行", value: localizedAgentJobTitle(nextJob))
                    Button {
                        model.selectedJob = nextJob
                    } label: {
                        Label("\(localizedAgentJobTitle(nextJob))ジョブを選択", systemImage: nextJob.systemImage)
                    }
                }
            }

            Section("意図ブリーフ") {
                LabeledContent("状態", value: model.intentSummary.readinessLabel)
                LabeledContent("タイトル", value: model.intentSummary.displayTitle)
                LabeledContent("戦略", value: model.intentSummary.strategy ?? "-")
                LabeledContent("形式", value: model.intentSummary.format ?? "-")
                LabeledContent("尺", value: model.intentSummary.runtimeTargetSeconds.map { "\($0)s" } ?? "-")
                LabeledContent("自律度", value: model.intentSummary.autonomyLabel)
                if let message = model.intentSummary.primaryMessage {
                    LabeledContent("メッセージ", value: message)
                }
                if let audience = model.intentSummary.primaryAudience {
                    LabeledContent("対象", value: audience)
                }
                LabeledContent("必須", value: model.intentSummary.mustHave.prefix(3).joined(separator: ", "))
                LabeledContent("避けること", value: model.intentSummary.mustAvoid.prefix(3).joined(separator: ", "))
                LabeledContent("ブロッカー", value: "\(model.intentSummary.blockerCount)件 / 軽微 \(model.intentSummary.softBlockerCount)件")
                if !model.intentSummary.openBlockerQuestions.isEmpty {
                    Text(model.intentSummary.openBlockerQuestions.prefix(2).joined(separator: "\n"))
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Text(model.intentSummary.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("意図整合") {
                LabeledContent("状態", value: model.intentAlignmentStatus.readinessLabel)
                LabeledContent("カバレッジ", value: model.intentAlignmentStatus.coverageLabel)
                LabeledContent("レビュー", value: model.intentAlignmentStatus.reviewStatus ?? "-")
                LabeledContent("ブリーフ不一致", value: "\(model.intentAlignmentStatus.briefMismatchCount)")
                if !model.intentAlignmentStatus.mustHaveMissing.isEmpty {
                    LabeledContent("不足", value: model.intentAlignmentStatus.mustHaveMissing.prefix(3).joined(separator: ", "))
                }
                if !model.intentAlignmentStatus.mustAvoidAcknowledged.isEmpty {
                    LabeledContent("回避済み", value: model.intentAlignmentStatus.mustAvoidAcknowledged.prefix(3).joined(separator: ", "))
                }
                Text(model.intentAlignmentStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("レビュー") {
                LabeledContent("状態", value: model.reviewArtifactStatus.readinessLabel)
                LabeledContent("判定", value: model.reviewArtifactStatus.judgmentStatus ?? "-")
                LabeledContent("課題", value: model.reviewArtifactStatus.issueLabel)
                LabeledContent("不一致", value: model.reviewArtifactStatus.mismatchLabel)
                LabeledContent("パッチ", value: model.reviewArtifactStatus.patchLabel)
                if let goal = model.reviewArtifactStatus.recommendedGoal {
                    LabeledContent("次の見直し", value: goal)
                }
                Text(model.reviewArtifactStatus.recommendation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.runReviewAgentJob()
                } label: {
                    Label("Codexでレビュー実行", systemImage: "checklist.checked")
                }
                .disabled(project == nil || model.appServerStatus == .checking)
                Button {
                    model.compileSelectedProjectWithReviewPatch()
                } label: {
                    if model.isApplyingReviewPatch {
                        Label("レビュー修正を反映中", systemImage: "hourglass")
                    } else {
                        Label("レビュー修正を反映", systemImage: "arrow.triangle.2.circlepath")
                    }
                }
                .disabled(project == nil || model.isCompilingRoughCut || !model.reviewArtifactStatus.patchReadable || !model.roughCutCompilePlan.canRun)
                .accessibilityIdentifier("ProjectPanel.ApplyReviewPatchButton")
            }

            Section("素材解析") {
                LabeledContent("製品プロファイル", value: "interview-highlight")
                LabeledContent("文字起こし", value: model.analysisRunPlan.options.skipSTT ? "スキップ" : "実行")
                Text("インタビュー・セミナー・イベント収録から60〜180秒のハイライトを作る標準ルートです。別ジャンルは初回導線に表示せず、Briefで明示した場合のみ実験扱いで使用します。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("ProjectPanel.SpeechLedProfileDescription")
                LabeledContent("状態", value: model.analysisRunPlan.readinessLabel)
                LabeledContent("素材", value: "\(model.analysisRunPlan.sourceCount)")
                LabeledContent("スキップ", value: "\(model.analysisRunPlan.skippedSourceCount)")
                Text(model.analysisRunStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.runSelectedProjectAnalysis()
                } label: {
                    if model.isRunningAnalysis {
                        Label("素材を解析中", systemImage: "hourglass")
                    } else {
                        Label("素材解析を実行", systemImage: "waveform.and.magnifyingglass")
                    }
                }
                .disabled(project == nil || model.isRunningAnalysis || !model.analysisRunPlan.canRun)
                .accessibilityIdentifier("ProjectPanel.RunSourceAnalysisButton")
                DisclosureGroup("高度な実行情報") {
                    Text(model.analysisRunPlan.commandLine)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("ProjectPanel.SourceAnalysisCommandLine")
                }
            }

            Section("粗編集生成") {
                LabeledContent("状態", value: model.roughCutCompilePlan.readinessLabel)
                LabeledContent("タイムライン", value: project?.hasTimeline == true ? "あり" : "未生成")
                Text(model.roughCutCompileStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("ProjectPanel.RoughCutCompileStatus")
                Button {
                    model.compileSelectedProjectRoughCut()
                } label: {
                    if model.isCompilingPlainRoughCut {
                        Label("粗編集を生成中", systemImage: "hourglass")
                    } else {
                        Label("粗編集を生成", systemImage: "timeline.selection")
                    }
                }
                .disabled(project == nil || model.isCompilingRoughCut || !model.roughCutCompilePlan.canRun)
                .accessibilityIdentifier("ProjectPanel.CompileRoughCutButton")
                Text(model.roughCutCompilePlan.commandLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("ProjectPanel.RoughCutCompileCommandLine")
            }
        }
        .formStyle(.grouped)
    }
}

private struct DeliveryQuickActionsSection: View {
    @ObservedObject var model: StudioViewModel
    var project: ProjectSummary?

    var body: some View {
        Section("納品") {
            LabeledContent("最終動画", value: localizedStudioLabel(model.renderPackageStatus.readinessLabel))
            LabeledContent("書き出し", value: localizedStudioLabel(model.renderRunPlan.readinessLabel))
            LabeledContent("不足", value: missingDeliveryArtifactsLabel)
            LabeledContent("QA", value: renderQAValue)
            LabeledContent("QAチェック", value: "\(model.renderPackageStatus.qaCheckCount)件 / 失敗 \(model.renderPackageStatus.qaFailedCheckCount)件")
            if model.renderPackageStatus.layoutQAStatus != nil {
                LabeledContent("字幕・CTA", value: model.renderPackageStatus.layoutQAReviewSummary)
                if let issue = model.renderPackageStatus.layoutQAReviewItems.first {
                    Text("\(issue.timeRangeLabel)  \(issue.title)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("ProjectPanel.LayoutQAFirstIssue")
                    Text(issue.remediation)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("ProjectPanel.LayoutQAFirstRemediation")
                }
            }
            if model.renderPackageStatus.speechCadenceStatus != nil,
               model.renderPackageStatus.speechCadenceStatus != "not_applicable" {
                LabeledContent("音声テンポ", value: model.renderPackageStatus.speechCadenceReviewSummary)
                if let issue = model.renderPackageStatus.speechCadenceReviewItems.first {
                    Text("\(issue.timeRangeLabel)  \(issue.title) · \(issue.durationLabel)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("ProjectPanel.SpeechCadenceFirstIssue")
                    Text("\(issue.suggestedActionLabel)：\(issue.remediation)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("ProjectPanel.SpeechCadenceFirstRemediation")
                }
            }
            if model.renderPackageStatus.captionDeliveryStatus != nil,
               model.renderPackageStatus.captionDeliveryStatus != "not_applicable" {
                LabeledContent("字幕タイミング", value: model.renderPackageStatus.captionDeliveryReviewSummary)
                if let issue = model.renderPackageStatus.captionDeliveryReviewItems.first {
                    Text("\(issue.timeRangeLabel)  \(issue.title) · \(issue.measurementLabel)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("ProjectPanel.CaptionDeliveryFirstIssue")
                    Text("「\(issue.textExcerpt)」 \(issue.suggestedActionLabel)：\(issue.remediation)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("ProjectPanel.CaptionDeliveryFirstRemediation")
                }
            }
            LabeledContent("最終出力", value: outputAvailabilityLabel(model.renderPackageStatus.publishedFinalVideoExists))
            LabeledContent("宣材テロップ", value: localizedStudioLabel(model.promoFinishStatus.readinessLabel))
            LabeledContent("テロップ数", value: model.promoFinishStatus.subtitleSidecarExists ? "\(model.promoFinishStatus.captionCount)件" : "-")
            LabeledContent("宣材動画", value: outputAvailabilityLabel(model.promoFinishStatus.finishedVideoExists))
            LabeledContent("Premiere XML", value: localizedStudioLabel(model.handoffExportPlan?.readinessLabel ?? "未確認"))
            LabeledContent("編集者パケット", value: localizedStudioLabel(model.editorPacketPlan?.readinessLabel ?? "未確認"))
            LabeledContent("パケット検証", value: localizedStudioLabel(model.editorPacketVerificationStatus.readinessLabel))
            LabeledContent("パケット内ファイル", value: "\(model.editorPacketVerificationStatus.existingFileCount)/\(model.editorPacketVerificationStatus.manifestFileCount)")
            LabeledContent("最終素材", value: includedOrMissingLabel(model.editorPacketVerificationStatus.finalMediaIncluded))
            LabeledContent("最終音声", value: includedOrMissingLabel(model.editorPacketVerificationStatus.finalAudioIncluded))

            if let manifestSource = model.renderPackageStatus.manifestSourceOfTruth ?? model.renderPackageStatus.qaSourceOfTruth {
                LabeledContent("検証根拠", value: manifestSource)
            }
            if let output = model.handoffExportPlan?.outputURL {
                LabeledContent("XML出力先", value: output.lastPathComponent)
            }
            if let packet = model.editorPacketPlan?.packetURL {
                LabeledContent("パケット出力先", value: packet.lastPathComponent)
            }

            Text(localizedStudioStatusText(model.renderRunStatus))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .accessibilityIdentifier("ProjectPanel.DeliveryRenderStatus")
            Text(localizedStudioStatusText(model.promoFinishRunStatus))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .accessibilityIdentifier("ProjectPanel.DeliveryPromoFinishStatus")
            Text(localizedStudioStatusText(model.handoffExportStatus))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .accessibilityIdentifier("ProjectPanel.DeliveryHandoffStatus")
            Text(localizedStudioStatusText(model.editorPacketStatus))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .accessibilityIdentifier("ProjectPanel.DeliveryPacketStatus")
            Text(localizedStudioText(model.editorPacketVerificationStatus.recommendation))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .accessibilityIdentifier("ProjectPanel.DeliveryPacketRecommendation")

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    deliveryButtons
                }
                VStack(alignment: .leading, spacing: 8) {
                    deliveryButtons
                }
            }
        }
    }

    private var missingDeliveryArtifactsLabel: String {
        let missing = model.renderPackageStatus.missingRequiredArtifacts
        guard !missing.isEmpty else { return "なし" }
        return missing.map(localizedArtifactPath).joined(separator: " / ")
    }

    private var renderQAValue: String {
        guard model.renderPackageStatus.qaReportExists else { return "なし" }
        guard model.renderPackageStatus.qaReportReadable else { return "読み取り不可" }
        if model.renderPackageStatus.qaPassed == true { return "合格" }
        if model.renderPackageStatus.qaPassed == false { return "失敗" }
        return "未確認"
    }

    private func outputAvailabilityLabel(_ exists: Bool) -> String {
        exists ? "あり" : "なし"
    }

    private func includedOrMissingLabel(_ value: Bool) -> String {
        value ? "含む" : "不足"
    }

    @ViewBuilder
    private var deliveryButtons: some View {
        Button {
            model.runSelectedProjectRender()
        } label: {
            if model.isRunningRender {
                Label("最終動画を書き出し中", systemImage: "hourglass")
            } else {
                Label("最終動画を書き出し", systemImage: "film.stack")
            }
        }
        .controlSize(.small)
        .disabled(project == nil || model.isRunningRender || !model.renderRunPlan.canRun)
        .accessibilityIdentifier("ProjectPanel.DeliveryRenderButton")

        Button {
            model.runSelectedProjectPromoFinish()
        } label: {
            if model.isRunningPromoFinish {
                Label("テロップ仕上げ中", systemImage: "hourglass")
            } else {
                Label("テロップ仕上げ", systemImage: "captions.bubble")
            }
        }
        .controlSize(.small)
        .disabled(project == nil || model.isRunningPromoFinish || !model.promoFinishRunPlan.canRun)
        .accessibilityIdentifier("ProjectPanel.DeliveryPromoFinishButton")

        Button {
            model.revealPromoFinishInFinder()
        } label: {
            Label("宣材成果物", systemImage: "folder")
        }
        .controlSize(.small)
        .disabled(!model.promoFinishStatus.finishedVideoExists && !model.promoFinishStatus.subtitleSidecarExists)
        .accessibilityIdentifier("ProjectPanel.DeliveryRevealPromoFinishButton")

        Button {
            model.exportSelectedProjectPremiereXML()
        } label: {
            if model.isExportingPremiereXML {
                Label("XMLを書き出し中", systemImage: "hourglass")
            } else {
                Label("Premiere XML", systemImage: "square.and.arrow.up")
            }
        }
        .controlSize(.small)
        .disabled(project == nil || model.isExportingPremiereXML || model.handoffExportPlan?.canExportPremiereXML != true)
        .accessibilityIdentifier("ProjectPanel.DeliveryPremiereXMLButton")

        Button {
            model.exportSelectedProjectEditorPacket()
        } label: {
            if model.isExportingEditorPacket {
                Label("パケットを書き出し中", systemImage: "hourglass")
            } else {
                Label("編集者パケット", systemImage: "shippingbox")
            }
        }
        .controlSize(.small)
        .disabled(project == nil || model.isExportingEditorPacket || model.editorPacketPlan?.canExportPacket != true)
        .accessibilityIdentifier("ProjectPanel.DeliveryEditorPacketButton")

        Button {
            model.revealEditorPacketInFinder()
        } label: {
            Label("Finderで表示", systemImage: "folder")
        }
        .controlSize(.small)
        .disabled(model.editorPacketPlan == nil)
        .accessibilityIdentifier("ProjectPanel.DeliveryRevealPacketButton")
    }
}
