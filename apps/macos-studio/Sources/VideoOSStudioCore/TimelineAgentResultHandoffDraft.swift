import Foundation

public struct TimelineAgentResultHandoffDraft: Equatable, Sendable {
    public let noteDraft: String
    public let handoffInstructionDraft: String

    public static func make(
        clipID: String,
        sourceLabel: String,
        assistantText: String,
        existingNoteDraft: String = "",
        existingHandoffInstructionDraft: String = "",
        excerptLimit: Int = 700
    ) -> TimelineAgentResultHandoffDraft? {
        let trimmedText = assistantText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty else { return nil }

        let excerpt = limit(trimmedText, count: max(80, excerptLimit))
        let firstLine = limit(
            trimmedText
                .components(separatedBy: .newlines)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first { !$0.isEmpty } ?? excerpt,
            count: 220
        )

        let noteAddition = [
            "AI相談メモ (読み取り専用/PREVIEW)",
            "対象クリップ: \(clipID)",
            "参照ターン: \(sourceLabel)",
            "",
            excerpt
        ].joined(separator: "\n")

        let handoffAddition = [
            "AI提案はPREVIEWです。timelineへ適用する前に編集者が確認してください。",
            "参照: \(firstLine)"
        ].joined(separator: "\n")

        return TimelineAgentResultHandoffDraft(
            noteDraft: append(noteAddition, to: existingNoteDraft),
            handoffInstructionDraft: append(handoffAddition, to: existingHandoffInstructionDraft)
        )
    }

    private static func append(_ addition: String, to existing: String) -> String {
        let trimmedExisting = existing.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedExisting.isEmpty else { return addition }
        return [trimmedExisting, "---", addition].joined(separator: "\n\n")
    }

    private static func limit(_ value: String, count: Int) -> String {
        guard value.count > count else { return value }
        return String(value.prefix(max(0, count - 3))) + "..."
    }
}
