import Foundation

public struct ProjectEditorAnnotationDraftState: Equatable, Sendable {
    public let hasSelectedClip: Bool
    public let hasSavedNote: Bool
    public let hasChanges: Bool
    public let canSave: Bool
    public let includesReadOnlyAgentPreview: Bool
    public let statusLabel: String

    public static func evaluate(
        hasSelectedClip: Bool,
        noteDraft: String,
        handoffInstructionDraft: String,
        savedNote: String?,
        savedHandoffInstruction: String?
    ) -> ProjectEditorAnnotationDraftState {
        guard hasSelectedClip else {
            return ProjectEditorAnnotationDraftState(
                hasSelectedClip: false,
                hasSavedNote: false,
                hasChanges: false,
                canSave: false,
                includesReadOnlyAgentPreview: false,
                statusLabel: "タイムラインのクリップを選択すると編集メモを作成できます。"
            )
        }

        let note = normalized(noteDraft)
        let handoff = normalized(handoffInstructionDraft)
        let savedNoteValue = normalized(savedNote ?? "")
        let savedHandoffValue = normalized(savedHandoffInstruction ?? "")
        let hasSavedNote = !savedNoteValue.isEmpty
        let hasChanges = note != savedNoteValue || handoff != savedHandoffValue
        let canSave = !note.isEmpty && hasChanges
        let includesPreview = note.contains("AI相談メモ (読み取り専用/PREVIEW)")
            || handoff.contains("AI提案はPREVIEWです。")

        let status: String
        if note.isEmpty {
            status = hasSavedNote
                ? "メモ本文が空です。保存すると現在のメモは上書きできません。"
                : "メモ下書きは空です。"
        } else if !hasChanges {
            status = "保存済みメモと一致しています。"
        } else if includesPreview {
            status = "AI相談メモを下書きに追加済みです。保存前で、timelineには適用していません。"
        } else if hasSavedNote {
            status = "保存済みメモから変更があります。保存すると editor_annotations.json を更新します。"
        } else {
            status = "新しいメモ下書きがあります。保存すると editor_annotations.json に書き込みます。"
        }

        return ProjectEditorAnnotationDraftState(
            hasSelectedClip: true,
            hasSavedNote: hasSavedNote,
            hasChanges: hasChanges,
            canSave: canSave,
            includesReadOnlyAgentPreview: includesPreview,
            statusLabel: status
        )
    }

    private static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
