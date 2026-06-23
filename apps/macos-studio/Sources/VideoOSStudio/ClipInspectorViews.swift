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
                        .accessibilityIdentifier("ClipInspector.EditorAnnotationSummary")
                    if let saved = model.selectedClipNote {
                        LabeledContent("Saved", value: saved.updatedAt)
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
                        .accessibilityLabel("Editor note draft")
                        .accessibilityIdentifier("ClipInspector.NoteDraftEditor")

                    TextEditor(text: $model.selectedClipHandoffInstructionDraft)
                        .font(.body)
                        .frame(minHeight: 58)
                        .accessibilityLabel("Handoff instruction draft")
                        .accessibilityIdentifier("ClipInspector.HandoffInstructionDraftEditor")

                    HStack {
                        Button {
                            model.proposeSelectedClipNoteWithCodex()
                        } label: {
                            Label("Ask Codex", systemImage: "sparkles")
                        }
                        .disabled(model.appServerStatus == .checking || model.activeThreadID == nil)
                        .accessibilityIdentifier("ClipInspector.AskCodexButton")

                        Button {
                            model.saveSelectedClipNote()
                        } label: {
                            Label("Save Note", systemImage: "note.text.badge.plus")
                        }
                        .disabled(model.selectedClipNoteDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("ClipInspector.SaveNoteButton")

                        Button(role: .destructive) {
                            model.clearSelectedClipNote()
                        } label: {
                            Label("Clear", systemImage: "xmark.circle")
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
                    Section("Analysis Evidence") {
                        Label("No analysis artifact matched this clip yet.", systemImage: "doc.badge.clock")
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                Section("Selection") {
                    Label("Select a timeline clip to inspect source, timing, and editorial rationale.", systemImage: "cursorarrow.click.2")
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

struct AnalysisEvidenceSection: View {
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
