import Foundation

public enum TimelineAgentConsultationIntent: String, CaseIterable, Identifiable, Sendable {
    case tightenSelection = "tighten-selection"
    case shortenBeat = "shorten-beat"
    case findStrongerAlternate = "find-stronger-alternate"
    case explainCut = "explain-cut"

    public var id: String { rawValue }

    public var localizedTitle: String {
        switch self {
        case .tightenSelection:
            return "短く整える"
        case .shortenBeat:
            return "このビートを短く"
        case .findStrongerAlternate:
            return "代替を探す"
        case .explainCut:
            return "カットを説明"
        }
    }

    public var instruction: String {
        switch self {
        case .tightenSelection:
            return "Suggest how to tighten the selected timeline range while preserving continuity, intent, and audio readability."
        case .shortenBeat:
            return "Suggest how to make the selected beat shorter and more rhythmic without breaking continuity, transcript meaning, or audio readability."
        case .findStrongerAlternate:
            return "Suggest whether the selected clip or cut should be replaced with stronger source material, and describe what evidence to search for."
        case .explainCut:
            return "Explain why the selected clip, range, or transition works or fails, using timeline, transcript, Marlin, and audio evidence."
        }
    }
}

public enum TimelineAgentConsultationPrompt {
    public static func make(
        project: ProjectSummary,
        repositoryRoot: URL,
        timeline: TimelineDocument,
        intent: TimelineAgentConsultationIntent,
        selectedClips: [TimelineClipSelection],
        selectedTransition: TimelineTransition?,
        evidenceByClipID: [TimelineClip.ID: ClipEvidence] = [:],
        qaIssuesByClipID: [TimelineClip.ID: [QAIssueItem]] = [:],
        existingNotesByClipID: [TimelineClip.ID: ProjectEditorClipNote] = [:]
    ) -> String {
        let sortedSelections = selectedClips.sorted { lhs, rhs in
            if lhs.clip.timelineInFrame == rhs.clip.timelineInFrame {
                if lhs.trackID == rhs.trackID { return lhs.clip.id < rhs.clip.id }
                return lhs.trackID < rhs.trackID
            }
            return lhs.clip.timelineInFrame < rhs.clip.timelineInFrame
        }
        var lines = [
            "You are helping a professional video editor in a manual timeline editing loop.",
            "",
            "Do not modify files or write artifacts. Treat this as a proposal for the human editor to review in the native UI.",
            "Return concise recommendations plus patch-style operation suggestions only. Mark every timeline-changing suggestion as PREVIEW, not applied.",
            "Supported suggestion vocabulary: trim, split, move, replace, ripple-delete, lift-delete, transition-duration, transition-type, search-alternate.",
            "When suggesting timeline-changing operations, include one fenced `review_patch` JSON block that matches the existing review patch schema. Use the current timeline_version and exact clip/transition IDs. Do not include JSON if the right action is explanation or source search only.",
            "",
            "Task: \(intent.instruction)",
            "",
            "Project: \(project.id) / \(project.name)",
            "Repository root: \(repositoryRoot.path)",
            "Project path: \(project.path.path)",
            "Sequence: \(timeline.sequence.name), \(timeline.sequence.framesToTimecode(0))-\(timeline.sequence.framesToTimecode(timeline.totalFrames)), \(timeline.sequence.fps) fps"
        ]

        appendSelectionRange(
            sortedSelections,
            selectedTransition: selectedTransition,
            timeline: timeline,
            to: &lines
        )
        appendTransition(selectedTransition, timeline: timeline, to: &lines)

        if sortedSelections.isEmpty {
            lines.append("")
            lines.append("Selected clips: none")
        } else {
            lines.append("")
            lines.append("Selected clips:")
            for selection in sortedSelections {
                appendClip(
                    selection,
                    timeline: timeline,
                    evidence: evidenceByClipID[selection.clip.id],
                    qaIssues: qaIssuesByClipID[selection.clip.id] ?? [],
                    existingNote: existingNotesByClipID[selection.clip.id],
                    to: &lines
                )
            }
        }

        lines.append("")
        lines.append("Response format:")
        lines.append("1. Editor diagnosis: one or two sentences.")
        lines.append("2. PREVIEW operations: bullet each proposed operation with clip_id or transition_id, exact frame/timecode target when possible, and why it helps.")
        lines.append("3. Evidence to verify: list transcript, Marlin, audio, or source-bin checks that should happen before applying changes.")
        lines.append("4. Optional structured patch: final fenced `review_patch` JSON with { \"timeline_version\": \"\(timeline.version)\", \"operations\": [...] } when a safe edit operation can be represented.")
        return lines.joined(separator: "\n")
    }

