import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

struct MediaPanel: View {
    @ObservedObject var model: StudioViewModel
    @State private var isSourceBinCollectionDeleteConfirmationPresented = false

    private var project: ProjectSummary? {
        model.selectedProject
    }

    var body: some View {
        Form {
            Section("ライブラリ") {
                LabeledContent("状態", value: localizedStudioLabel(model.libraryReadinessStatus.readinessLabel))
                LabeledContent("素材ファイル", value: "\(project?.mediaFileCount ?? 0)")
                LabeledContent("解析済み素材", value: "\(model.libraryReadinessStatus.assetCount)")
                LabeledContent("セグメント", value: "\(model.libraryReadinessStatus.segmentCount)")
                LabeledContent("検索/RAG", value: localizedRAGCoverageLabel(model.libraryReadinessStatus.ragCoverageLabel))
                LabeledContent("タイムライン", value: availabilityLabel(model.libraryReadinessStatus.timelineExists))
                LabeledContent("映像解析の優先", value: "Marlin-2Bの時間理解 + 既存VLM")
                LabeledContent("音声解析の優先", value: "STT、話者分離、BGM、ビート")
                Text(localizedStudioText(model.libraryReadinessStatus.recommendation))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("音声ストーリーグラフ") {
                LabeledContent("音声シグナル", value: "\(model.libraryReadinessStatus.audioEventCount + model.libraryReadinessStatus.audioStoryNodeCount + model.libraryReadinessStatus.bgmBeatCount)")
                LabeledContent("ストーリーノード", value: "\(model.libraryReadinessStatus.audioStoryNodeCount)")
                LabeledContent("実行可否", value: localizedStudioLabel(model.audioStoryGraphRunPlan.readinessLabel))
                Text(localizedStudioStatusText(model.audioStoryGraphRunStatus))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.buildSelectedProjectAudioStoryGraph()
                } label: {
                    if model.isBuildingAudioStoryGraph {
                        Label("音声グラフを作成中", systemImage: "hourglass")
                    } else {
                        Label("音声ストーリーグラフを作成", systemImage: "waveform.path.ecg")
                    }
                }
                .disabled(project == nil || model.isBuildingAudioStoryGraph || !model.audioStoryGraphRunPlan.canRun)
                .accessibilityIdentifier("MediaPanel.BuildAudioStoryGraphButton")
                .help("音声ストーリーグラフを作成")
                Text(model.audioStoryGraphRunPlan.commandLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("MediaPanel.AudioStoryGraphCommandLine")
            }

            Section("Marlin評価") {
                LabeledContent("状態", value: localizedStudioLabel(model.marlinEvaluationStatus.readinessLabel))
                LabeledContent("モデル", value: model.marlinEvaluationStatus.modelLabel)
                LabeledContent("ポリシー", value: marlinPolicyValue(model.marlinEvaluationStatus))
                LabeledContent("イベント", value: "\(model.marlinEvaluationStatus.eventCount)件 / 検出 \(model.marlinEvaluationStatus.findResultCount)件")
                LabeledContent("カバレッジ", value: marlinCoverageValue(model.marlinEvaluationStatus))
                LabeledContent("優先VLM", value: model.marlinEvaluationStatus.canPreferMarlin ? "候補" : "未確定")
                LabeledContent("実行環境", value: "\(localizedStudioLabel(model.marlinRuntimeStatus.readinessLabel)) / \(model.marlinRuntimeStatus.resolvedDeviceLabel)")
                LabeledContent("HF認証", value: localizedStudioLabel(model.marlinAuthReadinessLabel))
                LabeledContent("モデルアクセス", value: model.marlinModelAccessStatus.isReadyForLiveMarlin ? "利用可" : "ブロック")
                LabeledContent("採用ゲート", value: localizedStudioLabel(model.marlinPreferenceDecision.decisionLabel))
                LabeledContent("リポジトリ根拠", value: marlinPreferenceValue(model.marlinPreferenceDecision))
                LabeledContent("代表プラン", value: localizedStudioLabel(model.marlinRepresentativePlan.readinessLabel))
                LabeledContent("代表バケット", value: "\(model.marlinRepresentativePlan.coveredBucketCount) / \(model.marlinRepresentativePlan.targetBucketCount)")
                LabeledContent("評価キュー", value: localizedStudioLabel(model.marlinEvaluationQueue.readinessLabel))
                LabeledContent("実行可能プロジェクト", value: "\(model.marlinEvaluationQueue.runnableProjectCount) / \(model.marlinEvaluationQueue.projectCount)")
                LabeledContent("実行プラン", value: "\(model.marlinEvaluationRunPlan.sourceCount)素材 / スキップ \(model.marlinEvaluationRunPlan.skippedSourceCount)")
                Text(localizedStudioText(model.marlinEvaluationStatus.recommendation))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.MarlinEvaluationRecommendation")
                Text(localizedStudioText(model.marlinPreferenceDecision.recommendation))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.MarlinPreferenceRecommendation")
                Text(localizedStudioText(model.marlinEvaluationQueue.nextAction))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.MarlinQueueNextAction")
                Text(localizedStudioText(model.marlinRepresentativePlan.nextAction))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.MarlinRepresentativeNextAction")
                ForEach(model.marlinRepresentativePlan.buckets) { bucket in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(localizedMarlinRepresentativeBucketLabel(bucket.label))
                                .font(.caption.weight(.semibold))
                            Text(localizedStudioText(bucket.rationale))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(localizedStudioLabel(bucket.readinessLabel))
                            .font(.caption2)
                            .foregroundStyle(bucket.isCovered ? Color.green : Color.secondary)
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("MediaPanel.MarlinRepresentativeBucket.\(bucket.id)")
                }
                ForEach(model.marlinEvaluationQueue.items.prefix(4)) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(item.id)
                                .font(.caption.weight(.semibold))
                            Spacer()
                            Text(localizedStudioLabel(item.priorityLabel))
                                .font(.caption2)
                                .foregroundStyle(item.canRunEvaluation ? Color.green : Color.secondary)
                        }
                        Text("素材 \(item.sourceCount)件、未リンク \(item.mediaMissingCount)件、カバレッジ \(item.coveredSegmentCount)/\(item.segmentCount)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(localizedStudioText(item.recommendation))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("MediaPanel.MarlinQueueItem.\(item.id)")
                }
                Text(localizedStudioStatusText(model.marlinEvaluationRunStatus))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.MarlinEvaluationRunStatus")
                HStack {
                    Button {
                        model.runSelectedProjectMarlinEvaluation()
                    } label: {
                        if model.isRunningMarlinEvaluation {
                            Label("Marlin評価を実行中", systemImage: "hourglass")
                        } else {
                            Label("Marlin評価を実行", systemImage: "sparkles.tv")
                        }
                    }
                    .disabled(project == nil || model.isRunningMarlinEvaluation || !model.marlinEvaluationRunPlan.canRun || !model.marlinRuntimeStatus.isReadyForLiveMarlin)
                    .accessibilityIdentifier("MediaPanel.RunMarlinEvaluationButton")
                    .help("Marlin評価を実行")

                    Button {
                        model.applyMarlinPreferencePolicy()
                    } label: {
                        Label("Marlin優先設定を適用", systemImage: "checkmark.seal")
                    }
                    .disabled(!model.marlinPreferenceDecision.canPreferMarlinAsDefault)
                    .accessibilityIdentifier("MediaPanel.ApplyMarlinPreferenceButton")
                    .help("Marlin優先設定を適用")
                }
                Text(model.marlinEvaluationRunPlan.commandLine())
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("MediaPanel.MarlinEvaluationCommandLine")
                Text(model.marlinEvaluationStatus.artifactURL.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .accessibilityIdentifier("MediaPanel.MarlinEvaluationArtifactPath")
            }

            Section("プレビュー準備") {
                LabeledContent("再生可能", value: "\(model.mediaPreviewSummary.readyCount)")
                LabeledContent("未リンク", value: "\(model.mediaPreviewSummary.missingCount)")
                LabeledContent("プロキシ必要", value: "\(model.mediaPreviewSummary.proxyNeededCount)")
                LabeledContent("仮素材プレビュー", value: "\(model.mediaPreviewSummary.syntheticPreviewCount)")
                LabeledContent("プロキシ作成予定", value: "\(model.mediaProxyPlan.pendingCount)")

                if let source = model.sourceMonitorMediaReference {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Label("ソースモニター", systemImage: "play.rectangle")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.orange)
                            Spacer()
                        }
                        SourceMonitorActionRow(model: model)
                        Text("\(source.assetID) / \(source.filename) / \(source.sourceRangeLabel)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .accessibilityIdentifier("MediaPanel.SourceMonitorStatus")
                        if let candidate = model.sourceMonitorInsertCandidateSummary {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    Label("追加候補", systemImage: "film")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(.primary)
                                    Text(candidate.positionLabel)
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                    Button {
                                        model.selectPreviousSourceMonitorCandidate()
                                    } label: {
                                        sourceCandidateNavigationLabel(systemImage: "chevron.left", shortcut: "[")
                                    }
                                    .buttonStyle(.borderless)
                                    .controlSize(.small)
                                    .disabled(!candidate.canSelectPrevious)
                                    .accessibilityIdentifier("MediaPanel.SourceCandidatePreviousButton")
                                    .help("前のselect候補 ([)")
                                    Button {
                                        model.selectNextSourceMonitorCandidate()
                                    } label: {
                                        sourceCandidateNavigationLabel(systemImage: "chevron.right", shortcut: "]")
                                    }
                                    .buttonStyle(.borderless)
                                    .controlSize(.small)
                                    .disabled(!candidate.canSelectNext)
                                    .accessibilityIdentifier("MediaPanel.SourceCandidateNextButton")
                                    .help("次のselect候補 (])")
                                }
                                Text("\(candidate.segmentID) / \(candidate.roleLabel) / \(candidate.sourceRangeLabel) / \(candidate.durationLabel) / \(candidate.targetTrackID) / \(candidate.confidenceLabel)")
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                    .accessibilityIdentifier("MediaPanel.SourceCandidateSummary")
                                SourceTimelineDragChip(
                                    segmentID: candidate.segmentID,
                                    roleLabel: candidate.roleLabel,
                                    targetTrackID: candidate.targetTrackID,
                                    sourceRangeLabel: candidate.markedRangeLabel,
                                    durationLabel: candidate.markedDurationLabel,
                                    confidenceLabel: candidate.confidenceLabel,
                                    isCompact: false,
                                    accessibilityIdentifier: "MediaPanel.SourceCandidateDragChip"
                                )
                                SourceMarkedRangeScrubber(
                                    candidate: candidate,
                                    onDragMarkIn: { normalizedPosition in
                                        model.dragSourceMonitorMark(.inPoint, normalizedPosition: normalizedPosition)
                                    },
                                    onDragMarkOut: { normalizedPosition in
                                        model.dragSourceMonitorMark(.outPoint, normalizedPosition: normalizedPosition)
                                    }
                                )
                                SourceMarkedRangeControls(
                                    candidate: candidate,
                                    onMarkIn: {
                                        model.markSourceMonitorInAtPlaybackTime()
                                    },
                                    onMarkOut: {
                                        model.markSourceMonitorOutAtPlaybackTime()
                                    },
                                    onNudgeMarkInEarlier: {
                                        model.nudgeSourceMonitorMarkIn(by: -500_000)
                                    },
                                    onNudgeMarkInLater: {
                                        model.nudgeSourceMonitorMarkIn(by: 500_000)
                                    },
                                    onNudgeMarkOutEarlier: {
                                        model.nudgeSourceMonitorMarkOut(by: -500_000)
                                    },
                                    onNudgeMarkOutLater: {
                                        model.nudgeSourceMonitorMarkOut(by: 500_000)
                                    },
                                    onReset: {
                                        model.resetSourceMonitorMarkedRange()
                                    }
                                )
                                Text(candidate.reason)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                                    .accessibilityIdentifier("MediaPanel.SourceCandidateReason")
                            }
                            .padding(6)
                            .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                            .onDrag {
                                NSItemProvider(object: StudioDragPayload.sourceCandidate(
                                    assetID: source.assetID,
                                    candidateID: candidate.candidateID
                                ) as NSString)
                            }
                            .help("候補カードをタイムラインへドラッグすると、長さghostを見ながらその位置へ追加できます")
                            .accessibilityIdentifier("MediaPanel.SourceCandidateCard")
                        } else if model.sourceMonitorAssetID != nil {
                            Text("追加できるselect候補はまだ読み込まれていません。")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("MediaPanel.SourceCandidateEmpty")
                        }
                    }
                    .padding(.vertical, 3)
                }

