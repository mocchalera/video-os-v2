import Foundation

public struct ProjectEditorAnnotationProposal: Codable, Equatable, Sendable {
    public let clipID: String
    public let note: String
    public let handoffInstruction: String

    enum CodingKeys: String, CodingKey {
        case clipID = "clip_id"
        case note
        case handoffInstruction = "handoff_instruction"
    }

    public static func extract(from text: String, expectedClipID: String) -> ProjectEditorAnnotationProposal? {
        candidateJSONStrings(from: text).compactMap { candidate -> ProjectEditorAnnotationProposal? in
            guard let data = candidate.data(using: .utf8),
                  let proposal = try? JSONDecoder().decode(ProjectEditorAnnotationProposal.self, from: data),
                  proposal.clipID == expectedClipID,
                  !proposal.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !proposal.handoffInstruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return nil
            }
            return proposal
        }.first
    }

    private static func candidateJSONStrings(from text: String) -> [String] {
        var candidates: [String] = []
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{"), trimmed.hasSuffix("}") {
            candidates.append(trimmed)
        }

        let parts = text.components(separatedBy: "```")
        for index in parts.indices where index % 2 == 1 {
            var fenced = parts[index].trimmingCharacters(in: .whitespacesAndNewlines)
            if fenced.lowercased().hasPrefix("json") {
                fenced = String(fenced.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if fenced.hasPrefix("{"), fenced.hasSuffix("}") {
                candidates.append(fenced)
            }
        }

        if let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end {
            candidates.append(String(text[start...end]))
        }
        return candidates
    }
}

public enum ProjectEditorAnnotationProposalPrompt {
    public static func make(
        project: ProjectSummary,
        selection: TimelineClipSelection,
        timeline: TimelineDocument,
        evidence: ClipEvidence?,
        existingNote: ProjectEditorClipNote?
    ) -> String {
        let clip = selection.clip
        var lines = [
            "You are helping a professional video editor prepare a handoff annotation for one selected timeline clip.",
            "",
            "Do not modify files. Return exactly one JSON object and no markdown.",
            "Required JSON shape:",
            #"{"clip_id":"...","note":"...","handoff_instruction":"..."}"#,
            "",
            "Project: \(project.id)",
            "Clip: \(clip.id)",
            "Track: \(selection.trackID) / \(selection.trackKind.rawValue)",
            "Timeline: \(timeline.sequence.framesToTimecode(clip.timelineInFrame))-\(timeline.sequence.framesToTimecode(clip.timelineOutFrame))",
            "Asset: \(clip.assetID)",
            "Segment: \(clip.segmentID)",
            "Role: \(clip.role)",
            "Motivation: \(clip.motivation)"
        ]

        if let beatID = clip.beatID {
            lines.append("Beat: \(beatID)")
        }
        if !clip.qualityFlags.isEmpty {
            lines.append("Quality flags: \(clip.qualityFlags.joined(separator: ", "))")
        }
        if let existingNote {
            lines.append("Existing note: \(existingNote.note)")
            lines.append("Existing handoff instruction: \(existingNote.handoffInstruction)")
        }
        if let evidence {
            appendEvidence(evidence, to: &lines)
        }

        lines.append("")
        lines.append("Write the note as a concise editorial observation. Write the handoff_instruction as a direct, actionable instruction for the human editor. Keep both under 180 characters.")
        return lines.joined(separator: "\n")
    }

    private static func appendEvidence(_ evidence: ClipEvidence, to lines: inout [String]) {
        if let asset = evidence.asset {
            lines.append("Asset file: \(asset.filename)")
            if let role = asset.roleGuess {
                lines.append("Asset role guess: \(role)")
            }
            if !asset.tags.isEmpty {
                lines.append("Asset tags: \(asset.tags.prefix(6).joined(separator: ", "))")
            }
        }
        if let segment = evidence.segment {
            if !segment.summary.isEmpty {
                lines.append("Segment summary: \(segment.summary)")
            }
            if !segment.transcriptExcerpt.isEmpty {
                lines.append("Transcript excerpt: \(limit(segment.transcriptExcerpt, count: 360))")
            }
            if !segment.tags.isEmpty {
                lines.append("Segment tags: \(segment.tags.prefix(8).joined(separator: ", "))")
            }
        }
        if !evidence.transcriptItems.isEmpty {
            let transcript = evidence.transcriptItems
                .prefix(4)
                .map(\.text)
                .joined(separator: " ")
            lines.append("Transcript overlap: \(limit(transcript, count: 360))")
        }
        if !evidence.marlinEvents.isEmpty {
            let labels = evidence.marlinEvents.prefix(5).map(\.description).joined(separator: ", ")
            lines.append("Marlin temporal cues: \(labels)")
        }
        if !evidence.audioEvents.isEmpty {
            let labels = evidence.audioEvents.prefix(5).map { $0.label ?? $0.type }.joined(separator: ", ")
            lines.append("Audio cues: \(labels)")
        }
    }

    private static func limit(_ value: String, count: Int) -> String {
        if value.count <= count { return value }
        return String(value.prefix(count - 3)) + "..."
    }
}
