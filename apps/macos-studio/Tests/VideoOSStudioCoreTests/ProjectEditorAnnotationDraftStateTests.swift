import XCTest
@testable import VideoOSStudioCore

final class ProjectEditorAnnotationDraftStateTests: XCTestCase {
    func testNoSelectionCannotSaveDraft() {
        let state = ProjectEditorAnnotationDraftState.evaluate(
            hasSelectedClip: false,
            noteDraft: "AI note",
            handoffInstructionDraft: "Review before applying",
            savedNote: nil,
            savedHandoffInstruction: nil
        )

        XCTAssertFalse(state.hasSelectedClip)
        XCTAssertFalse(state.canSave)
        XCTAssertFalse(state.hasChanges)
        XCTAssertEqual(state.statusLabel, "タイムラインのクリップを選択すると編集メモを作成できます。")
    }

    func testUnchangedSavedDraftDisablesSave() {
        let state = ProjectEditorAnnotationDraftState.evaluate(
            hasSelectedClip: true,
            noteDraft: "Saved note",
            handoffInstructionDraft: "Saved handoff",
            savedNote: "Saved note",
            savedHandoffInstruction: "Saved handoff"
        )

        XCTAssertTrue(state.hasSavedNote)
        XCTAssertFalse(state.hasChanges)
        XCTAssertFalse(state.canSave)
        XCTAssertEqual(state.statusLabel, "保存済みメモと一致しています。")
    }

    func testReadOnlyAgentPreviewDraftCallsOutPreviewAndAllowsSave() {
        let state = ProjectEditorAnnotationDraftState.evaluate(
            hasSelectedClip: true,
            noteDraft: """
            Existing note

            ---

            AI相談メモ (読み取り専用/PREVIEW)
            The cut can hold two more frames.
            """,
            handoffInstructionDraft: "AI提案はPREVIEWです。timelineへ適用する前に編集者が確認してください。",
            savedNote: "Existing note",
            savedHandoffInstruction: ""
        )

        XCTAssertTrue(state.hasChanges)
        XCTAssertTrue(state.canSave)
        XCTAssertTrue(state.includesReadOnlyAgentPreview)
        XCTAssertEqual(state.statusLabel, "AI相談メモを下書きに追加済みです。保存前で、timelineには適用していません。")
    }

    func testHandoffOnlyChangeCanSaveWhenNoteRemainsNonEmpty() {
        let state = ProjectEditorAnnotationDraftState.evaluate(
            hasSelectedClip: true,
            noteDraft: "Saved note",
            handoffInstructionDraft: "New handoff",
            savedNote: "Saved note",
            savedHandoffInstruction: "Saved handoff"
        )

        XCTAssertTrue(state.hasChanges)
        XCTAssertTrue(state.canSave)
        XCTAssertEqual(state.statusLabel, "保存済みメモから変更があります。保存すると editor_annotations.json を更新します。")
    }

    func testEmptyNoteCannotSaveEvenWhenSavedNoteExists() {
        let state = ProjectEditorAnnotationDraftState.evaluate(
            hasSelectedClip: true,
            noteDraft: "  ",
            handoffInstructionDraft: "Handoff",
            savedNote: "Saved note",
            savedHandoffInstruction: "Saved handoff"
        )

        XCTAssertTrue(state.hasChanges)
        XCTAssertFalse(state.canSave)
        XCTAssertEqual(state.statusLabel, "メモ本文が空です。保存すると現在のメモは上書きできません。")
    }
}
