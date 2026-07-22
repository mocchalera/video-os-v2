import AppKit
import AVFoundation
import SwiftUI
import VideoOSStudioCore

struct ClipInspectorPanel: View {
    @ObservedObject var model: StudioViewModel

    var body: some View {
        Form {
            let timeline = model.timeline
            let selection = model.selectedTimelineClip
            let evidence = model.selectedClipEvidence
            if let timeline, let selection {
                let clip = selection.clip
                Section("選択クリップ") {
                    LabeledContent("クリップ", value: clip.id)
                    LabeledContent("トラック", value: "\(selection.trackID) / \(localizedTrackKind(selection.trackKind))")
                        .help(selection.trackKind.rawValue)
                    LabeledContent("役割", value: localizedClipRole(clip.role))
                        .help(clip.role)
                    LabeledContent("信頼度", value: formatConfidence(clip.confidence))
                    if let beatID = clip.beatID {
                        LabeledContent("ビート", value: beatID)
                    }
                }

                Section("素材") {
                    LabeledContent("アセット", value: clip.assetID)
                    LabeledContent("セグメント", value: clip.segmentID)
                    if let sourceInUS = clip.sourceInUS {
                        LabeledContent("素材In", value: formatMicroseconds(sourceInUS))
                    }
                    if let sourceOutUS = clip.sourceOutUS {
                        LabeledContent("素材Out", value: formatMicroseconds(sourceOutUS))
                    }
                    if let duration = clip.sourceDurationSeconds {
                        LabeledContent("素材長", value: formatSeconds(duration))
                    }
                    if let candidateRef = clip.candidateRef {
                        LabeledContent("候補参照", value: candidateRef)
                    }
                }

                Section("タイムライン") {
                    LabeledContent("In", value: timeline.sequence.framesToTimecode(clip.timelineInFrame))
                    LabeledContent("Out", value: timeline.sequence.framesToTimecode(clip.timelineOutFrame))
                    LabeledContent("長さ", value: "\(clip.timelineDurationFrames)フレーム / \(formatSeconds(timeline.sequence.framesToSeconds(clip.timelineDurationFrames)))")
                }

                InterviewFinishInspectorSection(model: model)

                Section("編集意図") {
                    Text(clip.motivation)
                        .textSelection(.enabled)
                    if !clip.qualityFlags.isEmpty {
                        LabeledContent("品質フラグ", value: localizedList(clip.qualityFlags, using: localizedQualityFlag))
                            .help(clip.qualityFlags.joined(separator: ", "))
                    }
                    if !clip.fallbackSegmentIDs.isEmpty {
                        LabeledContent("予備候補", value: clip.fallbackSegmentIDs.joined(separator: ", "))
                    }
                }

                Section("編集メモ") {
                    LabeledContent("引き継ぎ", value: model.editorAnnotationSummary?.statusLabel ?? "編集メモはありません")
                        .accessibilityIdentifier("ClipInspector.EditorAnnotationSummary")
                    Label(model.selectedClipNoteDraftState.statusLabel, systemImage: model.selectedClipNoteDraftState.includesReadOnlyAgentPreview ? "sparkles" : "square.and.pencil")
                        .font(.caption)
                        .foregroundStyle(model.selectedClipNoteDraftState.hasChanges ? .orange : .secondary)
                        .accessibilityIdentifier("ClipInspector.NoteDraftState")
                    if let saved = model.selectedClipNote {
                        LabeledContent("保存済み", value: saved.updatedAt)
                            .accessibilityIdentifier("ClipInspector.SavedNoteUpdatedAt")
                        Text(saved.handoffInstruction)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("ClipInspector.SavedHandoffInstruction")
                    }

                    TextEditor(text: $model.selectedClipNoteDraft)
                        .font(.body)
                        .frame(minHeight: 72)
                        .accessibilityLabel("編集メモの下書き")
                        .accessibilityIdentifier("ClipInspector.NoteDraftEditor")

                    TextEditor(text: $model.selectedClipHandoffInstructionDraft)
                        .font(.body)
                        .frame(minHeight: 58)
                        .accessibilityLabel("引き継ぎ指示の下書き")
                        .accessibilityIdentifier("ClipInspector.HandoffInstructionDraftEditor")

                    HStack {
                        Button {
                            model.proposeSelectedClipNoteWithCodex()
                        } label: {
                            Label("Codexに相談", systemImage: "sparkles")
                        }
                        .disabled(model.appServerStatus == .checking || model.activeThreadID == nil)
                        .accessibilityIdentifier("ClipInspector.AskCodexButton")

                        Button {
                            model.saveSelectedClipNote()
                        } label: {
                            Label("メモを保存", systemImage: "note.text.badge.plus")
                        }
                        .disabled(!model.canSaveSelectedClipNoteDraft)
                        .accessibilityIdentifier("ClipInspector.SaveNoteButton")

                        Button(role: .destructive) {
                            model.clearSelectedClipNote()
                        } label: {
                            Label("消去", systemImage: "xmark.circle")
                        }
                        .disabled(model.selectedClipNote == nil)
                        .accessibilityIdentifier("ClipInspector.ClearNoteButton")
                    }

                    Text(model.editorAnnotationStatus)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("ClipInspector.EditorAnnotationStatus")
                }

                if let evidence, evidence.hasAnalysis {
                    AnalysisEvidenceSection(evidence: evidence)
                } else {
                    Section("解析根拠") {
                        Label("このクリップに対応する解析成果物はまだ見つかっていません。", systemImage: "doc.badge.clock")
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                Section("選択クリップ") {
                    Label("素材、タイミング、編集意図を見るにはタイムラインのクリップを選択してください。", systemImage: "cursorarrow.click.2")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("ClipInspector.NoSelectionMessage")
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

private struct InterviewFinishInspectorSection: View {
    @ObservedObject var model: StudioViewModel

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Picker("音声MA（動画全体）", selection: $model.interviewAudioFinishPreset) {
                    Text("会話を整える").tag("dialogue-clean")
                    Text("音量のみ").tag("loudness-only")
                    Text("なし").tag("none")
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("ClipInspector.InterviewAudioPreset")

                HStack {
                    Text("-16 LUFS / -1.5 dBTP")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        model.queueInterviewAudioFinish()
                    } label: {
                        Label("MAを保留", systemImage: "waveform.badge.plus")
                    }
                    .accessibilityIdentifier("ClipInspector.QueueInterviewMA")
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 12) {
                metricSlider(
                    title: "ズーム",
                    value: $model.interviewFinishZoom,
                    range: 1 ... 1.35,
                    step: 0.01,
                    valueLabel: String(format: "%.2fx", model.interviewFinishZoom),
                    accessibilityID: "ClipInspector.InterviewZoom"
                )

                metricSlider(
                    title: "水平パン",
                    value: $model.interviewFinishPositionX,
                    range: -model.interviewMaximumPanX ... model.interviewMaximumPanX,
                    step: 1,
                    valueLabel: String(format: "%+.0f px", model.interviewFinishPositionX),
                    accessibilityID: "ClipInspector.InterviewPanX"
                )

                metricSlider(
                    title: "垂直パン",
                    value: $model.interviewFinishPositionY,
                    range: -model.interviewMaximumPanY ... model.interviewMaximumPanY,
                    step: 1,
                    valueLabel: String(format: "%+.0f px", model.interviewFinishPositionY),
                    accessibilityID: "ClipInspector.InterviewPanY"
                )
            }
            .disabled(!model.canFinishSelectedInterviewClip || model.isAnalyzingInterviewReframe)
            .onChange(of: model.interviewFinishZoom) { _, _ in
                model.clampInterviewFinishPosition()
            }

            if let proposal = model.interviewReframeProposal {
                HStack(spacing: 8) {
                    Label("AI画角", systemImage: "viewfinder.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.blue)
                    Text("顔 \(proposal.faceSampleCount)/\(proposal.analyzedSampleCount)・手振り \(proposal.gestureSampleCount)・信頼度 \(proposal.confidence.formatted(.number.precision(.fractionLength(2))))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .help(proposal.reason)
                .accessibilityIdentifier("ClipInspector.InterviewProposalSummary")
            }

            HStack {
                Button {
                    model.analyzeSelectedInterviewReframe()
                } label: {
                    Label(
                        model.isAnalyzingInterviewReframe ? "解析中" : "自動画角を提案",
                        systemImage: model.isAnalyzingInterviewReframe ? "hourglass" : "person.crop.rectangle"
                    )
                }
                .disabled(!model.canFinishSelectedInterviewClip || model.isAnalyzingInterviewReframe)
                .accessibilityIdentifier("ClipInspector.AnalyzeInterviewReframe")

                Button {
                    model.resetSelectedInterviewFraming()
                } label: {
                    Label("リセット", systemImage: "arrow.counterclockwise")
                }
                .disabled(model.isAnalyzingInterviewReframe)
                .accessibilityIdentifier("ClipInspector.ResetInterviewReframe")

                Spacer()

                Button {
                    model.queueSelectedInterviewVisualTransform()
                } label: {
                    Label("画角を保留", systemImage: "rectangle.and.pencil.and.ellipsis")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!model.canFinishSelectedInterviewClip || model.isAnalyzingInterviewReframe)
                .accessibilityIdentifier("ClipInspector.QueueInterviewReframe")
            }

            Text(model.interviewFinishStatus)
                .font(.caption)
                .foregroundStyle(model.interviewFinishStatus.contains("失敗") ? .red : .secondary)
                .accessibilityIdentifier("ClipInspector.InterviewFinishStatus")
        } header: {
            Label("インタビュー仕上げ", systemImage: "viewfinder")
        } footer: {
            Text("画角はViewerへ即時プレビューされ、保存時はReview Patchとして履歴・取り消し対象になります。")
        }
    }

    private func metricSlider(
        title: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        step: Double,
        valueLabel: String,
        accessibilityID: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(title)
                Spacer()
                Text(valueLabel)
                    .font(.caption.monospacedDigit().weight(.medium))
                    .foregroundStyle(.secondary)
            }
            Slider(value: value, in: range, step: step)
                .accessibilityLabel(title)
                .accessibilityValue(valueLabel)
                .accessibilityIdentifier(accessibilityID)
        }
    }
}

struct AnalysisEvidenceSection: View {
    var evidence: ClipEvidence

    var body: some View {
        Section("根拠サマリー") {
            LabeledContent("素材", value: evidence.asset == nil ? "未検出" : "あり")
            LabeledContent("セグメント", value: evidence.segment == nil ? "未検出" : "あり")
            LabeledContent("文字起こし", value: "\(evidence.transcriptItems.count)件")
            LabeledContent("Marlin根拠", value: "\(evidence.marlinEvents.count + evidence.marlinFindResults.count)件")
            LabeledContent("音声根拠", value: "\(evidence.audioEvents.count + evidence.audioStoryNodes.count + evidence.bgmSections.count)件")
        }

        Section("解析根拠") {
            if let asset = evidence.asset {
                LabeledContent("ファイル", value: asset.filename)
                LabeledContent("素材の役割", value: asset.roleGuess.map(localizedClipRole) ?? "-")
                    .help(asset.roleGuess ?? "")
                if asset.durationUS != nil {
                    LabeledContent("素材の長さ", value: formatMicroseconds(asset.durationUS ?? 0))
                }
                if !asset.qualityFlags.isEmpty {
                    LabeledContent("素材品質", value: localizedList(asset.qualityFlags, using: localizedQualityFlag))
                        .help(asset.qualityFlags.joined(separator: ", "))
                }
                if !asset.tags.isEmpty {
                    LabeledContent("素材タグ", value: localizedList(asset.tags, using: localizedEvidenceTag))
                        .help(asset.tags.joined(separator: ", "))
                }
            }

            if let segment = evidence.segment {
                LabeledContent("セグメント要約", value: segment.summary.isEmpty ? "-" : segment.summary)
                if !segment.qualityFlags.isEmpty {
                    LabeledContent("セグメント品質", value: localizedList(segment.qualityFlags, using: localizedQualityFlag))
                        .help(segment.qualityFlags.joined(separator: ", "))
                }
                if !segment.tags.isEmpty {
                    LabeledContent("セグメントタグ", value: localizedList(segment.tags, using: localizedEvidenceTag))
                        .help(segment.tags.joined(separator: ", "))
                }
                if !segment.transcriptExcerpt.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("文字起こし抜粋（原文）")
                            .font(.caption.weight(.semibold))
                        Text(segment.transcriptExcerpt)
                            .font(.caption)
                            .textSelection(.enabled)
                    }
                }
                ForEach(segment.interestPoints.indices, id: \.self) { index in
                    let point = segment.interestPoints[index]
                    LabeledContent(
                        "注目点 \(index + 1)",
                        value: "\(localizedEvidenceTag(point.label)) / \(point.frameUS.map(formatMicroseconds) ?? "-")"
                    )
                    .help([point.label, point.source].compactMap { $0 }.joined(separator: " / "))
                }
                if let peak = segment.peakAnalysis {
                    LabeledContent("ピーク", value: peak.selectedPeakUS.map(formatMicroseconds) ?? "-")
                    LabeledContent("ピーク信頼度", value: formatConfidence(peak.confidence))
                    if let precisionMode = peak.provenance?.precisionMode {
                        LabeledContent("ピーク根拠", value: localizedPrecisionMode(precisionMode))
                            .help(precisionMode)
                    }
                }
            }
        }

        Section("文字起こし") {
            if evidence.transcriptItems.isEmpty {
                Text("重なる文字起こしはありません。")
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
                LabeledContent("シーン", value: marlinAsset.scene.isEmpty ? "-" : marlinAsset.scene)
                if let caption = marlinAsset.caption, !caption.isEmpty {
                    Text(caption)
                        .font(.caption)
                        .textSelection(.enabled)
                }
            } else {
                Text("このプロジェクトでは marlin_events.json がまだ生成されていません。")
                    .foregroundStyle(.secondary)
            }

            ForEach(evidence.marlinEvents) { event in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(formatMicroseconds(event.startUS))-\(formatMicroseconds(event.endUS))  \(event.sourcePass.map(localizedSourcePass) ?? "Marlin")")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .help(event.sourcePass ?? "marlin")
                    Text(event.description)
                        .textSelection(.enabled)
                }
            }

            ForEach(evidence.marlinFindResults) { result in
                LabeledContent(
                    "検索一致",
                    value: "\(result.query) / \(result.spanStartUS.map(formatMicroseconds) ?? "-")-\(result.spanEndUS.map(formatMicroseconds) ?? "-")"
                )
            }
        }

        Section("音声") {
            if evidence.audioEvents.isEmpty && evidence.audioStoryNodes.isEmpty && evidence.bgmSections.isEmpty {
                Text("重なる音声イベント、ストーリーノード、BGMセクションはありません。")
                    .foregroundStyle(.secondary)
            }

            ForEach(evidence.audioEvents) { event in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(formatMicroseconds(event.startUS))-\(formatMicroseconds(event.endUS))  \(localizedAudioEventType(event.type))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .help(event.type)
                    Text(event.label ?? localizedAudioEventType(event.type))
                        .textSelection(.enabled)
                    if let score = event.confidence?.score {
                        Text("信頼度 \(formatConfidence(score))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            ForEach(evidence.audioStoryNodes) { node in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(formatMicroseconds(node.startUS))-\(formatMicroseconds(node.endUS))  \(localizedAudioStoryType(node.type))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .help(node.type)
                    Text(node.text ?? node.storyRole.map(localizedAudioStoryType) ?? node.id)
                        .textSelection(.enabled)
                    Text([node.storyRole.map(localizedAudioStoryType), node.refs.speakerRef, node.refs.audioEventRef, node.refs.bgmRef].compactMap { $0 }.joined(separator: " / "))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(evidence.bgmSections) { section in
                LabeledContent(
                    "BGM \(localizedEvidenceTag(section.label))",
                    value: "\(formatSeconds(section.startSec))-\(formatSeconds(section.endSec)) / 強さ \(formatConfidence(section.energy))"
                )
                .help(section.label)
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

private func localizedList(_ values: [String], using formatter: (String) -> String) -> String {
    values.map(formatter).joined(separator: ", ")
}