    private static func appendSelectionRange(
        _ selections: [TimelineClipSelection],
        selectedTransition: TimelineTransition?,
        timeline: TimelineDocument,
        to lines: inout [String]
    ) {
        var rangeFrames: [Int] = selections.flatMap { [$0.clip.timelineInFrame, $0.clip.timelineOutFrame] }
        if let selectedTransition,
           let from = timeline.clipSelection(for: selectedTransition.fromClipID)?.clip,
           let to = timeline.clipSelection(for: selectedTransition.toClipID)?.clip,
           let transitionFrames = selectedTransition.transitionFrames {
            let boundary = from.timelineOutFrame
            let leading = transitionFrames / 2
            let trailing = transitionFrames - leading
            rangeFrames.append(max(from.timelineInFrame, boundary - leading))
            rangeFrames.append(min(to.timelineOutFrame, boundary + trailing))
        }
        guard let start = rangeFrames.min(), let end = rangeFrames.max(), start < end else {
            lines.append("Selection range: none")
            return
        }
        lines.append("Selection range: \(timeline.sequence.framesToTimecode(start))-\(timeline.sequence.framesToTimecode(end)) (\(end - start) frames)")
    }

    private static func appendTransition(
        _ transition: TimelineTransition?,
        timeline: TimelineDocument,
        to lines: inout [String]
    ) {
        guard let transition else { return }
        lines.append("")
        lines.append("Selected transition:")
        lines.append("- Transition: \(transition.id)")
        lines.append("- Track: \(transition.trackID)")
        lines.append("- Type: \(transition.transitionType)")
        lines.append("- From clip: \(transition.fromClipID)")
        lines.append("- To clip: \(transition.toClipID)")
        if let frames = transition.transitionFrames {
            lines.append("- Duration: \(frames) frames")
        }
        if let handles = timeline.transitionHandles(
            trackID: transition.trackID,
            fromClipID: transition.fromClipID,
            toClipID: transition.toClipID
        ) {
            lines.append("- Available handles: \(handles) frames")
        }
        if let from = timeline.clipSelection(for: transition.fromClipID)?.clip {
            lines.append("- Boundary: \(timeline.sequence.framesToTimecode(from.timelineOutFrame))")
        }
    }

    private static func appendClip(
        _ selection: TimelineClipSelection,
        timeline: TimelineDocument,
        evidence: ClipEvidence?,
        qaIssues: [QAIssueItem],
        existingNote: ProjectEditorClipNote?,
        to lines: inout [String]
    ) {
        let clip = selection.clip
        lines.append("- Clip: \(clip.id)")
        lines.append("  Track: \(selection.trackID) / \(selection.trackKind.rawValue)")
        lines.append("  Timeline: \(timeline.sequence.framesToTimecode(clip.timelineInFrame))-\(timeline.sequence.framesToTimecode(clip.timelineOutFrame)) (\(clip.timelineDurationFrames) frames)")
        lines.append("  Asset: \(clip.assetID)")
        lines.append("  Segment: \(clip.segmentID)")
        lines.append("  Role: \(clip.role)")
        lines.append("  Motivation: \(clip.motivation)")
        if let sourceIn = clip.sourceInUS, let sourceOut = clip.sourceOutUS {
            lines.append("  Source: \(formatMicroseconds(sourceIn))-\(formatMicroseconds(sourceOut))")
        }
        if let beatID = clip.beatID {
            lines.append("  Beat: \(beatID)")
        }
        if !clip.qualityFlags.isEmpty {
            lines.append("  Quality flags: \(clip.qualityFlags.joined(separator: ", "))")
        }
        if let existingNote {
            lines.append("  Existing note: \(existingNote.note)")
            lines.append("  Existing handoff instruction: \(existingNote.handoffInstruction)")
        }
        if let evidence {
            appendEvidence(evidence, to: &lines)
        }
        appendQAIssues(qaIssues, timeline: timeline, to: &lines)
    }