                if model.mediaPreviewSummary.items.isEmpty {
                    Text("素材解析を実行するか assets.json を読み込むと、素材ごとのプレビュー準備状況を確認できます。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    HStack(spacing: 6) {
                        Label("表示", systemImage: "line.3.horizontal.decrease.circle")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Picker("素材表示", selection: $model.mediaSourceBinFilter) {
                            ForEach(ProjectMediaSourceBinFilter.allCases) { filter in
                                Text(sourceBinFilterLabel(
                                    filter,
                                    count: model.mediaPreviewSummary.count(
                                        matching: filter,
                                        manualAssetIDs: model.mediaSourceBinManualAssetIDs,
                                        collectionAssetIDs: model.mediaSourceBinActiveCollectionAssetIDs,
                                        favoriteAssetIDs: model.mediaSourceBinFavoriteAssetIDs,
                                        usedAssetIDs: model.mediaSourceBinUsedAssetIDs
                                    )
                                ))
                                    .tag(filter)
                            }
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                        .frame(width: 132)
                        .help("素材表示条件を変更")
                        .accessibilityLabel("素材表示")
                        .accessibilityIdentifier("MediaPanel.SourceBinFilter")
                        Text(sourceBinFilterLabel(model.mediaSourceBinFilter, count: model.mediaSourceBinFilterBaseCount))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .accessibilityIdentifier("MediaPanel.SourceBinFilterSummary")
                        Spacer(minLength: 0)
                    }

                    HStack(spacing: 6) {
                        Label("選別bin", systemImage: "rectangle.stack")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Picker(
                            "選別bin",
                            selection: Binding(
                                get: { model.mediaSourceBinActiveCollectionLabel },
                                set: { model.selectSourceBinCollection($0) }
                            )
                        ) {
                            ForEach(model.mediaSourceBinCollectionNames, id: \.self) { name in
                                Text("\(name) (\(model.mediaSourceBinCollectionAssetCount(name)))")
                                    .tag(name)
                            }
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                        .frame(width: 118)
                        .help("保存済みの選別binを切り替え")
                        .accessibilityIdentifier("MediaPanel.SourceBinCollectionPicker")
                        Button {
                            model.moveActiveSourceBinCollectionEarlier()
                        } label: {
                            Label("上へ", systemImage: "arrow.up")
                                .labelStyle(.iconOnly)
                        }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .disabled(!model.canMoveActiveMediaSourceBinCollectionEarlier)
                        .help("\(model.mediaSourceBinActiveCollectionLabel)を前へ移動")
                        .accessibilityLabel("\(model.mediaSourceBinActiveCollectionLabel)を前へ移動")
                        .accessibilityIdentifier("MediaPanel.SourceBinCollectionMoveEarlierButton")
                        Button {
                            model.moveActiveSourceBinCollectionLater()
                        } label: {
                            Label("下へ", systemImage: "arrow.down")
                                .labelStyle(.iconOnly)
                        }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .disabled(!model.canMoveActiveMediaSourceBinCollectionLater)
                        .help("\(model.mediaSourceBinActiveCollectionLabel)を後ろへ移動")
                        .accessibilityLabel("\(model.mediaSourceBinActiveCollectionLabel)を後ろへ移動")
                        .accessibilityIdentifier("MediaPanel.SourceBinCollectionMoveLaterButton")
                        Button {
                            model.createSourceBinCollection()
                        } label: {
                            Label("新規", systemImage: "plus")
                                .labelStyle(.iconOnly)
                        }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .help("新しい選別binを作成")
                        .accessibilityLabel("新しい選別binを作成")
                        .accessibilityIdentifier("MediaPanel.SourceBinCollectionCreateButton")
                        Button {
                            isSourceBinCollectionDeleteConfirmationPresented = true
                        } label: {
                            Label("削除", systemImage: "trash")
                                .labelStyle(.iconOnly)
                        }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .disabled(!model.canDeleteActiveMediaSourceBinCollection)
                        .help("\(model.mediaSourceBinActiveCollectionLabel)を削除")
                        .accessibilityLabel("\(model.mediaSourceBinActiveCollectionLabel)を削除")
                        .accessibilityIdentifier("MediaPanel.SourceBinCollectionDeleteButton")
                        .confirmationDialog(
                            "\(model.mediaSourceBinActiveCollectionLabel)を削除しますか？",
                            isPresented: $isSourceBinCollectionDeleteConfirmationPresented,
                            titleVisibility: .visible
                        ) {
                            Button("削除", role: .destructive) {
                                model.deleteActiveSourceBinCollection()
                            }
                            Button("キャンセル", role: .cancel) {}
                        } message: {
                            Text("この選別binの素材リストだけを削除します。素材ファイルやタイムラインは変更しません。")
                        }
                        Button {
                            model.mediaSourceBinFilter = .collection
                        } label: {
                            Label("表示", systemImage: "line.3.horizontal.decrease.circle")
                                .labelStyle(.iconOnly)
                        }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .help("\(model.mediaSourceBinActiveCollectionLabel)だけを表示")
                        .accessibilityLabel("\(model.mediaSourceBinActiveCollectionLabel)だけを表示")
                        .accessibilityIdentifier("MediaPanel.SourceBinCollectionFilterButton")
                        Text("\(model.mediaSourceBinActiveCollectionAssetIDs.count)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 18, alignment: .trailing)
                            .accessibilityIdentifier("MediaPanel.SourceBinCollectionCount")
                    }

                    HStack(spacing: 6) {
                        Image(systemName: "pencil")
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        TextField(
                            "選別A",
                            text: Binding(
                                get: { model.mediaSourceBinActiveCollectionName },
                                set: { model.renameActiveSourceBinCollection(to: $0) }
                            )
                        )
                            .textFieldStyle(.roundedBorder)
                            .lineLimit(1)
                            .accessibilityIdentifier("MediaPanel.SourceBinCollectionNameField")
                        Text(model.mediaSourceBinActiveCollectionLabel)
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .accessibilityIdentifier("MediaPanel.SourceBinCollectionActiveLabel")
                    }

                    HStack(spacing: 6) {
                        Image(systemName: "tag")
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        Picker(
                            "選別状態",
                            selection: Binding(
                                get: { model.mediaSourceBinActiveCollectionStatus },
                                set: { model.setActiveSourceBinCollectionStatus($0) }
                            )
                        ) {
                            ForEach(ProjectMediaSourceBinCollectionStatus.allCases, id: \.self) { status in
                                Text(sourceBinCollectionStatusLabel(status)).tag(status)
                            }
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                        .frame(width: 118)
                        .help("この選別binの編集上の状態を設定")
                        .accessibilityLabel("選別bin状態")
                        .accessibilityIdentifier("MediaPanel.SourceBinCollectionStatusPicker")
                        TextField(
                            "用途メモ",
                            text: Binding(
                                get: { model.mediaSourceBinActiveCollectionNote },
                                set: { model.setActiveSourceBinCollectionNote($0) }
                            )
                        )
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1)
                        .help("この選別binの用途や判断メモを保存")
                        .accessibilityIdentifier("MediaPanel.SourceBinCollectionNoteField")
                    }

                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        TextField("素材を検索", text: $model.mediaSourceBinQuery)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("MediaPanel.SourceBinSearchField")
                        if !model.mediaSourceBinQuery.isEmpty {
                            Button {
                                model.mediaSourceBinQuery = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                            }
                            .buttonStyle(.borderless)
                            .help("検索をクリア")
                            .accessibilityIdentifier("MediaPanel.SourceBinSearchClear")
                        }
                    }

                    HStack(spacing: 6) {
                        Picker("並び", selection: $model.mediaSourceBinSort) {
                            ForEach(ProjectMediaSourceBinSort.allCases) { sort in
                                Text(sourceBinSortLabel(sort)).tag(sort)
                            }
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                        .frame(width: 118)
                        .accessibilityIdentifier("MediaPanel.SourceBinSortPicker")
                        Picker("分類", selection: $model.mediaSourceBinGroupMode) {
                            ForEach(ProjectMediaSourceBinGroupMode.allCases) { groupMode in
                                Text(sourceBinGroupModeLabel(groupMode)).tag(groupMode)
                            }
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                        .frame(width: 118)
                        .accessibilityIdentifier("MediaPanel.SourceBinGroupModePicker")
                        Picker("表示形式", selection: $model.mediaSourceBinViewMode) {
                            ForEach(MediaSourceBinViewMode.allCases) { viewMode in
                                Label(sourceBinViewModeLabel(viewMode), systemImage: sourceBinViewModeIcon(viewMode))
                                    .labelStyle(.iconOnly)
                                    .tag(viewMode)
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(width: 78)
                        .help("Source Binの表示形式を切り替え")
                        .accessibilityLabel("Source Bin表示形式")
                        .accessibilityIdentifier("MediaPanel.SourceBinViewModePicker")
                        Spacer(minLength: 0)
                    }

                    let items = model.filteredMediaPreviewItems
                    let groups = model.groupedMediaPreviewItems
                    HStack {
                        Text("表示 \(items.count) / \(model.mediaSourceBinFilterBaseCount)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("MediaPanel.SourceBinResultCount")
                        Spacer()
                        Button {
                            model.addVisibleSourceBinItemsToActiveCollection()
                        } label: {
                            Label("表示中を選別binへ追加", systemImage: "plus.rectangle")
                                .labelStyle(.iconOnly)
                        }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .disabled(!model.canAddVisibleMediaSourceBinItemsToActiveCollection)
                        .help("現在表示中の素材を\(model.mediaSourceBinActiveCollectionLabel)へまとめて追加")
                        .accessibilityLabel("現在表示中の素材を\(model.mediaSourceBinActiveCollectionLabel)へまとめて追加")
                        .accessibilityIdentifier("MediaPanel.SourceBinCollectionBulkAddVisibleButton")
                        Button {
                            model.removeVisibleSourceBinItemsFromActiveCollection()
                        } label: {
                            Label("表示中を選別binから外す", systemImage: "minus.rectangle")
                                .labelStyle(.iconOnly)
                        }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .disabled(!model.canRemoveVisibleMediaSourceBinItemsFromActiveCollection)
                        .help("現在表示中の素材を\(model.mediaSourceBinActiveCollectionLabel)からまとめて外す")
                        .accessibilityLabel("現在表示中の素材を\(model.mediaSourceBinActiveCollectionLabel)からまとめて外す")
                        .accessibilityIdentifier("MediaPanel.SourceBinCollectionBulkRemoveVisibleButton")
                    }

                    if items.isEmpty {
                        Text("この表示条件に合う素材はありません。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("MediaPanel.SourceBinFilteredEmpty")
                    } else {
                        ScrollViewReader { sourceBinScrollProxy in
                            ForEach(groups) { group in
                                if model.mediaSourceBinGroupMode == .flat {
                                    sourceBinItems(for: group.items)
                                } else {
                                    VStack(alignment: .leading, spacing: 6) {
                                        HStack(spacing: 6) {
                                            Label(
                                                sourceBinGroupLabel(group),
                                                systemImage: sourceBinGroupIcon(group)
                                            )
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(.secondary)
                                            Spacer()
                                            Text("\(group.items.count)")
                                                .font(.caption2.monospacedDigit())
                                                .foregroundStyle(.secondary)
                                        }
                                        .accessibilityElement(children: .combine)
                                        .accessibilityLabel("\(sourceBinGroupLabel(group))、\(group.items.count)件")

                                        sourceBinItems(for: group.items)
                                    }
                                    .padding(.top, 4)
                                    .accessibilityIdentifier("MediaPanel.SourceBinGroup.\(accessibilitySuffix(for: group.id))")
                                }
                            }
                            .onAppear {
                                scrollSourceBinToSelectedAsset(
                                    proxy: sourceBinScrollProxy,
                                    groups: groups,
                                    animated: false
                                )
                            }
                            .onChange(of: model.sourceMonitorAssetID) { _, _ in
                                scrollSourceBinToSelectedAsset(
                                    proxy: sourceBinScrollProxy,
                                    groups: groups,
                                    animated: true
                                )
                            }
                            .onChange(of: model.mediaSourceBinFilter) { _, _ in
                                scrollSourceBinToSelectedAsset(
                                    proxy: sourceBinScrollProxy,
                                    groups: groups,
                                    animated: true
                                )
                            }
                            .onChange(of: model.mediaSourceBinQuery) { _, _ in
                                scrollSourceBinToSelectedAsset(
                                    proxy: sourceBinScrollProxy,
                                    groups: groups,
                                    animated: true
                                )
                            }
                        }
                    }
                }
            }

            Section("素材マップ") {
                let suggestedRoots = project.map { ProjectMediaRelinker.suggestedSearchRoots(projectURL: $0.path) } ?? []
                LabeledContent("状態", value: localizedStudioLabel(model.mediaSourceMapStatus.readinessLabel))
                    .help(model.mediaSourceMapStatus.readinessLabel)
                LabeledContent("カバレッジ", value: model.mediaSourceMapStatus.coverageLabel)
                LabeledContent("登録数", value: "\(model.mediaSourceMapStatus.entryCount)")
                LabeledContent("利用可能パス", value: "\(model.mediaSourceMapStatus.readyAssetCount)")
                LabeledContent("壊れた参照", value: "\(model.mediaSourceMapStatus.brokenEntries.count)")
                LabeledContent("再リンク済み", value: "\(model.mediaSourceMapStatus.relinkedSymlinkCount)")
                if let generatedAt = model.mediaSourceMapStatus.generatedAt {
                    LabeledContent("生成日時", value: generatedAt)
                }
                Text(localizedStudioText(model.mediaSourceMapStatus.recommendation))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                LabeledContent("対応表ファイル", value: model.mediaSourceMapStatus.sourceMapURL.lastPathComponent)
                Text(model.mediaSourceMapStatus.sourceMapURL.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if !suggestedRoots.isEmpty {
                    LabeledContent("候補フォルダ", value: "\(suggestedRoots.count)")
                    ForEach(suggestedRoots.prefix(4)) { root in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Label(root.exists ? "利用可能" : "見つからない", systemImage: root.exists ? "externaldrive.fill" : "externaldrive.badge.xmark")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(root.exists ? .green : .secondary)
                                Spacer()
                                Text("参照 \(root.referencedAssetCount)件")
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

            Section("素材の再リンク") {
                let suggestedRoots = project.map { ProjectMediaRelinker.suggestedSearchRoots(projectURL: $0.path) } ?? []
                Text(model.mediaRelinkStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.MediaRelinkStatus")

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Button {
                            model.chooseAndRelinkSelectedProjectMedia()
                        } label: {
                            if model.isRelinkingMedia {
                                Label("素材を再リンク中", systemImage: "hourglass")
                            } else {
                                Label("未リンク素材を再接続", systemImage: "link")
                            }
                        }
                        .disabled(project == nil || model.mediaPreviewSummary.missingCount == 0 || model.isRelinkingMedia)
                        .accessibilityIdentifier("MediaPanel.RelinkMissingMediaButton")
                        .help("未リンク素材を再接続")

                        Button {
                            model.relinkSelectedProjectMediaFromSourceMap()
                        } label: {
                            Label("素材マップの候補を使う", systemImage: "externaldrive.connected.to.line.below")
                        }
                        .disabled(project == nil || model.mediaPreviewSummary.missingCount == 0 || model.isRelinkingMedia || suggestedRoots.allSatisfy { !$0.exists })
                        .accessibilityIdentifier("MediaPanel.UseSourceMapRootsButton")
                        .help("素材マップの候補フォルダから再リンク")
                    }

                    Button {
                        model.chooseAndRelinkSelectedProjectMedia(includeSynthetic: true)
                    } label: {
                        Label("仮素材を実素材に置換", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(project == nil || model.mediaPreviewSummary.syntheticPreviewCount == 0 || model.isRelinkingMedia)
                    .accessibilityIdentifier("MediaPanel.ReplaceSyntheticMediaButton")
                    .help("仮素材を実素材に置換")
                }

                if let plan = model.mediaRelinkPlan {
                    LabeledContent("一致", value: "\(plan.matchedCount) / \(plan.missingAssetCount)")
                    LabeledContent("素材マップ", value: plan.sourceMapURL.lastPathComponent)
                    ForEach(plan.items.prefix(8)) { item in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Label(item.assetID, systemImage: item.candidateURL == nil ? "exclamationmark.circle" : "checkmark.circle")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(item.candidateURL == nil ? .orange : .green)
                                Spacer()
                                Text(item.matchedBy ?? "未一致")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(item.filename)
                                .font(.caption)
                                .lineLimit(1)
                            Text(item.candidateURL?.path ?? "選択した候補フォルダに一致するファイルがありません。")
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    if plan.items.count > 8 {
                        Text("+\(plan.items.count - 8)件の再リンク候補")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("仮素材と検証") {
                Text(model.syntheticMediaStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.SyntheticMediaStatus")

                Button {
                    model.buildSelectedProjectSyntheticMedia()
                } label: {
                    if model.isBuildingSyntheticMedia {
                        Label("仮素材を作成中", systemImage: "hourglass")
                    } else {
                        Label("仮素材を作成", systemImage: "wand.and.stars")
                    }
                }
                .disabled(project == nil || model.mediaSourceMapStatus.assetCount == 0 || model.isBuildingSyntheticMedia)
                .accessibilityIdentifier("MediaPanel.BuildDemoMediaButton")
                .help("仮素材を作成")

                Text("02_media/synthetic に短いローカル検証用動画を作成し、プレビューと納品QAで使えるように解析済み素材へ対応付けます。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Divider()

                Text(model.studioSyntheticSmokeStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.StudioSyntheticSmokeStatus")

                Button {
                    model.runStudioSyntheticSmoke()
                } label: {
                    if model.isRunningStudioSyntheticSmoke {
                        Label("Studioスモークを実行中", systemImage: "hourglass")
                    } else {
                        Label("Studioスモークを実行", systemImage: "checkmark.seal")
                    }
                }
                .disabled(model.isRunningStudioSyntheticSmoke)
                .accessibilityIdentifier("MediaPanel.RunStudioSmokeButton")
                .help("Studioスモークを実行")

                Text("選択中プロジェクトを変更せず、一時的な承認済みプロジェクトで最終動画と編集者パケットを検証します。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Divider()

                Text(model.studioAcceptanceSmokeStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.StudioAcceptanceSmokeStatus")

                Button {
                    model.runStudioAcceptanceSmoke()
                } label: {
                    if model.isRunningStudioAcceptanceSmoke {
                        Label("受け入れチェックを実行中", systemImage: "hourglass")
                    } else {
                        Label("受け入れチェックを実行", systemImage: "checkmark.shield")
                    }
                }
                .disabled(model.isRunningStudioAcceptanceSmoke)
                .accessibilityIdentifier("MediaPanel.RunAcceptanceSmokeButton")
                .help("受け入れチェックを実行")

                Text("Codex App Server接続と、一時プロジェクトのレンダー、パッケージ、編集者パケット確認をまとめて検証します。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Section("プロキシ作成計画") {
                Text(model.mediaProxyOperationStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.MediaProxyOperationStatus")

                Button {
                    model.buildSelectedProjectMediaProxies()
                } label: {
                    if model.isBuildingMediaProxies {
                        Label("プロキシを作成中", systemImage: "hourglass")
                    } else {
                        Label("プロキシを作成", systemImage: "film.stack")
                    }
                }
                .disabled(project == nil || model.mediaProxyPlan.pendingCount == 0 || model.isBuildingMediaProxies)
                .accessibilityIdentifier("MediaPanel.BuildProxiesButton")
                .help("プレビュー用プロキシを作成")

                if model.mediaProxyPlan.items.isEmpty {
                    Text("プレビュー用プロキシが必要な未対応素材はありません。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("MediaPanel.MediaProxyEmptyState")
                } else {
                    ForEach(model.mediaProxyPlan.items) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Label(item.assetID, systemImage: item.outputExists ? "checkmark.circle" : "film.stack")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(item.outputExists ? .green : .orange)
                                Spacer()
                                Text(item.outputExists ? "作成済み" : "未作成")
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
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("MediaPanel.MediaProxyPlanItem.\(item.assetID)")
                    }
                }
            }

            Section("最終動画パッケージ") {
                LabeledContent("状態", value: localizedStudioLabel(model.renderPackageStatus.readinessLabel))
                LabeledContent("実行可否", value: localizedStudioLabel(model.renderRunPlan.readinessLabel))
                LabeledContent("QA", value: renderQAValue(model.renderPackageStatus))
                LabeledContent("根拠", value: model.renderPackageStatus.manifestSourceOfTruth ?? model.renderPackageStatus.qaSourceOfTruth ?? "-")
                LabeledContent("チェック", value: "\(model.renderPackageStatus.qaCheckCount)件 / 失敗 \(model.renderPackageStatus.qaFailedCheckCount)件")
                if let createdAt = model.renderPackageStatus.manifestCreatedAt {
                    LabeledContent("作成日時", value: createdAt)
                }

                renderArtifactRow("最終動画", url: model.renderPackageStatus.publishedFinalVideoURL, exists: model.renderPackageStatus.publishedFinalVideoExists)
                renderArtifactRow("QAレポート", url: model.renderPackageStatus.qaReportURL, exists: model.renderPackageStatus.qaReportExists)
                renderArtifactRow("マニフェスト", url: model.renderPackageStatus.packageManifestURL, exists: model.renderPackageStatus.packageManifestExists)
                renderArtifactRow("最終ミックス", url: model.renderPackageStatus.finalMixURL, exists: model.renderPackageStatus.finalMixExists)

                Divider()

                LabeledContent("宣材テロップ", value: localizedStudioLabel(model.promoFinishStatus.readinessLabel))
                LabeledContent("仕上げ実行", value: localizedStudioLabel(model.promoFinishRunPlan.readinessLabel))
                LabeledContent("テロップ数", value: model.promoFinishStatus.subtitleSidecarExists ? "\(model.promoFinishStatus.captionCount)件" : "-")
                renderArtifactRow("宣材動画", url: model.promoFinishStatus.finishedVideoURL, exists: model.promoFinishStatus.finishedVideoExists)
                renderArtifactRow("テロップASS", url: model.promoFinishStatus.subtitleSidecarURL, exists: model.promoFinishStatus.subtitleSidecarExists)

                if !model.promoFinishStatus.missingRequiredArtifacts.isEmpty {
                    Text("宣材仕上げの不足: \(model.promoFinishStatus.missingRequiredArtifacts.map(localizedArtifactPath).joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Text(localizedStudioStatusText(model.promoFinishRunStatus))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.PromoFinishStatus")
                Button {
                    model.runSelectedProjectPromoFinish()
                } label: {
                    if model.isRunningPromoFinish {
                        Label("テロップ仕上げ中", systemImage: "hourglass")
                    } else {
                        Label("テロップ仕上げ", systemImage: "captions.bubble")
                    }
                }
                .disabled(project == nil || model.isRunningPromoFinish || !model.promoFinishRunPlan.canRun)
                .accessibilityIdentifier("MediaPanel.PromoFinishButton")
                Button {
                    model.revealPromoFinishInFinder()
                } label: {
                    Label("宣材成果物をFinderで表示", systemImage: "folder")
                }
                .disabled(!model.promoFinishStatus.finishedVideoExists && !model.promoFinishStatus.subtitleSidecarExists)
                .accessibilityIdentifier("MediaPanel.RevealPromoFinishButton")
                Text(model.promoFinishRunPlan.commandLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("MediaPanel.PromoFinishCommandLine")

                if !model.renderPackageStatus.missingRequiredArtifacts.isEmpty {
                    Text("不足: \(model.renderPackageStatus.missingRequiredArtifacts.map(localizedArtifactPath).joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Text(localizedStudioStatusText(model.renderRunStatus))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    model.runSelectedProjectRender()
                } label: {
                    if model.isRunningRender {
                        Label("最終動画を書き出し中", systemImage: "hourglass")
                    } else {
                        Label("最終動画を書き出し", systemImage: "film.stack")
                    }
                }
                .disabled(project == nil || model.isRunningRender || !model.renderRunPlan.canRun)
                .accessibilityIdentifier("MediaPanel.RenderFinalPackageButton")
                Text(model.renderRunPlan.commandLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityIdentifier("MediaPanel.RenderFinalPackageCommandLine")
            }

            Section("編集者への受け渡し") {
                LabeledContent("状態", value: localizedStudioLabel(model.handoffExportPlan?.readinessLabel ?? "未確認"))
                LabeledContent("クリップ注釈", value: "\(model.handoffExportPlan?.editorAnnotationNoteCount ?? 0)")
                LabeledContent("素材マップ", value: "\(model.handoffExportPlan?.sourceMapEntryCount ?? 0)件")
                LabeledContent("マップ状態", value: localizedStudioLabel(model.handoffExportPlan?.sourceMapReadinessLabel ?? "未確認"))
                LabeledContent("マップ網羅", value: model.handoffExportPlan?.sourceMapCoverageLabel ?? "-")
                LabeledContent("一時マップ", value: yesNoLabel(model.handoffExportPlan?.usesTemporarySourceMap == true))
                LabeledContent("生成マップ", value: "\(model.handoffExportPlan?.generatedSourceMapEntryCount ?? 0)件")
                LabeledContent("再リンク必要", value: "\(model.handoffExportPlan?.mediaMissingCount ?? 0)")
                if let annotationURL = model.editorAnnotationSummary?.url {
                    LabeledContent("注釈", value: annotationURL.lastPathComponent)
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
                Text(localizedStudioStatusText(model.handoffExportStatus))
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.exportSelectedProjectPremiereXML()
                } label: {
                    if model.isExportingPremiereXML {
                        Label("XMLを書き出し中", systemImage: "hourglass")
                    } else {
                        Label("Premiere XMLを書き出し", systemImage: "square.and.arrow.up")
                    }
                }
                .disabled(project == nil || model.isExportingPremiereXML || model.handoffExportPlan?.canExportPremiereXML != true)
                .accessibilityIdentifier("MediaPanel.ExportPremiereXMLButton")

                Divider()

                LabeledContent("編集者パケット", value: localizedStudioLabel(model.editorPacketPlan?.readinessLabel ?? "未確認"))
                LabeledContent("レビューレポート", value: includedLabel(model.editorPacketPlan?.reviewReportIncluded == true))
                LabeledContent("レビューパッチ", value: includedLabel(model.editorPacketPlan?.reviewPatchIncluded == true))
                LabeledContent("プレビュー/最終素材", value: "\(model.editorPacketPlan?.mediaIncludedCount ?? 0)ファイル")
                LabeledContent("パケット検証", value: localizedStudioLabel(model.editorPacketVerificationStatus.readinessLabel))
                LabeledContent("パケット内ファイル", value: "\(model.editorPacketVerificationStatus.existingFileCount)/\(model.editorPacketVerificationStatus.manifestFileCount)")
                LabeledContent("最終動画", value: includedOrMissingLabel(model.editorPacketVerificationStatus.finalMediaIncluded))
                LabeledContent("最終音声", value: includedOrMissingLabel(model.editorPacketVerificationStatus.finalAudioIncluded))
                if let packet = model.editorPacketPlan?.packetURL {
                    Text(packet.path)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(localizedStudioText(model.editorPacketVerificationStatus.recommendation))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(localizedStudioStatusText(model.editorPacketStatus))
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    model.exportSelectedProjectEditorPacket()
                } label: {
                    if model.isExportingEditorPacket {
                        Label("パケットを書き出し中", systemImage: "hourglass")
                    } else {
                        Label("編集者パケットを書き出し", systemImage: "shippingbox.and.arrow.backward")
                    }
                }
                .disabled(project == nil || model.isExportingEditorPacket || model.editorPacketPlan?.canExportPacket != true)
                .accessibilityIdentifier("MediaPanel.ExportEditorPacketButton")

                Button {
                    model.revealEditorPacketInFinder()
                } label: {
                    Label("パケットをFinderで表示", systemImage: "folder")
                }
                .disabled(model.editorPacketPlan == nil)
                .accessibilityIdentifier("MediaPanel.RevealEditorPacketButton")

                if let command = model.handoffExportPlan?.commandLine {
                    Text(command)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .accessibilityIdentifier("MediaPanel.HandoffCommandLine")
                }
            }

            Section("検索インデックス") {
                LabeledContent("状態", value: availabilityLabel(model.indexStatus.exists))
                LabeledContent("ドキュメント", value: "\(model.indexStatus.documentCount)")
                LabeledContent("更新日時", value: model.indexStatus.updatedAt ?? "-")
                Text(model.indexOperationStatus)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("MediaPanel.IndexOperationStatus")
                Button {
                    model.rebuildSelectedProjectIndex()
                } label: {
                    Label("インデックスを再構築", systemImage: "externaldrive.badge.plus")
                }
                .disabled(project == nil)
                .accessibilityIdentifier("MediaPanel.RebuildIndexButton")
            }

            Section("素材内検索") {
                HStack {
                    TextField("文字起こし、タグ、Marlinイベントを検索", text: $model.indexSearchQuery)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("MediaPanel.IndexSearchField")
                        .onSubmit {
                            model.searchSelectedProjectIndex()
                        }
                    Button {
                        model.searchSelectedProjectIndex()
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .disabled(model.indexSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("MediaPanel.IndexSearchButton")
                }

                Button {
                    model.appendIndexContextToAgentPrompt()
                } label: {
                    Label("検索結果をエージェントへ追加", systemImage: "text.badge.plus")
                }
                .disabled(model.indexContextPack.isEmpty)
                .accessibilityIdentifier("MediaPanel.AddRAGContextButton")

                if model.indexSearchResults.isEmpty {
                    Text("インデックスを作成すると、会話、映像タグ、音声の手がかり、Marlin説明文で検索できます。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("MediaPanel.IndexSearchEmptyState")
                } else {
                    Text("\(model.indexContextPack.items.count)件の根拠をCodexプロンプトに追加できます。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("MediaPanel.IndexContextSummary")
                    ForEach(model.indexSearchResults) { result in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(localizedEvidenceTag(result.kind))
                                    .font(.caption2.weight(.semibold))
                                    .help(result.kind)
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
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("MediaPanel.IndexSearchResult.\(result.id)")
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    private func renderQAValue(_ status: ProjectRenderPackageStatus) -> String {
        guard status.qaReportExists else { return "なし" }
        guard status.qaReportReadable else { return "読み取り不可" }
        if status.qaPassed == true { return "合格" }
        if status.qaPassed == false { return "失敗" }
        return "未確認"
    }

    private func availabilityLabel(_ exists: Bool) -> String {
        exists ? "あり" : "なし"
    }

    private func yesNoLabel(_ value: Bool) -> String {
        value ? "はい" : "いいえ"
    }

    private func includedLabel(_ value: Bool) -> String {
        value ? "含む" : "なし"
    }

    private func includedOrMissingLabel(_ value: Bool) -> String {
        value ? "含む" : "不足"
    }

    private func marlinPolicyValue(_ status: ProjectMarlinEvaluationStatus) -> String {
        let enabled = status.policyEnabled.map { $0 ? "有効" : "無効" } ?? "未確認"
        let mode = status.policyMode.map(localizedMarlinPolicyMode) ?? "未確認"
        let mock = status.policyMock == true ? "モック" : "ライブ"
        return "\(enabled) / \(mode) / \(mock)"
    }

    private func marlinCoverageValue(_ status: ProjectMarlinEvaluationStatus) -> String {
        guard status.segmentCount > 0 else { return "0/0 セグメント" }
        let percent = Int((status.coverageRatio * 100).rounded())
        return "\(status.segmentsWithMarlinPeakCount)/\(status.segmentCount) ピーク検出セグメント (\(percent)%)"
    }

    private func marlinPreferenceValue(_ decision: ProjectMarlinPreferenceDecision) -> String {
        let percent = Int((decision.aggregateCoverageRatio * 100).rounded())
        return "\(decision.candidateProjectCount)/\(decision.evaluatedProjectCount)プロジェクト、\(decision.representativeCandidateBucketCount)/\(decision.representativeTargetBucketCount)バケット、ピーク網羅 \(percent)%"
    }

    private func renderArtifactRow(_ title: String, url: URL, exists: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Label(title, systemImage: exists ? "checkmark.circle" : "circle.dashed")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(exists ? .green : .secondary)
                Spacer()
                Text(exists ? "あり" : "なし")
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

    private func sourceBinFilterName(_ filter: ProjectMediaSourceBinFilter) -> String {
        switch filter {
        case .all:
            return "全て"
        case .manual:
            return "作業中"
        case .collection:
            return model.mediaSourceBinActiveCollectionLabel
        case .favorites:
            return "★"
        case .used:
            return "使用"
        case .unused:
            return "未使用"
        case .ready:
            return "再生可"
        case .video:
            return "映像"
        case .audio:
            return "音声"
        case .needsAction:
            return "要対応"
        }
    }

    private func sourceBinFilterLabel(_ filter: ProjectMediaSourceBinFilter, count: Int) -> String {
        let label = sourceBinFilterName(filter)
        return "\(label) \(count)"
    }

    private func sourceBinCollectionStatusLabel(_ status: ProjectMediaSourceBinCollectionStatus) -> String {
        switch status {
        case .candidate:
            return "候補"
        case .reviewing:
            return "確認中"
        case .selected:
            return "採用候補"
        case .hold:
            return "保留"
        }
    }

    private func sourceBinSortLabel(_ sort: ProjectMediaSourceBinSort) -> String {
        switch sort {
        case .sourceOrder:
            return "元の順"
        case .filename:
            return "名前順"
        case .status:
            return "状態順"
        case .kind:
            return "種類順"
        }
    }

    private func sourceBinGroupModeLabel(_ groupMode: ProjectMediaSourceBinGroupMode) -> String {
        switch groupMode {
        case .flat:
            return "一覧"
        case .folder:
            return "フォルダ"
        case .status:
            return "状態"
        case .kind:
            return "種類"
        case .usage:
            return "使用状況"
        }
    }

    private func sourceBinGroupLabel(_ group: ProjectMediaSourceBinGroup) -> String {
        switch model.mediaSourceBinGroupMode {
        case .flat:
            return "全素材"
        case .folder:
            return group.label
        case .status:
            if let status = ProjectMediaPreviewStatus.PlaybackStatus(rawValue: group.id) {
                return localizedMediaPlaybackStatus(status)
            }
            return group.label
        case .kind:
            switch group.id {
            case "video":
                return "映像"
            case "audio":
                return "音声"
            default:
                return "その他"
            }
        case .usage:
            switch group.id {
            case "used":
                return "使用中"
            case "unused":
                return "未使用"
            default:
                return group.label
            }
        }
    }

    private func sourceBinGroupIcon(_ group: ProjectMediaSourceBinGroup) -> String {
        switch model.mediaSourceBinGroupMode {
        case .flat:
            return "rectangle.stack"
        case .folder:
            return "folder"
        case .status:
            if group.id == ProjectMediaPreviewStatus.PlaybackStatus.missing.rawValue
                || group.id == ProjectMediaPreviewStatus.PlaybackStatus.needsProxy.rawValue {
                return "exclamationmark.triangle"
            }
            return "checkmark.circle"
        case .kind:
            if group.id == "audio" { return "waveform" }
            if group.id == "video" { return "film" }
            return "doc"
        case .usage:
            if group.id == "used" { return "checkmark.circle.fill" }
            return "circle"
        }
    }

    private func sourceBinViewModeLabel(_ viewMode: MediaSourceBinViewMode) -> String {
        switch viewMode {
        case .list:
            return "一覧"
        case .thumbnails:
            return "サムネイル"
        }
    }

    private func sourceBinViewModeIcon(_ viewMode: MediaSourceBinViewMode) -> String {
        switch viewMode {
        case .list:
            return "list.bullet"
        case .thumbnails:
            return "square.grid.2x2"
        }
    }

    private var sourceBinThumbnailColumns: [GridItem] {
        [
            GridItem(.adaptive(minimum: 142, maximum: 190), spacing: 8, alignment: .top)
        ]
    }

    @ViewBuilder
    private func sourceBinItems(for items: [ProjectMediaPreviewStatus]) -> some View {
        switch model.mediaSourceBinViewMode {
        case .list:
            ForEach(items) { item in
                sourceBinRow(for: item)
                    .id(sourceBinRowID(for: item.assetID))
            }
        case .thumbnails:
            LazyVGrid(columns: sourceBinThumbnailColumns, alignment: .leading, spacing: 8) {
                ForEach(items) { item in
                    sourceBinTile(for: item)
                        .id(sourceBinRowID(for: item.assetID))
                }
            }
            .accessibilityIdentifier("MediaPanel.SourceBinThumbnailGrid")
        }
    }

    @ViewBuilder
    private func sourceBinRow(for item: ProjectMediaPreviewStatus) -> some View {
        MediaSourceBinRow(
            item: item,
            thumbnailURL: thumbnailURL(for: item),
            isSelected: model.sourceMonitorAssetID == item.assetID,
            isInManualBin: model.isSourceBinInManualBin(item.assetID),
            isInActiveCollection: model.isSourceBinInActiveCollection(item.assetID),
            activeCollectionName: model.mediaSourceBinActiveCollectionLabel,
            isFavorite: model.isSourceBinFavorite(item.assetID),
            isUsed: model.isSourceBinUsed(item.assetID),
            quickDragPayload: model.sourceBinQuickDragPayload(for: item.assetID),
            quickDragSummary: model.sourceBinQuickDragSummary(for: item.assetID),
            onPreview: {
                model.previewSourceMonitorAsset(item.assetID)
            },
            onToggleFavorite: {
                model.toggleSourceBinFavorite(item.assetID)
            },
            onToggleManualBin: {
                model.toggleSourceBinManualBin(item.assetID)
            },
            onToggleCollection: {
                model.toggleSourceBinActiveCollection(item.assetID)
            },
            onPreviewSkim: { fraction in
                model.previewSourceBinSkim(assetID: item.assetID, fraction: fraction)
            },
            onEndPreviewSkim: {
                model.clearSourceBinSkimPreview()
            },
            onQuickInsert: {
                model.insertSourceBinQuickCandidateAtPlayhead(item.assetID)
            }
        )
    }

    @ViewBuilder
    private func sourceBinTile(for item: ProjectMediaPreviewStatus) -> some View {
        MediaSourceBinTile(
            item: item,
            thumbnailURL: thumbnailURL(for: item),
            isSelected: model.sourceMonitorAssetID == item.assetID,
            isInManualBin: model.isSourceBinInManualBin(item.assetID),
            isInActiveCollection: model.isSourceBinInActiveCollection(item.assetID),
            activeCollectionName: model.mediaSourceBinActiveCollectionLabel,
            isFavorite: model.isSourceBinFavorite(item.assetID),
            isUsed: model.isSourceBinUsed(item.assetID),
            quickDragPayload: model.sourceBinQuickDragPayload(for: item.assetID),
            quickDragSummary: model.sourceBinQuickDragSummary(for: item.assetID),
            onPreview: {
                model.previewSourceMonitorAsset(item.assetID)
            },
            onToggleFavorite: {
                model.toggleSourceBinFavorite(item.assetID)
            },
            onToggleManualBin: {
                model.toggleSourceBinManualBin(item.assetID)
            },
            onToggleCollection: {
                model.toggleSourceBinActiveCollection(item.assetID)
            },
            onPreviewSkim: { fraction in
                model.previewSourceBinSkim(assetID: item.assetID, fraction: fraction)
            },
            onEndPreviewSkim: {
                model.clearSourceBinSkimPreview()
            },
            onQuickInsert: {
                model.insertSourceBinQuickCandidateAtPlayhead(item.assetID)
            }
        )
    }

    private func thumbnailURL(for item: ProjectMediaPreviewStatus) -> URL? {
        guard let project else { return nil }
        return ProjectThumbnailCache.thumbnailURL(
            projectURL: project.path,
            assetID: item.assetID,
            assets: model.evidenceStore?.assets
        )
    }

    private func accessibilitySuffix(for value: String) -> String {
        mediaPanelAccessibilitySuffix(for: value)
    }

    private func sourceBinRowID(for assetID: String) -> String {
        "MediaPanel.SourceBinRow.\(assetID)"
    }

    private func scrollSourceBinToSelectedAsset(
        proxy: ScrollViewProxy,
        groups: [ProjectMediaSourceBinGroup],
        animated: Bool
    ) {
        guard let assetID = model.sourceMonitorAssetID,
              groups.contains(where: { group in group.items.contains { $0.assetID == assetID } })
        else { return }

        let action = {
            proxy.scrollTo(sourceBinRowID(for: assetID), anchor: .center)
        }
        if animated {
            withAnimation(.easeOut(duration: 0.18), action)
        } else {
            action()
        }
    }
}

private struct SourceMonitorActionRow: View {
    @ObservedObject var model: StudioViewModel

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                insertButton
                appendButton
                overwriteButton
                replaceButton
                returnButton
            }
            .fixedSize(horizontal: true, vertical: false)

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    insertButton
                    appendButton
                }
                HStack(spacing: 6) {
                    overwriteButton
                    replaceButton
                    returnButton
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("MediaPanel.SourceMonitorActionRow")
    }

    private var insertButton: some View {
        Button {
            model.insertSourceMonitorAtPlayhead()
        } label: {
            sourceActionLabel("追加", systemImage: "plus.rectangle.on.rectangle", shortcut: "W")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(!model.canInsertSourceMonitorAtPlayhead)
        .accessibilityIdentifier("MediaPanel.InsertSourceAtPlayheadButton")
        .help(model.sourceMonitorInsertHelp)
    }

    private var appendButton: some View {
        Button {
            model.appendSourceMonitorToTimelineEnd()
        } label: {
            sourceActionLabel("末尾", systemImage: "forward.end", shortcut: "E")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(!model.canAppendSourceMonitorToTimelineEnd)
        .accessibilityIdentifier("MediaPanel.AppendSourceToTimelineEndButton")
        .help(model.sourceMonitorAppendHelp)
    }

    private var overwriteButton: some View {
        Button {
            model.overwriteSourceMonitorAtPlayhead()
        } label: {
            sourceActionLabel("上書き", systemImage: "square.and.arrow.down.on.square", shortcut: "D")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(!model.canOverwriteSourceMonitorAtPlayhead)
        .accessibilityIdentifier("MediaPanel.OverwriteSourceAtPlayheadButton")
        .help(model.sourceMonitorOverwriteHelp)
    }

    private var replaceButton: some View {
        Button {
            model.replaceSelectedClipWithSourceMonitorCandidate()
        } label: {
            sourceActionLabel("置換", systemImage: "arrow.triangle.2.circlepath", shortcut: "R")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(!model.canReplaceSelectedClipWithSourceMonitorCandidate)
        .accessibilityIdentifier("MediaPanel.ReplaceSelectedClipWithSourceButton")
        .help(model.sourceMonitorReplaceHelp)
    }

    private var returnButton: some View {
        Button {
            model.clearSourceMonitorAsset()
        } label: {
            Label("戻る", systemImage: "arrow.uturn.left")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .accessibilityIdentifier("MediaPanel.ReturnToTimelineButton")
        .help("Viewerをタイムラインプレビューに戻します")
    }

    private func sourceActionLabel(_ title: String, systemImage: String, shortcut: String) -> some View {
        HStack(spacing: 4) {
            Label(title, systemImage: systemImage)
            Text(shortcut)
                .font(.caption2.monospaced().weight(.bold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 3)
                .padding(.vertical, 1)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 3, style: .continuous))
        }
        .lineLimit(1)
        .minimumScaleFactor(0.82)
    }
}

private func sourceCandidateNavigationLabel(systemImage: String, shortcut: String) -> some View {
    HStack(spacing: 3) {
        Image(systemName: systemImage)
        Text(shortcut)
            .font(.caption2.monospaced().weight(.bold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 3)
            .padding(.vertical, 1)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 3, style: .continuous))
    }
    .lineLimit(1)
    .minimumScaleFactor(0.82)
}

private struct SourceMarkedRangeControls: View {
    let candidate: SourceMonitorInsertCandidateSummary
    let onMarkIn: () -> Void
    let onMarkOut: () -> Void
    let onNudgeMarkInEarlier: () -> Void
    let onNudgeMarkInLater: () -> Void
    let onNudgeMarkOutEarlier: () -> Void
    let onNudgeMarkOutLater: () -> Void
    let onReset: () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                rangeSummary
                Spacer(minLength: 4)
                markButtons
            }
            .fixedSize(horizontal: true, vertical: false)

            VStack(alignment: .leading, spacing: 5) {
                rangeSummary
                markButtons
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("MediaPanel.SourceMarkedRangeControls")
    }

    private var rangeSummary: some View {
        HStack(spacing: 6) {
            Label(candidate.isMarkedRangeCustom ? "マーク範囲" : "候補範囲", systemImage: "scissors")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(candidate.isMarkedRangeCustom ? Color.orange : Color.secondary)
            Text("\(candidate.markedRangeLabel) / \(candidate.markedDurationLabel)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(candidate.isMarkedRangeCustom ? Color.orange : Color.secondary)
                .lineLimit(1)
            Text(candidate.playbackSourceLabel.map { "現在 \($0)" } ?? "現在 --")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.78)
    }

    private var markButtons: some View {
        HStack(spacing: 6) {
            Button {
                onMarkIn()
            } label: {
                Text("I")
                    .font(.caption2.monospaced().weight(.semibold))
                    .frame(width: 14)
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(!candidate.canMarkInAtPlaybackTime)
            .help("現在のソース再生位置をINにマーク")
            .accessibilityIdentifier("MediaPanel.SourceMarkInAtPlaybackButton")

            Button {
                onMarkOut()
            } label: {
                Text("O")
                    .font(.caption2.monospaced().weight(.semibold))
                    .frame(width: 14)
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(!candidate.canMarkOutAtPlaybackTime)
            .help("現在のソース再生位置をOUTにマーク")
            .accessibilityIdentifier("MediaPanel.SourceMarkOutAtPlaybackButton")

            Button {
                onNudgeMarkInEarlier()
            } label: {
                sourceRangeNudgeLabel("IN-", shortcut: "⌥[")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(!candidate.canMoveMarkInEarlier)
            .help("INを0.5秒前へ戻す (⌥[)")
            .accessibilityIdentifier("MediaPanel.SourceMarkInEarlierButton")

            Button {
                onNudgeMarkInLater()
            } label: {
                sourceRangeNudgeLabel("IN+", shortcut: "⌥]")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(!candidate.canMoveMarkInLater)
            .help("INを0.5秒後ろへ送る (⌥])")
            .accessibilityIdentifier("MediaPanel.SourceMarkInLaterButton")

            Button {
                onNudgeMarkOutEarlier()
            } label: {
                sourceRangeNudgeLabel("OUT-", shortcut: "⇧⌥[")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(!candidate.canMoveMarkOutEarlier)
            .help("OUTを0.5秒前へ詰める (⇧⌥[)")
            .accessibilityIdentifier("MediaPanel.SourceMarkOutEarlierButton")

            Button {
                onNudgeMarkOutLater()
            } label: {
                sourceRangeNudgeLabel("OUT+", shortcut: "⇧⌥]")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(!candidate.canMoveMarkOutLater)
            .help("OUTを0.5秒後ろへ伸ばす (⇧⌥])")
            .accessibilityIdentifier("MediaPanel.SourceMarkOutLaterButton")

            Button {
                onReset()
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.counterclockwise")
                    Text("⇧R")
                        .font(.caption2.monospaced().weight(.bold))
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(!candidate.isMarkedRangeCustom)
            .help("マーク範囲を候補全体に戻す (⇧R)")
            .accessibilityIdentifier("MediaPanel.SourceMarkResetButton")
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    private func sourceRangeNudgeLabel(_ title: String, shortcut: String) -> some View {
        HStack(spacing: 3) {
            Text(title)
                .font(.caption2.monospaced())
            Text(shortcut)
                .font(.caption2.monospaced().weight(.bold))
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.74)
    }
}

private struct MediaSourceBinRow: View {
    let item: ProjectMediaPreviewStatus
    let thumbnailURL: URL?
    let isSelected: Bool
    let isInManualBin: Bool
    let isInActiveCollection: Bool
    let activeCollectionName: String
    let isFavorite: Bool
    let isUsed: Bool
    let quickDragPayload: String?
    let quickDragSummary: SourceBinQuickDragSummary?
    let onPreview: () -> Void
    let onToggleFavorite: () -> Void
    let onToggleManualBin: () -> Void
    let onToggleCollection: () -> Void
    let onPreviewSkim: (Double) -> Void
    let onEndPreviewSkim: () -> Void
    let onQuickInsert: () -> Void

    @ViewBuilder
    var body: some View {
        if let quickDragPayload {
            content
                .onDrag {
                    NSItemProvider(object: quickDragPayload as NSString)
                }
                .help("クリックでソース確認、ドラッグで最適なselect候補をタイムラインへ追加できます")
        } else {
            content
                .help(item.playbackStatus.isReady ? "クリックでソース確認できます" : localizedStudioText(item.recommendation))
        }
    }

    private var content: some View {
        HStack(alignment: .top, spacing: 8) {
            MediaSourceThumbnailView(url: thumbnailURL, playbackStatus: item.playbackStatus)
                .frame(width: 78, height: 44)
                .onContinuousHover { phase in
                    handleThumbnailSkimHover(phase, width: 78)
                }
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Label(item.assetID, systemImage: iconName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(color)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Button {
                        onToggleManualBin()
                    } label: {
                        Image(systemName: isInManualBin ? "tray.full.fill" : "tray")
                            .symbolRenderingMode(.hierarchical)
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .foregroundStyle(isInManualBin ? Color.accentColor : Color.secondary)
                    .help(isInManualBin ? "作業binから外す" : "作業binに追加")
                    .accessibilityIdentifier("MediaPanel.SourceBinManualButton.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                    .accessibilityLabel(isInManualBin ? "作業binから外す" : "作業binに追加")
                    Button {
                        onToggleCollection()
                    } label: {
                        Image(systemName: isInActiveCollection ? "rectangle.stack.fill" : "rectangle.stack")
                            .symbolRenderingMode(.hierarchical)
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .foregroundStyle(isInActiveCollection ? Color.purple : Color.secondary)
                    .help(isInActiveCollection ? "\(activeCollectionName)から外す" : "\(activeCollectionName)に追加")
                    .accessibilityIdentifier("MediaPanel.SourceBinCollectionButton.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                    .accessibilityLabel(isInActiveCollection ? "\(activeCollectionName)から外す" : "\(activeCollectionName)に追加")
                    Button {
                        onToggleFavorite()
                    } label: {
                        Image(systemName: isFavorite ? "star.fill" : "star")
                            .symbolRenderingMode(.hierarchical)
                    }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .foregroundStyle(isFavorite ? Color.yellow : Color.secondary)
                    .help(isFavorite ? "お気に入りから外す" : "お気に入りに追加")
                    .accessibilityIdentifier("MediaPanel.SourceBinFavoriteButton.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                    .accessibilityLabel(isFavorite ? "お気に入りから外す" : "お気に入りに追加")
                    Text(localizedMediaPlaybackStatus(item.playbackStatus))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .help(item.playbackStatus.rawValue)
                }
                Text(item.filename)
                    .font(.caption)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(localizedStudioText(item.recommendation))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if isUsed {
                    Label("使用中", systemImage: "checkmark.circle.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .lineLimit(1)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color.accentColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                        .accessibilityIdentifier("MediaPanel.SourceBinUsedBadge.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                }
                if isInManualBin {
                    Label("作業bin", systemImage: "tray.full")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.blue)
                        .lineLimit(1)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                        .accessibilityIdentifier("MediaPanel.SourceBinManualBadge.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                }
                if isInActiveCollection {
                    Label(activeCollectionName, systemImage: "rectangle.stack")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.purple)
                        .lineLimit(1)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color.purple.opacity(0.10), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                        .accessibilityIdentifier("MediaPanel.SourceBinCollectionBadge.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                }
                if let quickDragSummary {
                    SourceTimelineDragChip(
                        segmentID: quickDragSummary.segmentID,
                        roleLabel: quickDragSummary.roleLabel,
                        targetTrackID: quickDragSummary.targetTrackID,
                        sourceRangeLabel: quickDragSummary.sourceRangeLabel,
                        durationLabel: quickDragSummary.durationLabel,
                        confidenceLabel: quickDragSummary.confidenceLabel,
                        isCompact: false,
                        accessibilityIdentifier: "MediaPanel.SourceBinQuickDragSummary.\(mediaPanelAccessibilitySuffix(for: item.assetID))"
                    )
                }
                if let url = item.url {
                    Text(url.path)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                HStack {
                    Button {
                        onPreview()
                    } label: {
                        Label(isSelected ? "確認中" : "ソース確認", systemImage: "play.rectangle")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(!item.playbackStatus.isReady)
                    .accessibilityIdentifier("MediaPanel.SourcePreviewButton.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                    .help(item.playbackStatus.isReady ? "Viewerでこの素材をソース確認します" : localizedStudioText(item.recommendation))
                    Button {
                        onQuickInsert()
                    } label: {
                        Label("再生位置へ追加", systemImage: "plus.rectangle.on.rectangle")
                            .labelStyle(.iconOnly)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(quickDragSummary == nil)
                    .accessibilityIdentifier("MediaPanel.SourceBinQuickInsertButton.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                    .accessibilityLabel("再生位置へ追加")
                    .help(quickDragSummary.map { "\($0.segmentID) を再生位置へ追加" } ?? "追加できるselect候補がありません")
                    Spacer()
                }
            }
        }
        .padding(7)
        .background(
            isSelected ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor),
            in: RoundedRectangle(cornerRadius: 7, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .stroke(isSelected ? Color.accentColor.opacity(0.75) : Color.primary.opacity(0.08), lineWidth: isSelected ? 1.4 : 1)
        }
        .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .onTapGesture {
            guard item.playbackStatus.isReady else { return }
            onPreview()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.assetID)、\(item.filename)、\(localizedMediaPlaybackStatus(item.playbackStatus))\(isInManualBin ? "、作業bin" : "")\(isInActiveCollection ? "、\(activeCollectionName)" : "")\(isUsed ? "、タイムラインで使用中" : "")")
        .accessibilityHint(item.playbackStatus.isReady ? "ソース確認できます。" : localizedStudioText(item.recommendation))
        .accessibilityIdentifier("MediaPanel.SourceBinItem.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
    }

    private var iconName: String {
        switch item.playbackStatus {
        case .directVideo, .proxyVideo:
            return "film"
        case .directAudio:
            return "waveform"
        case .needsProxy:
            return "exclamationmark.triangle"
        case .missing:
            return "questionmark.folder"
        }
    }

    private var color: Color {
        switch item.playbackStatus {
        case .directVideo, .proxyVideo, .directAudio:
            return .green
        case .needsProxy:
            return .orange
        case .missing:
            return .red
        }
    }

    private func handleThumbnailSkimHover(_ phase: HoverPhase, width: CGFloat) {
        guard item.playbackStatus.isReady else {
            onEndPreviewSkim()
            return
        }
        switch phase {
        case .active(let location):
            let boundedX = max(CGFloat(0), min(location.x, width))
            onPreviewSkim(Double(boundedX / max(CGFloat(1), width)))
        case .ended:
            onEndPreviewSkim()
        }
    }
}

private struct MediaSourceBinTile: View {
    let item: ProjectMediaPreviewStatus
    let thumbnailURL: URL?
    let isSelected: Bool
    let isInManualBin: Bool
    let isInActiveCollection: Bool
    let activeCollectionName: String
    let isFavorite: Bool
    let isUsed: Bool
    let quickDragPayload: String?
    let quickDragSummary: SourceBinQuickDragSummary?
    let onPreview: () -> Void
    let onToggleFavorite: () -> Void
    let onToggleManualBin: () -> Void
    let onToggleCollection: () -> Void
    let onPreviewSkim: (Double) -> Void
    let onEndPreviewSkim: () -> Void
    let onQuickInsert: () -> Void

    @ViewBuilder
    var body: some View {
        if let quickDragPayload {
            content
                .onDrag {
                    NSItemProvider(object: quickDragPayload as NSString)
                }
                .help("クリックでソース確認、ドラッグで最適なselect候補をタイムラインへ追加できます")
        } else {
            content
                .help(item.playbackStatus.isReady ? "クリックでソース確認できます" : localizedStudioText(item.recommendation))
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topLeading) {
                GeometryReader { proxy in
                    MediaSourceThumbnailView(url: thumbnailURL, playbackStatus: item.playbackStatus)
                        .aspectRatio(16.0 / 9.0, contentMode: .fill)
                        .frame(width: proxy.size.width, height: proxy.size.height)
                        .onContinuousHover { phase in
                            handleThumbnailSkimHover(phase, width: proxy.size.width)
                        }
                        .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 78)

                HStack(spacing: 4) {
                    if isUsed {
                        sourceBadge(systemImage: "checkmark.circle.fill", color: Color.accentColor, label: "使用中")
                    }
                    if isInManualBin {
                        sourceBadge(systemImage: "tray.full", color: Color.blue, label: "作業bin")
                    }
                    if isInActiveCollection {
                        sourceBadge(systemImage: "rectangle.stack", color: Color.purple, label: activeCollectionName)
                    }
                    Spacer(minLength: 0)
                }
                .padding(5)
            }

            Label(item.assetID, systemImage: iconName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.78)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(item.filename)
                .font(.caption2)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 5) {
                Text(localizedMediaPlaybackStatus(item.playbackStatus))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
                Spacer(minLength: 0)
                if let quickDragSummary {
                    Text(quickDragSummary.durationLabel)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(Color.accentColor)
                        .lineLimit(1)
                        .minimumScaleFactor(0.78)
                        .help("\(quickDragSummary.segmentID) \(quickDragSummary.sourceRangeLabel) \(quickDragSummary.roleLabel) \(quickDragSummary.confidenceLabel)")
                        .accessibilityIdentifier("MediaPanel.SourceBinTileQuickDragSummary.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                }
            }

            HStack(spacing: 5) {
                Button {
                    onPreview()
                } label: {
                    Image(systemName: isSelected ? "play.rectangle.fill" : "play.rectangle")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(!item.playbackStatus.isReady)
                .help(item.playbackStatus.isReady ? "Viewerでこの素材をソース確認します" : localizedStudioText(item.recommendation))
                .accessibilityIdentifier("MediaPanel.SourceBinTilePreviewButton.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                .accessibilityLabel(isSelected ? "確認中" : "ソース確認")

                Button {
                    onToggleManualBin()
                } label: {
                    Image(systemName: isInManualBin ? "tray.full.fill" : "tray")
                        .symbolRenderingMode(.hierarchical)
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .foregroundStyle(isInManualBin ? Color.accentColor : Color.secondary)
                .help(isInManualBin ? "作業binから外す" : "作業binに追加")
                .accessibilityIdentifier("MediaPanel.SourceBinTileManualButton.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                .accessibilityLabel(isInManualBin ? "作業binから外す" : "作業binに追加")

                Button {
                    onToggleCollection()
                } label: {
                    Image(systemName: isInActiveCollection ? "rectangle.stack.fill" : "rectangle.stack")
                        .symbolRenderingMode(.hierarchical)
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .foregroundStyle(isInActiveCollection ? Color.purple : Color.secondary)
                .help(isInActiveCollection ? "\(activeCollectionName)から外す" : "\(activeCollectionName)に追加")
                .accessibilityIdentifier("MediaPanel.SourceBinTileCollectionButton.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                .accessibilityLabel(isInActiveCollection ? "\(activeCollectionName)から外す" : "\(activeCollectionName)に追加")

                Button {
                    onToggleFavorite()
                } label: {
                    Image(systemName: isFavorite ? "star.fill" : "star")
                        .symbolRenderingMode(.hierarchical)
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .foregroundStyle(isFavorite ? Color.yellow : Color.secondary)
                .help(isFavorite ? "お気に入りから外す" : "お気に入りに追加")
                .accessibilityIdentifier("MediaPanel.SourceBinTileFavoriteButton.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                .accessibilityLabel(isFavorite ? "お気に入りから外す" : "お気に入りに追加")

                Button {
                    onQuickInsert()
                } label: {
                    Image(systemName: "plus.rectangle.on.rectangle")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(quickDragSummary == nil)
                .help(quickDragSummary.map { "\($0.segmentID) を再生位置へ追加" } ?? "追加できるselect候補がありません")
                .accessibilityIdentifier("MediaPanel.SourceBinTileQuickInsertButton.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
                .accessibilityLabel("再生位置へ追加")

                Spacer(minLength: 0)
                if let quickDragSummary {
                    SourceTimelineDragChip(
                        segmentID: quickDragSummary.segmentID,
                        roleLabel: quickDragSummary.roleLabel,
                        targetTrackID: quickDragSummary.targetTrackID,
                        sourceRangeLabel: quickDragSummary.sourceRangeLabel,
                        durationLabel: quickDragSummary.durationLabel,
                        confidenceLabel: quickDragSummary.confidenceLabel,
                        isCompact: true,
                        accessibilityIdentifier: "MediaPanel.SourceBinTileDragChip.\(mediaPanelAccessibilitySuffix(for: item.assetID))"
                    )
                }
            }
        }
        .padding(7)
        .frame(minWidth: 142, maxWidth: .infinity, alignment: .topLeading)
        .background(
            isSelected ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor),
            in: RoundedRectangle(cornerRadius: 7, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .stroke(isSelected ? Color.accentColor.opacity(0.75) : Color.primary.opacity(0.08), lineWidth: isSelected ? 1.4 : 1)
        }
        .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .onTapGesture {
            guard item.playbackStatus.isReady else { return }
            onPreview()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.assetID)、\(item.filename)、\(localizedMediaPlaybackStatus(item.playbackStatus))\(isInManualBin ? "、作業bin" : "")\(isInActiveCollection ? "、\(activeCollectionName)" : "")\(isUsed ? "、タイムラインで使用中" : "")")
        .accessibilityHint(item.playbackStatus.isReady ? "ソース確認できます。" : localizedStudioText(item.recommendation))
        .accessibilityIdentifier("MediaPanel.SourceBinTile.\(mediaPanelAccessibilitySuffix(for: item.assetID))")
    }

    private func sourceBadge(systemImage: String, color: Color, label: String) -> some View {
        Image(systemName: systemImage)
            .font(.caption2.weight(.bold))
            .foregroundStyle(color)
            .frame(width: 16, height: 16)
            .background(.regularMaterial, in: Circle())
            .help(label)
            .accessibilityLabel(label)
    }

    private var iconName: String {
        switch item.playbackStatus {
        case .directVideo, .proxyVideo:
            return "film"
        case .directAudio:
            return "waveform"
        case .needsProxy:
            return "exclamationmark.triangle"
        case .missing:
            return "questionmark.folder"
        }
    }

    private var color: Color {
        switch item.playbackStatus {
        case .directVideo, .proxyVideo, .directAudio:
            return .green
        case .needsProxy:
            return .orange
        case .missing:
            return .red
        }
    }

    private func handleThumbnailSkimHover(_ phase: HoverPhase, width: CGFloat) {
        guard item.playbackStatus.isReady else {
            onEndPreviewSkim()
            return
        }
        switch phase {
        case .active(let location):
            let boundedX = max(CGFloat(0), min(location.x, width))
            onPreviewSkim(Double(boundedX / max(CGFloat(1), width)))
        case .ended:
            onEndPreviewSkim()
        }
    }
}

private struct MediaSourceThumbnailView: View {
    let url: URL?
    let playbackStatus: ProjectMediaPreviewStatus.PlaybackStatus

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 5)
                .fill(.quaternary)
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .clipShape(RoundedRectangle(cornerRadius: 5))
            } else {
                Image(systemName: placeholderIcon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .clipped()
        .overlay {
            RoundedRectangle(cornerRadius: 5)
                .stroke(.quaternary, lineWidth: 1)
        }
    }

    private var image: NSImage? {
        guard let url else { return nil }
        return NSImage(contentsOf: url)
    }

    private var placeholderIcon: String {
        switch playbackStatus {
        case .directAudio:
            return "waveform"
        case .missing:
            return "questionmark.folder"
        case .needsProxy:
            return "exclamationmark.triangle"
        case .directVideo, .proxyVideo:
            return "photo"
        }
    }
}

private func mediaPanelAccessibilitySuffix(for value: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
    var result = ""
    for scalar in value.unicodeScalars {
        if allowed.contains(scalar) {
            result.unicodeScalars.append(scalar)
        } else {
            result.append("_")
        }
    }
    return result.isEmpty ? "empty" : result
}

private struct SourceTimelineDragChip: View {
    let segmentID: String
    let roleLabel: String
    let targetTrackID: TimelineTrack.ID
    let sourceRangeLabel: String
    let durationLabel: String
    let confidenceLabel: String
    let isCompact: Bool
    let accessibilityIdentifier: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "hand.draw")
                .font(.system(size: isCompact ? 8 : 9, weight: .bold))
            Text(isCompact ? "TLへ" : "Timelineへドラッグ")
                .font(.system(size: isCompact ? 8 : 9, weight: .bold))
                .lineLimit(1)
            if isCompact {
                Text(durationLabel)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            } else {
                Text(segmentID)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(roleLabel)
                    .lineLimit(1)
                Text("→\(targetTrackID)")
                    .lineLimit(1)
                Text(sourceRangeLabel)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Text(durationLabel)
                    .lineLimit(1)
                Text(confidenceLabel)
                    .lineLimit(1)
            }
        }
        .font(.caption2.monospacedDigit())
        .foregroundStyle(Color.accentColor)
        .lineLimit(1)
        .minimumScaleFactor(0.76)
        .padding(.horizontal, isCompact ? 5 : 7)
        .padding(.vertical, isCompact ? 2 : 3)
        .background(Color.accentColor.opacity(0.11), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .stroke(Color.accentColor.opacity(0.34), lineWidth: 1)
        }
        .help("タイムラインへドラッグ: \(segmentID) / \(sourceRangeLabel) / \(roleLabel) / \(targetTrackID) / \(durationLabel) / \(confidenceLabel)")
        .accessibilityLabel("タイムラインへドラッグできる候補 \(segmentID)、ソース範囲 \(sourceRangeLabel)、\(roleLabel)、\(targetTrackID)、\(durationLabel)、信頼度 \(confidenceLabel)")
        .accessibilityIdentifier(accessibilityIdentifier)
    }
}

private struct SourceMarkedRangeScrubber: View {
    let candidate: SourceMonitorInsertCandidateSummary
    let onDragMarkIn: (Double) -> Void
    let onDragMarkOut: (Double) -> Void

    private var coordinateSpaceName: String {
        "MediaPanel.SourceMarkedRangeScrubber.\(candidate.candidateID)"
    }

    var body: some View {
        GeometryReader { proxy in
            let width = max(1, proxy.size.width)
            let lowerFraction = clampedFraction(candidate.markedInFraction)
            let upperFraction = max(lowerFraction, clampedFraction(candidate.markedOutFraction))
            let startX = lowerFraction * width
            let endX = upperFraction * width
            let selectionWidth = max(4, endX - startX)
            let handleColor = candidate.isMarkedRangeCustom ? Color.orange : Color.accentColor

            ZStack(alignment: .leading) {
                Capsule(style: .continuous)
                    .fill(Color.secondary.opacity(0.18))
                    .frame(height: 4)
                    .frame(maxWidth: .infinity)
                    .position(x: width / 2, y: 12)

                Capsule(style: .continuous)
                    .fill(handleColor.opacity(candidate.isMarkedRangeCustom ? 0.78 : 0.58))
                    .frame(width: selectionWidth, height: 6)
                    .position(x: startX + selectionWidth / 2, y: 12)

                sourceRangeHandle(label: "IN", color: handleColor)
                    .position(x: handleX(startX, width: width), y: 12)
                    .gesture(
                        DragGesture(minimumDistance: 0, coordinateSpace: .named(coordinateSpaceName))
                            .onChanged { value in
                                onDragMarkIn(normalizedPosition(value.location.x, width: width))
                            }
                    )
                    .accessibilityIdentifier("MediaPanel.SourceMarkInDragHandle")

                sourceRangeHandle(label: "OUT", color: handleColor)
                    .position(x: handleX(endX, width: width), y: 12)
                    .gesture(
                        DragGesture(minimumDistance: 0, coordinateSpace: .named(coordinateSpaceName))
                            .onChanged { value in
                                onDragMarkOut(normalizedPosition(value.location.x, width: width))
                            }
                    )
                    .accessibilityIdentifier("MediaPanel.SourceMarkOutDragHandle")
            }
            .coordinateSpace(name: coordinateSpaceName)
        }
        .frame(height: 24)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("MediaPanel.SourceMarkedRangeScrubber")
        .accessibilityLabel("ソースマーク範囲")
        .accessibilityValue("\(candidate.markedRangeLabel) / \(candidate.markedDurationLabel)")
        .help("左右のハンドルをドラッグして、追加/ドラッグ時に使うソース範囲を調整します")
    }

    private func sourceRangeHandle(label: String, color: Color) -> some View {
        ZStack {
            Circle()
                .fill(color)
            Circle()
                .stroke(Color.primary.opacity(0.22), lineWidth: 1)
            Text(label)
                .font(.system(size: 7, weight: .bold, design: .rounded))
                .foregroundStyle(Color.white)
                .minimumScaleFactor(0.7)
        }
        .frame(width: 18, height: 18)
        .contentShape(Rectangle())
    }

    private func clampedFraction(_ fraction: Double) -> Double {
        min(1, max(0, fraction))
    }

    private func handleX(_ x: Double, width: Double) -> Double {
        min(width - 9, max(9, x))
    }

    private func normalizedPosition(_ x: Double, width: Double) -> Double {
        guard width > 0 else { return 0 }
        return min(1, max(0, x / width))
    }
}
