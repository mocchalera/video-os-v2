import XCTest
@testable import VideoOSStudioCore

final class TimelineAgentResultHandoffDraftTests: XCTestCase {
    func testDraftMarksAgentResultAsPreviewOnly() throws {
        let draft = try XCTUnwrap(TimelineAgentResultHandoffDraft.make(
            clipID: "clip-001",
            sourceLabel: "カットを説明",
            assistantText: "The cut works, but hold the outgoing clip for four more frames before the reaction."
        ))

        XCTAssertTrue(draft.noteDraft.contains("AI相談メモ (読み取り専用/PREVIEW)"))
        XCTAssertTrue(draft.noteDraft.contains("対象クリップ: clip-001"))
        XCTAssertTrue(draft.noteDraft.contains("参照ターン: カットを説明"))
        XCTAssertTrue(draft.handoffInstructionDraft.contains("AI提案はPREVIEWです。timelineへ適用する前に編集者が確認してください。"))
    }

    func testDraftAppendsToExistingNotesWithoutOverwriting() throws {
        let draft = try XCTUnwrap(TimelineAgentResultHandoffDraft.make(
            clipID: "clip-002",
            sourceLabel: "短く整える",
            assistantText: "Trim the middle pause and keep the last breath.",
            existingNoteDraft: "Existing note",
            existingHandoffInstructionDraft: "Existing handoff"
        ))

        XCTAssertTrue(draft.noteDraft.hasPrefix("Existing note\n\n---\n\nAI相談メモ"))
        XCTAssertTrue(draft.handoffInstructionDraft.hasPrefix("Existing handoff\n\n---\n\nAI提案はPREVIEW"))
    }

    func testDraftTruncatesLongAssistantText() throws {
        let longText = String(repeating: "A", count: 500)
        let draft = try XCTUnwrap(TimelineAgentResultHandoffDraft.make(
            clipID: "clip-003",
            sourceLabel: "代替を探す",
            assistantText: longText,
            excerptLimit: 120
        ))

        XCTAssertTrue(draft.noteDraft.contains(String(repeating: "A", count: 117) + "..."))
        XCTAssertFalse(draft.noteDraft.contains(String(repeating: "A", count: 160)))
        XCTAssertTrue(draft.handoffInstructionDraft.contains(String(repeating: "A", count: 217) + "..."))
    }

    func testDraftRejectsEmptyAssistantText() {
        XCTAssertNil(TimelineAgentResultHandoffDraft.make(
            clipID: "clip-004",
            sourceLabel: "カットを説明",
            assistantText: "  \n  "
        ))
    }
}