    private static func appendEvidence(_ evidence: ClipEvidence, to lines: inout [String]) {
        if let asset = evidence.asset {
            lines.append("  Asset file: \(asset.filename)")
            if let role = asset.roleGuess {
                lines.append("  Asset role guess: \(role)")
            }
            if !asset.tags.isEmpty {
                lines.append("  Asset tags: \(asset.tags.prefix(6).joined(separator: ", "))")
            }
        }
        if let segment = evidence.segment {
            if !segment.summary.isEmpty {
                lines.append("  Segment summary: \(segment.summary)")
            }
            if !segment.transcriptExcerpt.isEmpty {
                lines.append("  Transcript excerpt: \(limit(segment.transcriptExcerpt, count: 360))")
            }
            if !segment.tags.isEmpty {
                lines.append("  Segment tags: \(segment.tags.prefix(8).joined(separator: ", "))")
            }
            if !segment.interestPoints.isEmpty {
                let labels = segment.interestPoints.prefix(5).map { point in
                    var parts = [point.label]
                    if let frameUS = point.frameUS {
                        parts.append("@\(formatMicroseconds(frameUS))")
                    }
                    if let confidence = point.confidence {
                        parts.append("confidence \(formatRatio(confidence))")
                    }
                    if let source = point.source, !source.isEmpty {
                        parts.append(source)
                    }
                    return parts.joined(separator: " ")
                }.joined(separator: ", ")
                lines.append("  Segment interest points: \(labels)")
            }
            if let peak = segment.peakAnalysis {
                var parts: [String] = []
                if let selectedPeakUS = peak.selectedPeakUS {
                    parts.append(formatMicroseconds(selectedPeakUS))
                }
                if let confidence = peak.confidence {
                    parts.append("confidence \(formatRatio(confidence))")
                }
                if let fusedPeakScore = peak.supportSignals?.fusedPeakScore {
                    parts.append("fused peak \(formatRatio(fusedPeakScore))")
                }
                if let precisionMode = peak.provenance?.precisionMode, !precisionMode.isEmpty {
                    parts.append(precisionMode)
                }
                if !parts.isEmpty {
                    lines.append("  Segment peak: \(parts.joined(separator: ", "))")
                }
            }
        }
        if !evidence.transcriptItems.isEmpty {
            let transcript = evidence.transcriptItems
                .prefix(4)
                .map(\.text)
                .joined(separator: " ")
            lines.append("  Transcript overlap: \(limit(transcript, count: 360))")
        }
        if !evidence.marlinEvents.isEmpty {
            let labels = evidence.marlinEvents.prefix(5).map(\.description).joined(separator: ", ")
            lines.append("  Marlin temporal cues: \(labels)")
        }
        if !evidence.marlinFindResults.isEmpty {
            let labels = evidence.marlinFindResults.prefix(4).map { result in
                var parts = [result.query]
                if let startUS = result.spanStartUS, let endUS = result.spanEndUS {
                    parts.append("@\(formatMicroseconds(startUS))-\(formatMicroseconds(endUS))")
                }
                if let confidence = result.confidence {
                    parts.append("confidence \(formatRatio(confidence))")
                }
                if let raw = result.raw, !raw.isEmpty {
                    parts.append(limit(raw, count: 120))
                }
                return parts.joined(separator: " ")
            }.joined(separator: ", ")
            lines.append("  Marlin find hits: \(labels)")
        }
        if !evidence.audioEvents.isEmpty {
            let labels = evidence.audioEvents.prefix(5).map { $0.label ?? $0.type }.joined(separator: ", ")
            lines.append("  Audio cues: \(labels)")
        }
        if !evidence.audioStoryNodes.isEmpty {
            let labels = evidence.audioStoryNodes.prefix(5).map { node in
                var parts = [node.type]
                if let storyRole = node.storyRole, !storyRole.isEmpty {
                    parts.append(storyRole)
                }
                if let text = node.text, !text.isEmpty {
                    parts.append(limit(text, count: 120))
                }
                return parts.joined(separator: ": ")
            }.joined(separator: ", ")
            lines.append("  Audio story cues: \(labels)")
        }
        if !evidence.bgmSections.isEmpty {
            let labels = evidence.bgmSections.prefix(4).map { section in
                "\(section.label) \(formatSeconds(section.startSec))-\(formatSeconds(section.endSec)) energy \(formatRatio(section.energy))"
            }.joined(separator: ", ")
            lines.append("  BGM sections: \(labels)")
        }
    }

    private static func appendQAIssues(
        _ issues: [QAIssueItem],
        timeline: TimelineDocument,
        to lines: inout [String]
    ) {
        guard !issues.isEmpty else { return }
        lines.append("  QA issues:")
        for issue in issues.prefix(3) {
            let timecode = timeline.sequence.framesToTimecode(
                Int((issue.timestamp_sec * timeline.sequence.fps).rounded())
            )
            let fixableLabel = issue.fixable == true ? "fixable" : (issue.fixable == false ? "not fixable" : "unknown fixability")
            var summary = "    - \(issue.issue_id) [\(issue.type), severity \(String(format: "%.2f", issue.severity)), \(fixableLabel), \(timecode)]: \(limit(issue.description, count: 220))"
            if let suggestedFixType = issue.suggested_fix_type, !suggestedFixType.isEmpty {
                summary += " Suggested fix: \(suggestedFixType)."
            }
            if let searchQuery = issue.search_query, !searchQuery.isEmpty {
                summary += " Search: \(limit(searchQuery, count: 120))."
            }
            if let nonFixableReason = issue.non_fixable_reason, !nonFixableReason.isEmpty {
                summary += " Reason: \(limit(nonFixableReason, count: 120))."
            }
            lines.append(summary)
        }
    }

    private static func formatMicroseconds(_ value: Int) -> String {
        String(format: "%.3fs", Double(value) / 1_000_000)
    }

    private static func formatSeconds(_ value: Double) -> String {
        String(format: "%.3fs", value)
    }

    private static func formatRatio(_ value: Double) -> String {
        String(format: "%.2f", value)
    }

    private static func limit(_ value: String, count: Int) -> String {
        if value.count <= count { return value }
        return String(value.prefix(count - 3)) + "..."
    }
}
