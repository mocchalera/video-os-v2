import XCTest
@testable import VideoOSStudioCore

final class TimelineAgentReviewPatchDraftTests: XCTestCase {
    func testExtractsFencedReviewPatchJSON() throws {
        let text = """
        PREVIEW only.

        ```review_patch
        {
          "timeline_version": "1",
          "operations": [
            {
              "op": "trim_segment",
              "target_clip_id": "clip-001",
              "new_src_in_us": 1000000,
              "new_src_out_us": 2400000,
              "reason": "Tighten the pause."
            }
          ]
        }
        ```
        """

        let draft = try XCTUnwrap(TimelineAgentReviewPatchDraft.extract(
            from: text,
            expectedTimelineVersion: "1",
            selectedClipIDs: ["clip-001"]
        ))

        XCTAssertEqual(draft.operationCount, 1)
        XCTAssertEqual(draft.compilerReadyCount, 1)
        XCTAssertTrue(draft.warnings.isEmpty)
        XCTAssertEqual(draft.operationSummaries.first?.operationName, "trim_segment")
        XCTAssertEqual(draft.operationSummaries.first?.targetLabel, "clip-001")
        XCTAssertEqual(draft.operationSummaries.first?.impactLabel, "source 1.000s-2.400s")
    }

    func testExtractsWrappedReviewPatchJSON() throws {
        let text = """
        {
          "review_patch": {
            "timeline_version": "7",
            "operations": [
              {
                "op": "set_transition",
                "from_clip_id": "clip-001",
                "to_clip_id": "clip-002",
                "track_id": "V1",
                "transition_type": "crossfade",
                "transition_frames": 12,
                "reason": "Soften the cut."
              }
            ]
          }
        }
        """

        let draft = try XCTUnwrap(TimelineAgentReviewPatchDraft.extract(
            from: text,
            expectedTimelineVersion: "7",
            selectedClipIDs: ["clip-001", "clip-002"]
        ))

        XCTAssertEqual(draft.operationCount, 1)
        XCTAssertEqual(draft.compilerReadyCount, 1)
        XCTAssertEqual(draft.operationSummaries.first?.targetLabel, "V1:clip-001->clip-002")
        XCTAssertEqual(draft.operationSummaries.first?.impactLabel, "V1 crossfade / 12f")
    }

    func testReportsVersionAndSelectionWarnings() throws {
        let text = """
        ```json
        {
          "timeline_version": "1",
          "operations": [
            {
              "op": "move_segment",
              "target_clip_id": "clip-outside",
              "new_timeline_in_frame": 120,
              "reason": "Move the beat later."
            }
          ]
        }
        ```
        """

        let draft = try XCTUnwrap(TimelineAgentReviewPatchDraft.extract(
            from: text,
            expectedTimelineVersion: "2",
            selectedClipIDs: ["clip-001"]
        ))

        XCTAssertEqual(draft.operationCount, 1)
        XCTAssertEqual(draft.operationSummaries.first?.impactLabel, "frame 120")
        XCTAssertEqual(draft.warnings, [
            "timeline_versionが現在のタイムラインと異なります。",
            "選択範囲外のclipを参照しています: clip-outside",
        ])
    }

    func testRejectsResponsesWithoutStructuredPatch() {
        XCTAssertNil(TimelineAgentReviewPatchDraft.extract(
            from: "Trim clip-001 by two frames, PREVIEW only.",
            expectedTimelineVersion: "1",
            selectedClipIDs: ["clip-001"]
        ))
    }

    func testStudioOnlyOperationsWarnWhenNoCompilerReadyOperationExists() throws {
        let text = """
        {
          "timeline_version": "1",
          "operations": [
            {
              "op": "add_note",
              "target_clip_id": "clip-001",
              "label": "Looks good after the cut."
            }
          ]
        }
        """

        let draft = try XCTUnwrap(TimelineAgentReviewPatchDraft.extract(
            from: text,
            expectedTimelineVersion: "1",
            selectedClipIDs: ["clip-001"]
        ))

        XCTAssertEqual(draft.operationCount, 1)
        XCTAssertEqual(draft.studioReadyCount, 1)
        XCTAssertEqual(draft.compilerReadyCount, 0)
        XCTAssertTrue(draft.warnings.contains("timeline.jsonへ保存できる編集操作がありません。"))
    }
}
